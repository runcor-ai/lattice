# Operations

Day-to-day guide for running a Runcor Lattice.

## The mental model

A lattice **is** a SQLite file. Not "is backed by" — *is*. Memory,
identity, plan, skills, cycle counter, dial positions, deferred
items, the trace's indexed store all live in that one file. The
running Node process is disposable; the file is the entity.

This shapes every operations decision below.

## Where data lives

Per-lattice files (one set per lattice):

| File | What |
|---|---|
| `<path>/<id>.sqlite`            | The entity. Everything. |
| `<path>/<id>.sqlite.lock`       | Fast-clock lockfile (one Node process per file) |
| `<path>/<id>.sqlite.slowclock.lock` | Slow-clock lockfile (separate from the fast clock) |
| `<path>/<id>.sqlite-wal`        | WAL journal (created by SQLite) |
| `<path>/<id>.sqlite-shm`        | Shared-memory file (SQLite) |
| `<snapshot-dest>/entity-cycle-<N>.sqlite` | Periodic snapshots (slice 3 onward) |
| `<trace-dir>/<id>.jsonl[.N]`    | Raw JSONL trace (rotating) |

Bridge-managed lattices put `<id>.sqlite` under the Bridge's
`dataDir` (default: `$cwd/data/`).

## Backups

The lattice **is** the SQLite file, so a backup is a file copy.
Three safe approaches:

### Option 1 — Snapshot module (recommended)

If you configured `snapshot.kind = 'local-folder'` at instantiation,
the snapshot module copies the file periodically to that folder
*and on graceful shutdown*. Inspect with:

```sh
ls -lh <snapshot-dir>/entity-cycle-*.sqlite
```

The most recent file is a complete backup.

### Option 2 — Stop, copy, start

Safe but interrupts the lattice. With the lattice cleanly stopped:

```sh
cp my-lattice.sqlite my-lattice.backup.sqlite
```

Resume normally — the cycle counter continues at N+1.

### Option 3 — Live online backup

SQLite supports `.backup` while the database is open. With
`better-sqlite3`:

```js
db.backup('/path/to/backup.sqlite').then(/* done */);
```

This is non-blocking and crash-safe.

## Restoring

If the local `.sqlite` is missing but a snapshot exists at the
configured destination, the runtime restores from snapshot **before**
opening the database. The trace records the restore event so the
operator can see what happened.

Manual restore:

```sh
cp <snapshot-dir>/entity-cycle-7.sqlite my-lattice.sqlite
# Start as normal — cycle resumes at 8.
```

## Migrating snapshot destinations

The snapshot destination is configured per-lattice at instantiation.
To move:

1. Stop the lattice cleanly.
2. Copy `entity-cycle-*.sqlite` from the old folder to the new one.
3. Re-instantiate with the new `snapshot.config.path`. The runtime
   reads from the snapshot only when the local file is missing; the
   move is otherwise transparent.

## Inspecting a hung lattice

If the lattice stops cycling (cycle counter unchanged), inspect in
this order:

1. **Lockfile check.** Is `<path>.sqlite.lock` present? Who owns it?
   ```sh
   cat my-lattice.sqlite.lock      # PID inside
   ps -p <pid>                     # is the process alive?
   ```
   If the PID is dead → stale lock. Either remove the file manually
   or use `breakStaleLock()` from `@runcor/runtime` (the runtime
   does this automatically when it detects the holder is gone).

2. **Trace check.** Read the most recent trace entries — what
   phase was the lattice in?
   ```sh
   sqlite3 my-lattice.sqlite "SELECT cycle, kind, phase, body FROM trace ORDER BY id DESC LIMIT 20"
   ```

3. **Operational log.** If you started via the Bridge, check the
   Bridge's pino output for crashes.

4. **WAL checkpoint.** A very large `.sqlite-wal` (>50MB) can slow
   things; manually checkpoint:
   ```sh
   sqlite3 my-lattice.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
   ```

