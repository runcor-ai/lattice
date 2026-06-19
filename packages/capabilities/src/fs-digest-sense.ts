import { readdirSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Capability, ObserveContext, PermissionContext, PermissionResult } from './types.js';

/**
 * FsDigestSense — a SENSE that returns a capped, concatenated CONTENT digest of
 * every file under a jailed root, refreshed every cycle. Distinct from FsReadSense
 * (which returns only a directory *listing*): this surfaces the actual content the
 * entity must reason over, so a corpus of N files is integrated in one observe pass
 * instead of N per-file read actions.
 *
 * The total content budget is distributed across files (round-robin per-file cap) so
 * EVERY file is represented — breadth first; the entity can then targeted-read a file
 * for depth. Path-jailed; symlinks resolved at construction.
 */

export interface FsDigestReading {
  readonly root: string;
  readonly fileCount: number;
  readonly digest: string;
}

export interface FsDigestSenseOptions {
  readonly name?: string;
  readonly root: string;
  /** Total content chars to emit, distributed across files. Default 4000. */
  readonly totalBytes?: number;
  readonly skipDirs?: readonly string[];
}

const DEFAULT_SKIP = ['node_modules', '.git', 'dist', 'build', '.turbo'];

export function makeFsDigestSense(opts: FsDigestSenseOptions): Capability<never, FsDigestReading> {
  if (!opts.root || !isAbsolute(opts.root)) {
    throw new Error(`fs-digest: root must be an absolute path, got: ${String(opts.root)}`);
  }
  const jailedRoot = realpathSync(resolve(opts.root));
  const totalBytes = opts.totalBytes ?? 4000;
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP);
  const name = opts.name ?? 'fs-digest';

  const collect = (dir: string, out: string[]): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = join(dir, d.name);
      const rel = relative(jailedRoot, full);
      if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) continue;
      if (d.isDirectory()) {
        if (skipDirs.has(d.name)) continue;
        collect(full, out);
      } else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };

  return {
    name,
    description: `Content digest of every file under ${jailedRoot} (capped ${totalBytes} chars total, refreshed each cycle).`,
    role: { sense: true, action: false },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async read(_ctx: ObserveContext): Promise<FsDigestReading> {
      const files: string[] = [];
      collect(jailedRoot, files);
      const n = files.length;
      if (n === 0) return { root: jailedRoot, fileCount: 0, digest: '(no files yet)' };
      // Distribute the budget across files so every file is represented.
      const perFile = Math.max(120, Math.floor((totalBytes - n * 24) / n));
      let digest = '';
      for (const full of files) {
        if (digest.length >= totalBytes) break;
        const rel = relative(jailedRoot, full).split(sep).join('/');
        let body = '';
        try {
          body = readFileSync(full, 'utf8')
            .replace(/^---[\s\S]*?---\n/, '') // drop YAML frontmatter
            .replace(/\n{3,}/g, '\n\n')
            .slice(0, perFile);
        } catch {
          /* unreadable — skip body */
        }
        digest += `### ${rel}\n${body}\n\n`;
      }
      return { root: jailedRoot, fileCount: n, digest: digest.slice(0, totalBytes) };
    },
  };
}
