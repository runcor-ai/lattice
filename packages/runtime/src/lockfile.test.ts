import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LockfileError, breakStaleLock, claimLock } from './lockfile.js';

describe('lockfile — slice 3 (FR-010)', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-lock-'));
    lockPath = join(dir, 'entity.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('claims a lock and releases cleanly', () => {
    const lock = claimLock(lockPath);
    expect(lock.path).toBe(lockPath);
    expect(lock.pid).toBe(process.pid);
    lock.release();
    // Re-claim should succeed.
    const lock2 = claimLock(lockPath);
    lock2.release();
  });

  it('refuses to claim a held lock (LockfileError, kind=held)', () => {
    const lock = claimLock(lockPath);
    try {
      let caught: LockfileError | undefined;
      try {
        claimLock(lockPath);
      } catch (err) {
        caught = err as LockfileError;
      }
      expect(caught).toBeInstanceOf(LockfileError);
      expect(caught?.kind).toBe('held');
      expect(caught?.holderPid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('detects a stale lock (PID does not exist) and allows breakStaleLock', () => {
    // Plant a lock with a clearly-dead PID.
    writeFileSync(lockPath, '99999999', 'utf8');
    let caught: LockfileError | undefined;
    try {
      claimLock(lockPath);
    } catch (err) {
      caught = err as LockfileError;
    }
    expect(caught).toBeInstanceOf(LockfileError);
    expect(caught?.kind).toBe('stale');
    expect(caught?.holderPid).toBe(99999999);

    // breakStaleLock claims it
    const lock = breakStaleLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });
});
