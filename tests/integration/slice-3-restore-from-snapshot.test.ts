import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice } from '@runcor/runtime';
import { LocalFolderDestination, Snapshotter, restoreIfNeeded } from '@runcor/snapshot';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Slice 3 — restore from snapshot (T090 / FR-009).
 *
 * If the local SQLite is missing but a snapshot exists at the
 * destination, the lattice startup MUST restore from the snapshot
 * before opening; subsequent cycles continue from where the snapshot
 * left off.
 */
describe('Slice 3 — restore from snapshot (T090 / FR-009)', () => {
  let dir: string;
  let sqlitePath: string;
  let snapDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-restore-'));
    sqlitePath = join(dir, 'entity.sqlite');
    snapDir = join(dir, 'snapshots');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores the most-recent snapshot when local file is missing', async () => {
    // A: run 7 cycles, snapshot, close.
    const a = new Lattice({
      identity: { composed_body: 'restore test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'restore-test',
    });
    await a.runN(7);
    const dest = new LocalFolderDestination({ path: snapDir });
    const snapshotter = new Snapshotter(a.dbHandle(), sqlitePath, dest);
    const put = await snapshotter.snapshot(a.completedCycle);
    expect(put.result).toBe('ok');
    a.close();

    // Simulate a machine wipe: delete the local file (also kill any
    // WAL sidecar files better-sqlite3 left around).
    if (existsSync(sqlitePath)) unlinkSync(sqlitePath);
    if (existsSync(`${sqlitePath}-wal`)) unlinkSync(`${sqlitePath}-wal`);
    if (existsSync(`${sqlitePath}-shm`)) unlinkSync(`${sqlitePath}-shm`);

    // restoreIfNeeded pulls the snapshot back in.
    const restored = await restoreIfNeeded(sqlitePath, dest);
    expect(restored).toMatch(/^entity-cycle-7\.sqlite$/);
    expect(existsSync(sqlitePath)).toBe(true);

    // Open a fresh lattice on the restored file — must continue at 7+.
    const b = new Lattice({
      identity: { composed_body: 'restore test' },
      engine: new StubBackend(),
      senses: [makeEchoSense()],
      actions: [makeNoopAction()],
      sqlite: { path: sqlitePath },
      name: 'restore-test',
    });
    expect(b.completedCycle).toBe(7);
    await b.runOnce();
    expect(b.completedCycle).toBe(8);
    b.close();
  });

  it('restoreIfNeeded is a no-op when the local file already exists', async () => {
    const dest = new LocalFolderDestination({ path: snapDir });
    const a = new Lattice({
      identity: { composed_body: 'no-restore' },
      engine: new StubBackend(),
      sqlite: { path: sqlitePath },
    });
    a.close();

    const restored = await restoreIfNeeded(sqlitePath, dest);
    expect(restored).toBeNull();
  });

  it('returns null when no snapshots exist', async () => {
    const dest = new LocalFolderDestination({ path: snapDir });
    // Local file missing AND no snapshots in the destination.
    const restored = await restoreIfNeeded(sqlitePath, dest);
    expect(restored).toBeNull();
  });
});
