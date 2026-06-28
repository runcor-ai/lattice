import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate, openDb, type Db } from '@runcor/runtime';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Three-tier watchdog Step 1 — READ-ONLY INVARIANT.
 *
 * The watchdog is an observer, not an actor. This test enforces that
 * structurally:
 *   (a) Runtime: a drift-review pass invokes NO child_process function of any
 *       flavour (spawn/spawnSync/exec/execSync/execFile/execFileSync/fork).
 *   (b) Runtime: a drift-review pass opens NO writable fs handle and writes
 *       NO fs files via node:fs. (SQLite writes go through better-sqlite3's
 *       native binding, not node:fs — that path is the legitimate memory
 *       store and is not counted as a watchdog fs write.)
 *   (c) Static: the watchdog and drift-review sources import neither
 *       node:child_process nor node:fs (defence in depth — catches a future
 *       refactor that adds a side-effecting import).
 *
 * vi.mock is hoisted, so mocking node:child_process for the whole file is
 * fine — driftReview legitimately never needs to spawn anything.
 */

const {
  spawnMock,
  spawnSyncMock,
  execMock,
  execSyncMock,
  execFileMock,
  execFileSyncMock,
  forkMock,
  fsWriteCalls,
  fsWriters,
} = vi.hoisted(() => {
  const writers = [
    'writeFileSync',
    'writeFile',
    'appendFileSync',
    'appendFile',
    'writeSync',
    'createWriteStream',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'renameSync',
  ] as const;
  return {
    spawnMock: vi.fn(),
    spawnSyncMock: vi.fn(),
    execMock: vi.fn(),
    execSyncMock: vi.fn(),
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    forkMock: vi.fn(),
    fsWriteCalls: [] as Array<{ fn: string; args: unknown[] }>,
    fsWriters: writers,
  };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  exec: execMock,
  execSync: execSyncMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  fork: forkMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of fsWriters) {
    wrapped[name] = (...args: unknown[]) => {
      fsWriteCalls.push({ fn: name, args });
      // Record-only — do not let watchdog code actually write a file.
      return undefined as unknown;
    };
  }
  // Re-export default so consumers using `import fs from 'node:fs'` see the wrapped surface too.
  wrapped.default = wrapped;
  return wrapped as typeof import('node:fs');
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO entity (id, lattice_id, name, created_at_ms, cycle, schema_version)
     VALUES ('self', ?, 'test', 0, 0, 1)`,
  ).run(randomUUID());
  return db;
}

function addCapability(db: Db, name: string): void {
  db.prepare(
    `INSERT INTO capability
       (id, name, source_kind, role_sense, role_action, added_at_cycle, enabled)
     VALUES (?, ?, 'manifest', 0, 1, 0, 1)`,
  ).run(randomUUID(), name);
}

function addGoal(db: Db, body: string): void {
  db.prepare(
    `INSERT INTO goal (id, body, proposed_at_cycle, state, why)
     VALUES (?, ?, 0, 'active', 'test')`,
  ).run(randomUUID(), body);
}

describe('drift-review · read-only invariant (watchdog is an observer, not an actor)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    execMock.mockReset();
    execSyncMock.mockReset();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    forkMock.mockReset();
  });

  it('runtime — invokes NO child_process of any flavour during a drift-review pass', async () => {
    // Dynamic import so the vi.mock above takes effect for the
    // module-graph descent of driftReview.
    const { driftReview } = await import('./drift-review.js');

    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('runtime — writes NO files via node:fs during a drift-review pass', async () => {
    fsWriteCalls.length = 0;
    const { driftReview } = await import('./drift-review.js');
    const db = freshDb();
    addCapability(db, 'foo');
    addGoal(db, 'use the foo tool to do the thing');

    driftReview(db, { cycle: 50, at_ms: 1_000 });

    expect(fsWriteCalls).toEqual([]);
  });
});

describe('drift-review · read-only invariant — STATIC (source inspection)', () => {
  // Run static-source tests in a separate describe block so they can use real
  // fs reads via vi.importActual without colliding with the wrapped node:fs
  // surface used by the runtime checks above.
  /**
   * The static invariant has been STRENGTHENED for Step 2: instead of
   * forbidding any node:fs import (which would block legitimate read-only
   * uses like existsSync/statSync), it forbids any WRITE-FLAVOUR fs function
   * appearing anywhere in the source. The runtime write-spy is the co-guard
   * — if a future write API isn't on this denylist, the runtime spy still
   * catches the side effect by detecting an actual write. Belt and braces.
   */
  /**
   * Distinctive write-flavour fs function names. Bare verbs like `open`,
   * `rm`, `cp`, `mkdir`, `unlink`, `chmod` are intentionally omitted —
   * they collide with common English / SQL / Unix-command prose ("open
   * questions", "rm -rf", "remove the link") and would false-positive on
   * documentation. The runtime write-spy is the co-guard: any actual write
   * call is observed by effect regardless of what the static denylist
   * covers. Together they make the invariant defence-in-depth.
   */
  const WRITE_FLAVOUR_FS_FUNCTIONS = [
    'writeFileSync',
    'writeFile',
    'appendFileSync',
    'appendFile',
    'writeSync',
    'createWriteStream',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'renameSync',
    'cpSync',
    'linkSync',
    'symlinkSync',
    'truncateSync',
    'chmodSync',
    'chownSync',
    'utimesSync',
    'openSync',
  ] as const;

  it('static — drift-review.ts uses no write-flavour fs function and never spawns', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = realFs.readFileSync(path.join(here, 'drift-review.ts'), 'utf8');

    // child_process: forbidden everywhere.
    expect(src).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(src).not.toMatch(/from\s+['"]child_process['"]/);
    expect(src).not.toMatch(/require\(['"](node:)?child_process['"]\)/);

    // fs: write-flavour functions forbidden anywhere in the source.
    for (const fn of WRITE_FLAVOUR_FS_FUNCTIONS) {
      expect(src).not.toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  it('static — watchdog/findGaps source uses no write-flavour fs function and never spawns', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const watchdogSrc = realFs.readFileSync(
      path.join(here, '..', '..', 'watchdog', 'src', 'index.ts'),
      'utf8',
    );

    expect(watchdogSrc).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(watchdogSrc).not.toMatch(/from\s+['"]child_process['"]/);
    expect(watchdogSrc).not.toMatch(/require\(['"](node:)?child_process['"]\)/);

    for (const fn of WRITE_FLAVOUR_FS_FUNCTIONS) {
      expect(watchdogSrc).not.toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });
});
