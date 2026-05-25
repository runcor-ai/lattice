import { describe, it, expect } from 'vitest';

import {
  ClaudeCodeHostBackend,
  extractResetTime,
  isUsageLimitError,
  type CliRunner,
} from './claude-code-host-backend.js';
import { ModelBackendError, type RppPrompt } from './types.js';

const prompt = 'TARGET { output: "x" }\n' as RppPrompt;

function fake(impl: CliRunner['run']): CliRunner {
  return { run: impl };
}

/* ============================== T229 ============================== */

describe('ClaudeCodeHostBackend — round-trip (T229)', () => {
  it('returns the CLI stdout as text on exit code 0', async () => {
    const runner = fake(async () => ({
      stdout: 'TARGET { output: "ok" }',
      stderr: '',
      exitCode: 0,
    }));
    const backend = new ClaudeCodeHostBackend({ runner });
    const r = await backend.call({ prompt });
    expect(r.text).toBe('TARGET { output: "ok" }');
    expect(r.modelUsed).toBe('claude-code-host');
    expect(r.finishReason).toBe('stop');
  });

  it('passes prompt + maxTokens through to the runner', async () => {
    let captured: { prompt: string; maxTokens?: number } | null = null;
    const runner = fake(async (call) => {
      captured = { prompt: call.prompt, maxTokens: call.maxTokens };
      return { stdout: 'TARGET { output: "x" }', stderr: '', exitCode: 0 };
    });
    const backend = new ClaudeCodeHostBackend({ runner });
    await backend.call({ prompt, maxTokens: 512 });
    expect(captured).toEqual({ prompt: prompt, maxTokens: 512 });
  });
});

/* ============================== Usage-limit detection ============================== */

describe('Usage limit detection', () => {
  it('isUsageLimitError matches common patterns', () => {
    expect(isUsageLimitError('Error: usage limit reached')).toBe(true);
    expect(isUsageLimitError('Plan limit exceeded for the day')).toBe(true);
    expect(isUsageLimitError('rate limit on your usage')).toBe(true);
    expect(isUsageLimitError('subscription quota exhausted')).toBe(true);
    expect(isUsageLimitError('something else entirely')).toBe(false);
  });

  it('extractResetTime pulls a reset timestamp', () => {
    expect(extractResetTime('usage limit reached, resets at 2026-05-25T18:00:00Z')).toBe(
      '2026-05-25T18:00:00Z',
    );
  });

  it('throws ModelBackendError(usage_limit) on a usage-limit CLI failure', async () => {
    const runner = fake(async () => ({
      stdout: '',
      stderr: 'Error: usage limit reached, resets at 2026-05-25T18:00:00Z',
      exitCode: 1,
    }));
    const backend = new ClaudeCodeHostBackend({ runner });
    let caught: unknown;
    try {
      await backend.call({ prompt });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelBackendError);
    expect((caught as ModelBackendError).kind).toBe('usage_limit');
    expect((caught as ModelBackendError).message).toContain('2026-05-25T18:00:00Z');
  });

  it('throws ModelBackendError(usage_limit) even on exit code 0 when stderr signals the limit', async () => {
    const runner = fake(async () => ({
      stdout: '',
      stderr: 'warning: usage limit reached',
      exitCode: 0,
    }));
    const backend = new ClaudeCodeHostBackend({ runner });
    await expect(backend.call({ prompt })).rejects.toThrow(/usage limit/);
  });

  it('throws ModelBackendError(invalid_request) on other non-zero exits', async () => {
    const runner = fake(async () => ({
      stdout: '',
      stderr: 'bad input',
      exitCode: 2,
    }));
    const backend = new ClaudeCodeHostBackend({ runner });
    let caught: unknown;
    try {
      await backend.call({ prompt });
    } catch (err) {
      caught = err;
    }
    expect((caught as ModelBackendError).kind).toBe('invalid_request');
  });

  it('honours abortSignal', async () => {
    const runner = fake(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const backend = new ClaudeCodeHostBackend({ runner });
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown;
    try {
      await backend.call({ prompt, abortSignal: ctrl.signal });
    } catch (err) {
      caught = err;
    }
    expect((caught as ModelBackendError).kind).toBe('aborted');
  });
});

/* ============================== Cost ============================== */

describe('estimateCost', () => {
  it('reports seconds-unit for the host backend (operator subscription)', () => {
    const backend = new ClaudeCodeHostBackend({
      runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    });
    const c = backend.estimateCost({ prompt });
    expect(c.unit).toBe('seconds');
    expect(c.amount).toBeGreaterThan(0);
  });
});
