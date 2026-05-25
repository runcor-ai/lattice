import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SnapshotDestination,
  SnapshotGetResult,
  SnapshotKey,
  SnapshotPutResult,
} from './types.js';

export interface LocalFolderOptions {
  readonly path: string;
}

/**
 * LocalFolderDestination — the default snapshot backend. Copies the
 * SQLite file (atomically: write to .tmp, rename to final) under the
 * configured folder.
 */
export class LocalFolderDestination implements SnapshotDestination {
  readonly name = 'local-folder';
  readonly path: string;

  constructor(opts: LocalFolderOptions) {
    this.path = opts.path;
    if (!existsSync(this.path)) {
      mkdirSync(this.path, { recursive: true });
    }
  }

  async put(srcPath: string, key: string): Promise<SnapshotPutResult> {
    const final = join(this.path, key);
    const tmp = final + '.tmp';
    copyFileSync(srcPath, tmp);
    renameSync(tmp, final);
    const stat = statSync(final);
    return { bytes: stat.size, destinationUri: final };
  }

  async get(key: string, destPath: string): Promise<SnapshotGetResult | null> {
    const src = join(this.path, key);
    if (!existsSync(src)) return null;
    copyFileSync(src, destPath);
    const stat = statSync(destPath);
    return { bytes: stat.size };
  }

  async list(): Promise<SnapshotKey[]> {
    if (!existsSync(this.path)) return [];
    const entries = readdirSync(this.path);
    return entries
      .filter((e) => !e.endsWith('.tmp'))
      .map((e): SnapshotKey => {
        const full = join(this.path, e);
        const stat = statSync(full);
        return { key: e, bytes: stat.size, written_at_ms: stat.mtimeMs };
      })
      .sort((a, b) => a.written_at_ms - b.written_at_ms);
  }

  async delete(key: string): Promise<void> {
    const full = join(this.path, key);
    if (existsSync(full)) {
      unlinkSync(full);
    }
  }

  describe(): string {
    return `local-folder:${this.path}`;
  }
}
