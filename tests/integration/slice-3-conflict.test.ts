import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice, LockfileError } from '@runcor/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 3 — concurrent-access prevention (T088 / FR-010 / Edge Case
 * "two processes target same SQLite file").
 */
describe('Slice 3 — lockfile prevents two lattices on the same file (T088)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-conflict-'));
    sqlitePath = join(dir, 'shared.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('second Lattice on the same path fails with LockfileError(held)', () => {
    const a = new Lattice({
      identity: { composed_body: 'first' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });

    let caught: unknown;
    try {
      new Lattice({
        identity: { composed_body: 'second' },
        engine: new StubBackend(),
        senses: [makeEchoSense()],
        actions: [makeNoopAction()],
        sqlite: { path: sqlitePath },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockfileError);
    expect((caught as LockfileError).kind).toBe('held');
    expect((caught as LockfileError).holderPid).toBe(process.pid);

    a.close();

    // After A releases, a new lattice succeeds.
    const c = new Lattice({
      identity: { composed_body: 'third' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    c.close();
  });
});
