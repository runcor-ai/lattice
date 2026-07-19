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
 * ClaudeDelegateAction — delegate a focused subtask to a fresh
 * coding-agent subprocess. The lattice provides the brain (planning,
 * memory, judgement); the subprocess's built-in tools (Read, Write,
 * Bash) do the actual file work in its own isolated context.
 *
 * Each call spawns `claude --print` with the subtask as stdin. The
 * subprocess's cwd is restricted to a configured workdir, so even
 * if it gets confused it can only touch files there. The subtask
 * prompt should be focused — one well-scoped chunk of work, not a
 * vague mega-goal.
 *
 * Result includes the CC subprocess's full stdout (capped). The
 * lattice stores this in episodic memory and uses it on the next
 * cycle's recall.
 */

export interface ClaudeDelegateInput {
  readonly subtask: string;
  /** Optional: override workdir. Must resolve under the configured root. */
  readonly workdir?: string;
}

export interface ClaudeDelegateResult {
  readonly subtask: string;
  readonly workdir: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface ClaudeDelegateOptions {
  readonly name?: string;
  /** Default workdir for delegated tasks; may be overridden per-invocation but stays under this root. */
  readonly workdir: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly outputMaxBytes?: number;
}

export function makeClaudeDelegateAction(
  opts: ClaudeDelegateOptions,
): Capability<ClaudeDelegateInput, ClaudeDelegateResult> {
  if (!opts.workdir || !isAbsolute(opts.workdir)) {
    throw new Error(
      `claude-delegate: workdir must be an absolute path, got: ${String(opts.workdir)}`,
    );
  }
  if (!existsSync(opts.workdir)) {
    throw new Error(`claude-delegate: workdir does not exist: ${opts.workdir}`);
  }
  const jailedRoot = realpathSync(resolve(opts.workdir));
  const name = opts.name ?? 'claude-delegate';
  const command = opts.command ?? 'claude';
  const args = opts.args ?? ['--print'];
  const timeoutMs = opts.timeoutMs ?? 600_000; // 10 min — CC subtasks can be long
  const outputCap = opts.outputMaxBytes ?? 32_000;
  const useShell = process.platform === 'win32';

  return {
    name,
    description: `Delegate a focused subtask to a fresh coding-agent subprocess (workdir: ${jailedRoot}). Use this for work that needs file editing or multi-step reasoning. Input: { subtask: string, workdir?: string (must stay under ${jailedRoot}) }.`,
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(input: ClaudeDelegateInput, ctx: ActContext): Promise<ClaudeDelegateResult> {
      if (!input || typeof input.subtask !== 'string' || input.subtask.trim().length === 0) {
        throw new Error('claude-delegate: input.subtask (non-empty string) is required');
      }
      let chosenWorkdir = jailedRoot;
      if (typeof input.workdir === 'string' && input.workdir.length > 0) {
        const requested = isAbsolute(input.workdir) ? input.workdir : resolve(jailedRoot, input.workdir);
        const norm = realpathSync(requested);
        // jail check
        const rel = norm.slice(jailedRoot.length);
        if (!norm.startsWith(jailedRoot) || (rel.length > 0 && !rel.startsWith('\\') && !rel.startsWith('/'))) {
          throw new Error(`claude-delegate: workdir escapes jail (${jailedRoot}): ${input.workdir}`);
        }
        chosenWorkdir = norm;
      }

      const start = Date.now();
      return await new Promise<ClaudeDelegateResult>((resolveP, rejectP) => {
        // FIX-005: detached spawn on non-Windows creates a process group
        // led by the child. Combined with process.kill(-pid, sig) in
        // killGroup() below, this lets us signal grandchildren too — e.g.
        // MCP servers or shell subprocesses the CLI spawns with stdio
        // inheritance. Without a group kill, SIGTERM to the direct child
        // orphaned grandchildren (adopted by init) that still held the
        // pipe write-ends, keeping the parent's 'close' event pending
        // indefinitely (run-11 c22: 40-min hang after child exited).
        // Windows uses job objects for process-tree management; the
        // default child.kill() is acceptable there.
        const isWin = process.platform === 'win32';
        const child = spawn(command, [...args], {
          cwd: chosenWorkdir,
          shell: useShell,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(isWin ? {} : { detached: true }),
        });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let settled = false;
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

        // FIX-005: signal the whole process group on non-Windows. Falls
        // back to direct child.kill() if the group is already gone or if
        // we're on Windows.
        const killGroup = (sig: NodeJS.Signals): void => {
          if (child.pid === undefined) return;
          if (isWin) {
            try { child.kill(sig); } catch { /* already gone */ }
            return;
          }
          try {
            process.kill(-child.pid, sig);
          } catch {
            try { child.kill(sig); } catch { /* nothing more to do */ }
          }
        };

        // FIX-005: on timeout, group-SIGTERM first, then SIGKILL after a
        // grace period. This is the last-resort fallback; the happy path
        // now settles via child.on('exit') long before this fires.
        const timer = setTimeout(() => {
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 2000).unref();
          if (!settled) {
            settled = true;
            rejectP(new Error(`claude-delegate: subtask timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);

        const onAbort = (): void => {
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 2000).unref();
        };
        ctx.abortSignal.addEventListener('abort', onAbort);

        child.stdout.setEncoding('utf8').on('data', (c: string) => appendCapped(c, 'stdout'));
        child.stderr.setEncoding('utf8').on('data', (c: string) => appendCapped(c, 'stderr'));
        child.on('error', (err) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            rejectP(err);
          }
        });

        // FIX-005: resolve on 'exit', not 'close'. 'close' waits for all
        // stdio pipes to close, but grandchildren that inherit the pipes
        // can hold them open long after the child itself has exited —
        // which was the run-11 c22 40-min hang. 'exit' fires the moment
        // the child process exits, which is the completion signal we
        // actually want. We ALSO destroy the parent-side stdout/stderr
        // streams so any orphaned pipe fds are released on our side.
        child.on('exit', (code) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (!settled) {
            settled = true;
            resolveP({
              subtask: input.subtask,
              workdir: chosenWorkdir,
              exitCode: code ?? 0,
              stdout,
              stderr,
              truncated,
              elapsedMs: Date.now() - start,
            });
          }
        });

        // FIX-005: 'close' kept as a defensive fallback in case 'exit'
        // doesn't fire for some reason (rare, e.g. some signal-death
        // paths). Settle-first-wins: no-op if 'exit' already resolved.
        child.on('close', (code) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            resolveP({
              subtask: input.subtask,
              workdir: chosenWorkdir,
              exitCode: code ?? 0,
              stdout,
              stderr,
              truncated,
              elapsedMs: Date.now() - start,
            });
          }
        });

        child.stdin.end(input.subtask, 'utf8');
      });
    },
  };
}
