import { spawn } from 'node:child_process';

import {
  ModelBackendError,
  type CostEstimate,
  type ModelBackend,
  type ModelCallRequest,
  type ModelCallResult,
} from './types.js';

/**
 * ClaudeCodeHostBackend — drives a coding-agent CLI on the
 * operator's machine as a host (intent §14; spec FR-018 + Edge Case
 * "model backend hits usage limit mid-cycle").
 *
 * The lattice runs ON TOP of the host CLI: a person on an ordinary
 * subscription can run the lattice autonomously over long horizons
 * without per-token API billing.
 *
 * Slice 12 abstracts the CLI behind a `CliRunner` interface so:
 *   - production uses `spawnCliRunner()` (Node child_process)
 *   - tests inject a fake (no real CLI required)
 *
 * Detects usage-limit responses and throws ModelBackendError(
 * kind='usage_limit'); the runtime's usage-limit handler turns this
 * into a deferred job item with unblock condition "usage window
 * resets at <ts>" (slice 11 jobs API).
 *
 * Operator responsibility: provider terms-of-service over long
 * horizons (constitution Technology Stack note).
 */

export interface CliInvocation {
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CliRunner {
  run(call: CliInvocation): Promise<CliResult>;
}

export interface ClaudeCodeHostOptions {
  readonly runner: CliRunner;
  readonly name?: string;
}

/* ---------- Usage-limit pattern detection ---------- */

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\busage limit (?:reached|exceeded)\b/i,
  /\brate limit\b.*\busage\b/i,
  /\bsubscription quota\b/i,
  /\bplan limit\b/i,
];

const USAGE_LIMIT_RESET_PATTERN = /resets? at\s+([0-9TZ\-:+ .]+)/i;

export function isUsageLimitError(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
}

export function extractResetTime(text: string): string | undefined {
  const m = USAGE_LIMIT_RESET_PATTERN.exec(text);
  return m ? m[1]?.trim() : undefined;
}

/* ---------- The backend ---------- */

export class ClaudeCodeHostBackend implements ModelBackend {
  readonly name: string;
  private readonly runner: CliRunner;

  constructor(opts: ClaudeCodeHostOptions) {
    this.runner = opts.runner;
    this.name = opts.name ?? 'claude-code-host';
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    const callArg: CliInvocation = {
      prompt: req.prompt,
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
    };
    let result: CliResult;
    try {
      result = await this.runner.run(callArg);
    } catch (err) {
      if (req.abortSignal?.aborted) {
        throw new ModelBackendError('claude-code: aborted', 'aborted');
      }
      throw new ModelBackendError(
        `claude-code: runner error: ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    }

    if (req.abortSignal?.aborted) {
      throw new ModelBackendError('claude-code: aborted', 'aborted');
    }

    // Failure paths
    if (result.exitCode !== 0) {
      const blob = `${result.stdout}\n${result.stderr}`;
      if (isUsageLimitError(blob)) {
        throw new ModelBackendError(
          `claude-code: usage limit reached${extractResetTime(blob) ? ` (resets at ${extractResetTime(blob)})` : ''}`,
          'usage_limit',
        );
      }
      throw new ModelBackendError(
        `claude-code: CLI exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
        'invalid_request',
      );
    }
    // Exit code 0 — but some CLIs emit usage-limit warnings on stderr.
    if (isUsageLimitError(result.stderr)) {
      throw new ModelBackendError(
        `claude-code: usage limit reached${extractResetTime(result.stderr) ? ` (resets at ${extractResetTime(result.stderr)})` : ''}`,
        'usage_limit',
      );
    }

    return {
      text: result.stdout,
      usage: {
        input: Math.ceil(req.prompt.length / 4),
        output: Math.ceil(result.stdout.length / 4),
      },
      modelUsed: this.name,
      finishReason: 'stop',
    };
  }

  estimateCost(req: ModelCallRequest): CostEstimate {
    // Host backend doesn't bill per-token (operator's subscription).
    return {
      unit: 'seconds',
      amount: Math.ceil(req.prompt.length / 1000) + 1,
      confidence: 'low',
    };
  }
}

/* ---------- The real CLI runner ---------- */

export interface SpawnRunnerOptions {
  /** Command to run; defaults to 'claude'. */
  readonly command?: string;
  /** Extra args to pass before the prompt. Default: ['--print']. */
  readonly args?: readonly string[];
  /** Timeout in ms; default 120_000 (2 min). */
  readonly timeoutMs?: number;
}

/**
 * spawnCliRunner — production CLI runner. Pipes the prompt to the
 * CLI's stdin; collects stdout + stderr; respects the abortSignal.
 *
 * Note: not exercised by tests directly (no host CLI on the test
 * host). Tests use the fake runner pattern.
 */
export function spawnCliRunner(opts: SpawnRunnerOptions = {}): CliRunner {
  const command = opts.command ?? 'claude';
  const args = opts.args ?? ['--print'];
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // Windows npm-installed CLIs are .cmd shims; spawn() without a shell
  // cannot resolve them by the bare name. Use shell:true on win32 so
  // cmd.exe handles PATHEXT (.cmd / .bat / .exe).
  const useShell = process.platform === 'win32';
  return {
    run(call: CliInvocation): Promise<CliResult> {
      return new Promise<CliResult>((resolve, reject) => {
        const child = spawn(command, [...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: useShell,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`claude-code: CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const onAbort = () => {
          child.kill('SIGTERM');
        };
        call.abortSignal?.addEventListener('abort', onAbort);

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          call.abortSignal?.removeEventListener('abort', onAbort);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          call.abortSignal?.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });

        child.stdin.end(call.prompt, 'utf8');
      });
    },
  };
}
