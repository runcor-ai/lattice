import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Lockfile primitive — used for "one fast-clock process per SQLite
 * file" (spec FR-010 + constitution Principle VII) and, in slice 7,
 * for "one slow-clock consolidation pass at a time".
 *
 * Acquisition writes our PID atomically (open(O_CREAT|O_EXCL)); a
 * subsequent acquire from a different process fails fast. On release
 * we delete only if the file still holds our PID — prevents racing a
 * different lattice's release of an old lock.
 */

export class LockfileError extends Error {
  constructor(
    message: string,
    readonly kind: 'held' | 'stale' | 'io',
    readonly holderPid?: number,
  ) {
    super(message);
    this.name = 'LockfileError';
  }
}

export interface Lock {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

export function claimLock(path: string): Lock {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const pid = process.pid;
  try {
    // O_CREAT | O_EXCL — fails if the file exists.
    const fd = openSync(path, 'wx');
    writeSync(fd, String(pid), 0, 'utf8');
    closeSync(fd);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      // Lock already exists. Read holder PID; if the process is dead,
      // declare it stale and let the caller decide what to do.
      let holderPid: number | undefined;
      try {
        const txt = readFileSync(path, 'utf8');
        const n = Number.parseInt(txt.trim(), 10);
        if (Number.isFinite(n)) holderPid = n;
      } catch {
        // Ignore — treat as unknown holder.
      }
      if (holderPid !== undefined && !isAlive(holderPid)) {
        throw new LockfileError(
          `lockfile at ${path} held by dead PID ${holderPid} (stale)`,
          'stale',
          holderPid,
        );
      }
      throw new LockfileError(
        `lockfile at ${path} held by PID ${holderPid ?? 'unknown'}`,
        'held',
        holderPid,
      );
    }
    throw new LockfileError(`I/O error acquiring lockfile at ${path}: ${e.message}`, 'io');
  }

  return {
    path,
    pid,
    release: () => releaseIfOurs(path, pid),
  };
}

/**
 * Try to claim a stale lock atomically. Caller has determined the
 * holder is dead via a prior failed claim. This is non-blocking and
 * still uses exclusive create after unlinking.
 */
export function breakStaleLock(path: string): Lock {
  try {
    unlinkSync(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new LockfileError(
        `failed to break stale lock at ${path}: ${e.message}`,
        'io',
      );
    }
  }
  return claimLock(path);
}

function releaseIfOurs(path: string, ourPid: number): void {
  try {
    const txt = readFileSync(path, 'utf8');
    const n = Number.parseInt(txt.trim(), 10);
    if (n === ourPid) {
      unlinkSync(path);
    }
  } catch {
    // best-effort
  }
}

function isAlive(pid: number): boolean {
  try {
    // process.kill(pid, 0) is a no-op signal that throws ESRCH if
    // the process doesn't exist.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true; // exists but we lack permission
    return false;
  }
}
