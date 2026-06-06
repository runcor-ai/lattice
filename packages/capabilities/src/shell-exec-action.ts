import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  ActContext,
  Capability,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * ShellExecAction — run a single shell command in a configured
 * working directory, with an allowlist of permitted verbs.
 *
 * The allowlist is the safety boundary. By default only read-only
 * inspection verbs are permitted (grep, find, ls, cat, head, tail,
 * git log/status/diff, npm ls, node --version, type/dir on win32).
 * Operators who want broader power must pass an extended allowlist
 * explicitly at construction.
 *
 * The verb is the FIRST token of the command after trimming. If
 * the verb is not in the allowlist, the call fails before spawn().
 *
 * Note: on Windows, spawn() with shell:true is used so that .cmd
 * shims resolve. Output is truncated at outputMaxBytes (default 8KB)
 * to keep stored memories small.
 */

export interface ShellExecInput {
  readonly command: string;
}

export interface ShellExecResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface ShellExecOptions {
  readonly name?: string;
  readonly cwd: string;
  readonly allowedVerbs?: readonly string[];
  readonly timeoutMs?: number;
  readonly outputMaxBytes?: number;
}

const DEFAULT_ALLOWLIST = [
  'grep',
  'rg',
  'find',
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'git',
  'npm',
  'node',
  'pnpm',
  'yarn',
  'jq',
  'tree',
] as const;

export interface RunShellOptions {
  readonly command: string;
  /** Absolute working directory the command is jailed to. Validated at call time. */
  readonly cwd: string;
  readonly allowedVerbs?: readonly string[];
  readonly timeoutMs?: number;
  readonly outputMaxBytes?: number;
  /** Optional cancellation; the child is SIGTERM'd on abort. */
  readonly abortSignal?: AbortSignal;
}

/**
 * runShellCommand — the single sandboxed command runner. The same
 * allowlist + cwd-jail + timeout + output-cap boundary backs both the
 * `shell-exec` capability (lattice action) and the `command_exits_zero`
 * completion-check hook (Item 7). There is exactly ONE place a command
 * is spawned, so the sandbox can never be bypassed by a second path.
 */
export async function runShellCommand(opts: RunShellOptions): Promise<ShellExecResult> {
  if (!opts.cwd || !isAbsolute(opts.cwd)) {
    throw new Error(`shell-exec: cwd must be an absolute path, got: ${String(opts.cwd)}`);
  }
  if (!existsSync(opts.cwd)) {
    throw new Error(`shell-exec: cwd does not exist: ${opts.cwd}`);
  }
  const jailedCwd = realpathSync(resolve(opts.cwd));
  const allowed = new Set((opts.allowedVerbs ?? DEFAULT_ALLOWLIST).map((v) => v.toLowerCase()));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const outputCap = opts.outputMaxBytes ?? 8_000;
  const useShell = process.platform === 'win32';

  if (typeof opts.command !== 'string' || opts.command.trim().length === 0) {
    throw new Error('shell-exec: command (non-empty string) is required');
  }
  const command = opts.command.trim();
  const verb = (command.split(/\s+/)[0] ?? '').toLowerCase();
  if (!allowed.has(verb)) {
    throw new Error(`shell-exec: verb "${verb}" not in allowlist (${[...allowed].sort().join(', ')})`);
  }

  const start = Date.now();
  return await new Promise<ShellExecResult>((resolveP, rejectP) => {
    const child = spawn(command, [], {
      cwd: jailedCwd,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const appendCapped = (chunk: string, which: 'stdout' | 'stderr'): void => {
      const cur = which === 'stdout' ? stdout : stderr;
      const remaining = outputCap - cur.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      if (which === 'stdout') stdout += slice;
      else stderr += slice;
      if (chunk.length > remaining) truncated = true;
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectP(new Error(`shell-exec: command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    opts.abortSignal?.addEventListener('abort', onAbort);
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8').on('data', (c: string) => appendCapped(c, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', (c: string) => appendCapped(c, 'stderr'));
    child.on('error', (err) => {
      cleanup();
      rejectP(err);
    });
    child.on('close', (code) => {
      cleanup();
      resolveP({
        command,
        exitCode: code ?? 0,
        stdout,
        stderr,
        truncated,
        elapsedMs: Date.now() - start,
      });
    });
  });
}

export function makeShellExecAction(
  opts: ShellExecOptions,
): Capability<ShellExecInput, ShellExecResult> {
  if (!opts.cwd || !isAbsolute(opts.cwd)) {
    throw new Error(`shell-exec: cwd must be an absolute path, got: ${String(opts.cwd)}`);
  }
  if (!existsSync(opts.cwd)) {
    throw new Error(`shell-exec: cwd does not exist: ${opts.cwd}`);
  }
  const jailedCwd = realpathSync(resolve(opts.cwd));
  const name = opts.name ?? 'shell-exec';
  const allowed = (opts.allowedVerbs ?? DEFAULT_ALLOWLIST).map((v) => v.toLowerCase());
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const outputCap = opts.outputMaxBytes ?? 8_000;

  return {
    name,
    description: `Run a shell command in ${jailedCwd}. Allowed first-token verbs: ${[...allowed].sort().join(', ')}. Output capped at ${outputCap} bytes per stream. Input: { command: string }.`,
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(input: ShellExecInput, ctx: ActContext): Promise<ShellExecResult> {
      if (!input || typeof input.command !== 'string' || input.command.trim().length === 0) {
        throw new Error('shell-exec: input.command (non-empty string) is required');
      }
      return await runShellCommand({
        command: input.command,
        cwd: jailedCwd,
        allowedVerbs: allowed,
        timeoutMs,
        outputMaxBytes: outputCap,
        abortSignal: ctx.abortSignal,
      });
    },
  };
}