## Lockfile recovery

If a `.sqlite.lock` file is left behind by a killed process, the
next start will refuse with `LockfileError(kind='held' or
'stale')`:

- `held` — the PID inside is still a running process. **Do not**
  delete the lock; figure out what that process is.
- `stale` — the PID is gone. Safe to delete manually:
  ```sh
  rm my-lattice.sqlite.lock
  ```
  The runtime will create a new one on the next start.

The slow-clock lock at `<path>.sqlite.slowclock.lock` follows the
same rules but is INDEPENDENT — a stale slowclock lock does not
prevent the fast clock from running.

## Reading the trace

Two surfaces:

1. **JSONL on disk** — `<trace-dir>/<id>.jsonl[.N]`. Use any
   JSONL-aware tool.
   ```sh
   jq -r 'select(.kind=="substrate" and .outcome=="block") | "\(.cycle) \(.law) \(.reason)"' trace.jsonl
   ```

2. **SQLite indexed store** — fast queries.
   ```sh
   sqlite3 my-lattice.sqlite \
     "SELECT cycle, kind, phase, body FROM trace WHERE kind='substrate' AND cycle > 100 ORDER BY id LIMIT 50"
   ```

3. **Bridge live stream** — server-sent events at
   `/api/lattices/:id/trace/stream`. Catches up from
   `Last-Event-Id` on reconnect.

## Pause / resume / stop

Via the Bridge:

```http
POST /api/lattices/:id/actions/pause
POST /api/lattices/:id/actions/resume
POST /api/lattices/:id/actions/stop
```

Or directly against the lattice CLI: send SIGINT or SIGTERM.
Graceful-shutdown handler flushes the trace, commits pending
writes, releases the lockfile, exits 0.

## Adjusting dials mid-flight

Via the Bridge:

```http
PATCH /api/lattices/:id/dials
Content-Type: application/json

{
  "dials": { "autonomy": "high" },
  "why": "operator wants self-correct during this experiment"
}
```

Effect lands on the **next** cycle (SC-008 — within 2 cycles). The
`why` is required (FR-015 applied to the dial table).

## Swapping model backends mid-flight

```http
POST /api/lattices/:id/actions/swap-backend
Content-Type: application/json

{
  "model_backend": {
    "kind": "claude-code-host",
    "config": { "command": "claude" }
  }
}
```

Identity, memory, and cycle counter are untouched. The trace
records the swap. The lattice itself is unaware (constitution
Principle XI).

## When a model backend hits a usage limit

The lattice handles this gracefully (slice 12 / analyze C5):

1. The decide call surfaces `ModelBackendError(kind='usage_limit')`.
2. The usage-limit handler writes an operator alert to the trace.
3. If a job item is in progress, it's deferred with unblock
   condition `cycle_after: <future cycle>`.
4. The cycle fails (rolls back) — entity.cycle does NOT advance.
5. Subsequent cycles can still run non-model work (perception,
   trace writes).
6. Operator swaps the backend (or waits for the usage window to
   reset) and the lattice continues.

## Resource monitoring

Watch for:

- **Cycle counter not advancing** — model backend failure or hung
  cycle. Check trace + operational logs.
- **WAL file growing unboundedly** — auto-checkpoint should keep
  this in check. If not, run a manual `PRAGMA wal_checkpoint(TRUNCATE)`.
- **Episodic memory growing unboundedly** — the slow clock's
  consolidation pass forgets weak memories per the decay formula.
  Verify the slow clock is running.

## Stopping a company

Stop each member individually via the Bridge, OR send SIGINT to the
Bridge process — its graceful-shutdown handler stops every managed
lattice in turn.

## Keep two clocks in sync across machines

If you move a lattice's SQLite file to a different machine, MAKE
SURE to also remove the old `.lock` and `.slowclock.lock` files
(they reference PIDs that don't exist on the new host).
