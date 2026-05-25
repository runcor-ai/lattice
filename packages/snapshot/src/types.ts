/**
 * SnapshotDestination — pluggable durable destination for the
 * lattice's SQLite file (intent §17; constitution Principle II).
 *
 * Each implementation deals with one backend: local folder (default),
 * AWS S3 (v1 follow-up), etc. The lattice's runtime is unaware which
 * destination is configured.
 */

export interface SnapshotKey {
  readonly key: string;
  readonly bytes: number;
  readonly written_at_ms: number;
}

export interface SnapshotPutResult {
  readonly bytes: number;
  readonly destinationUri: string;
}

export interface SnapshotGetResult {
  readonly bytes: number;
}

export interface SnapshotDestination {
  readonly name: string;
  put(srcPath: string, key: string): Promise<SnapshotPutResult>;
  get(key: string, destPath: string): Promise<SnapshotGetResult | null>;
  list(): Promise<SnapshotKey[]>;
  delete(key: string): Promise<void>;
  describe(): string;
}
