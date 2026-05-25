# Contract: SnapshotDestination

The snapshot module copies the lattice's SQLite file to a configurable
durable destination so the entity survives a machine wipe (intent §17).
Where snapshots go is itself pluggable.

```ts
// packages/snapshot/src/types.ts

export interface SnapshotDestination {
  readonly name: string;        // 'local-folder' | 'aws-s3' | ...
  put(srcPath: string, key: string): Promise<SnapshotPutResult>;
  get(key: string, destPath: string): Promise<SnapshotGetResult | null>;
  list(): Promise<SnapshotKey[]>;
  delete(key: string): Promise<void>;
  describe(): string;            // human-readable for the trace / logs
}

export interface SnapshotPutResult {
  bytes: number;
  destinationUri: string;
}

export interface SnapshotGetResult {
  bytes: number;
}

export interface SnapshotKey {
  key: string;
  bytes: number;
  written_at_ms: number;
}
```

## Implementations

### `LocalFolderDestination` (default)

- Config: `{ kind: 'local-folder', path: '<absolute-path>' }`.
- `put` copies the SQLite file atomically (write to `.tmp` then rename).
- `get` reverse of put.

### `S3Destination` (v1 follow-up)

- Config: `{ kind: 'aws-s3', bucket, prefix, region, credentials }`.
- Uses `@aws-sdk/client-s3` lazily — not bundled into the core
  `snapshot` package; loaded via dynamic import when configured.

## Snapshot timing

The runtime invokes `put()` on these events (configurable):

- Every N cycles (default 100, configurable via a non-dial setting in
  `entity` table).
- On graceful shutdown.
- On slow-clock wake completion.

The runtime takes a **WAL checkpoint** (`PRAGMA wal_checkpoint(TRUNCATE)`)
before invoking `put()` so the snapshot is self-contained.

## Invariants

- The snapshot module MUST be **non-blocking** for the cycle loop: if a
  put fails, the cycle continues and the failure is recorded in
  `snapshot_log` (data-model.md §13) plus operational logs. The trace is
  not polluted with snapshot infra failures — snapshots are operational,
  not cognitive.
- The snapshot module MUST be **idempotent**: same key with same content
  is a no-op (or content-hashed).
- The snapshot module MUST NOT modify the local SQLite file.

## Restore

```ts
export interface SnapshotRestorer {
  /**
   * On startup, if the local file is missing but a recent snapshot
   * exists at the destination, copy it back BEFORE the runtime opens it.
   * Returns the snapshot key used, or null if no restore was needed.
   */
  restoreIfNeeded(localPath: string, dest: SnapshotDestination): Promise<string | null>;
}
```

A successful restore writes a trace entry once the runtime opens the
restored DB.
