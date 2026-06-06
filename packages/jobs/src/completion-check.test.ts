import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { builtinRegistry, runDeterministicHooks } from './completion-check.js';
import type { CompletionCheckSpec, Item } from './types.js';

/**
 * Item 7 — the lattice-authored completion-check hook vocabulary:
 * content_contains (cheap), command_exits_zero + http_status_is (costly,
 * tiered out of the auto sweep).
 */

const registry = builtinRegistry();

function fakeItem(description = 'x'): Item {
  return {
    id: 'i', job_id: 'j', ordinal: 0, description, state: 'open', iteration_count: 0,
    completion_check: '{}', passed_at_cycle: null, deferred_at_cycle: null,
    defer_reason: null, unblock_condition: null, unblock_test: null, source: 'operator', blocked_by: null,
  };
}

function run(spec: CompletionCheckSpec, mode: 'lattice' | 'auto' = 'lattice') {
  return runDeterministicHooks(spec, registry, { item: fakeItem(), cycle: 1, mode });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runcor-hooks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('content_contains', () => {
  it('passes when the file contains the needle', async () => {
    const p = join(dir, 'plan.md');
    writeFileSync(p, '# Plan\n- [ ] write the thing\n');
    const out = await run({ hooks: [{ name: 'content_contains', args: { path: p, needle: '- [ ]' } }] });
    expect(out.result).toBe('passed');
  });

  it('fails when the needle is absent', async () => {
    const p = join(dir, 'plan.md');
    writeFileSync(p, 'no checkboxes here');
    const out = await run({ hooks: [{ name: 'content_contains', args: { path: p, needle: '- [ ]' } }] });
    expect(out.result).toBe('failed');
  });

  it('supports regex matching', async () => {
    const p = join(dir, 'plan.md');
    writeFileSync(p, 'intro\n- [x] done item\n');
    const out = await run({
      hooks: [{ name: 'content_contains', args: { path: p, needle: '^- \\[[ x]\\]', isRegex: true } }],
    });
    expect(out.result).toBe('passed');
  });

  it('fails cleanly when the file is missing', async () => {
    const out = await run({ hooks: [{ name: 'content_contains', args: { path: join(dir, 'nope.md'), needle: 'x' } }] });
    expect(out.result).toBe('failed');
  });
});

describe('command_exits_zero (costly, sandboxed)', () => {
  it('passes when the command exits 0', async () => {
    const out = await run({ hooks: [{ name: 'command_exits_zero', args: { command: 'node --version', cwd: dir } }] });
    expect(out.result).toBe('passed');
  });

  it('fails when the command exits non-zero', async () => {
    writeFileSync(join(dir, 'fail.js'), 'process.exit(2)');
    const out = await run({ hooks: [{ name: 'command_exits_zero', args: { command: 'node fail.js', cwd: dir } }] });
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.reason).toContain('exited 2');
  });

  it('rejects a verb outside the sandbox allowlist', async () => {
    const out = await run({ hooks: [{ name: 'command_exits_zero', args: { command: 'rm -rf /', cwd: dir } }] });
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.reason).toContain('allowlist');
  });

  it('is DEFERRED (not run) in auto-sweep mode', async () => {
    const out = await run(
      { hooks: [{ name: 'command_exits_zero', args: { command: 'node --version', cwd: dir } }] },
      'auto',
    );
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.reason).toContain('deferred to explicit close');
  });
});

describe('http_status_is (costly)', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === '/teapot' ? 418 : 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('passes when the status matches (default 200)', async () => {
    const out = await run({ hooks: [{ name: 'http_status_is', args: { url: `${base}/ok` } }] });
    expect(out.result).toBe('passed');
  });

  it('fails when the status differs', async () => {
    const out = await run({ hooks: [{ name: 'http_status_is', args: { url: `${base}/teapot`, status: 200 } }] });
    expect(out.result).toBe('failed');
  });

  it('matches an explicit non-200 status', async () => {
    const out = await run({ hooks: [{ name: 'http_status_is', args: { url: `${base}/teapot`, status: 418 } }] });
    expect(out.result).toBe('passed');
  });

  it('is DEFERRED in auto-sweep mode', async () => {
    const out = await run({ hooks: [{ name: 'http_status_is', args: { url: `${base}/ok` } }] }, 'auto');
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.reason).toContain('deferred to explicit close');
  });
});

describe('builtin registry exposes the Item 7 vocabulary', () => {
  it('has the new hooks, with costly tiering set correctly', () => {
    expect(registry.get('content_contains')?.costly).toBe(false);
    expect(registry.get('command_exits_zero')?.costly).toBe(true);
    expect(registry.get('http_status_is')?.costly).toBe(true);
    expect(registry.get('file_exists')?.costly).toBe(false);
  });
});
