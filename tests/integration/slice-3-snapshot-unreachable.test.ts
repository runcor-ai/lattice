import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { Snapshotter, type SnapshotDestination } from '@runcor/snapshot';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 3 — snapshot destination unreachable (T090a / analyze C3).
 *
 * Spec FR-008 + Edge Case "snapshot destination unreachable": the
 * lattice continues cycling; the failure is recorded in `snapshot_log`;
 * the cycle is NOT blocked.
 */
class AlwaysFailingDestination implements SnapshotDestination {
  readonly name = 'always-fail';
  describe(): string {
    return 'always-fail:nowhere';
  }
  async put(): Promise<never> {
    throw new Error('destination unreachable');
  }
  async get(): Promise<null> {
    return null;
  }
  async list(): Promise<[]> {
    return [];
  }
  async delete(): Promise<void> {
    /* no-op */
  }
}

describe('Slice 3 — snapshot destination unreachable (T090a / analyze C3)', () => {
  let dir: string;
  let sqlitePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-snapfail-'));
    sqlitePath = join(dir, 'entity.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cycle continues on snapshot failure; snapshot_log records the failure', async () => {
    const lattice = new Lattice({
      identity: { composed_body: 'snap fail test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
    });
    const snapshotter = new Snapshotter(
      lattice.dbHandle(),
      sqlitePath,
      new AlwaysFailingDestination(),
    );

    // Run a cycle, then attempt snapshot — must not throw.
    await lattice.runOnce();
    const result = await snapshotter.snapshot(lattice.completedCycle);
    expect(result.result).toBe('failed');
    expect(result.error).toMatch(/unreachable/);

    // The lattice should still cycle.
    await lattice.runOnce();
    expect(lattice.completedCycle).toBe(2);

    // snapshot_log must contain the failure row.
    const rows = lattice
      .dbHandle()
      .prepare(`SELECT result, error FROM snapshot_log ORDER BY id`)
      .all() as Array<{ result: string; error: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.result === 'failed' && r.error?.includes('unreachable'))).toBe(
      true,
    );

    lattice.close();
  });
});
