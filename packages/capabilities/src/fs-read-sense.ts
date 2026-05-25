import { readdirSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Capability, ObserveContext, PermissionContext, PermissionResult } from './types.js';

/**
 * FsReadSense — path-jailed filesystem-listing sense.
 *
 * Returns a snapshot of files under `root` (recursive, capped). The
 * root is resolved through realpath at construction time so symlinks
 * cannot be used to escape the jail. Every read re-validates that
 * every emitted path resolves under the jailed root.
 *
 * This is a SENSE (role.sense=true, role.action=false, readOnly=true,
 * destructive=false). It performs no writes, no shell execution, no
 * arbitrary file contents — only the directory shape. Reading file
 * contents is a deliberate follow-up capability so the auditable
 * trace shows what was actually loaded.
 */

export interface FsReading {
  readonly root: string;
  readonly readAtMs: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly entries: readonly FsEntry[];
}

export interface FsEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface FsReadSenseOptions {
  readonly name?: string;
  readonly root: string;
  /** Maximum entries emitted per read. Default 200. */
  readonly maxEntries?: number;
  /** Skip directory names matching this set. Default: node_modules, .git, dist, build, .turbo. */
  readonly skipDirs?: readonly string[];
}

const DEFAULT_SKIP = ['node_modules', '.git', 'dist', 'build', '.turbo', '.next', 'coverage'];

export function makeFsReadSense(opts: FsReadSenseOptions): Capability<never, FsReading> {
  if (!opts.root || !isAbsolute(opts.root)) {
    throw new Error(`fs-read: root must be an absolute path, got: ${String(opts.root)}`);
  }
  const jailedRoot = realpathSync(resolve(opts.root));
  const maxEntries = opts.maxEntries ?? 200;
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP);
  const name = opts.name ?? 'fs-read';

  return {
    name,
    description: `Read-only filesystem listing under ${jailedRoot} (jailed; symlinks resolved).`,
    role: { sense: true, action: false },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async read(_ctx: ObserveContext): Promise<FsReading> {
      const entries: FsEntry[] = [];
      let truncated = false;
      const walk = (dir: string): void => {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        let dirents;
        try {
          dirents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of dirents) {
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const full = join(dir, d.name);
          // Re-validate jail on every entry.
          const rel = relative(jailedRoot, full);
          if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
            continue;
          }
          if (d.isDirectory()) {
            if (skipDirs.has(d.name)) continue;
            walk(full);
          } else if (d.isFile()) {
            try {
              const st = statSync(full);
              entries.push({ path: rel.split(sep).join('/'), bytes: st.size });
            } catch {
              /* unreadable — skip */
            }
          }
        }
      };
      walk(jailedRoot);
      return {
        root: jailedRoot,
        readAtMs: Date.now(),
        fileCount: entries.length,
        truncated,
        entries,
      };
    },
  };
}
