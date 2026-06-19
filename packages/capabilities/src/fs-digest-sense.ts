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
  /** Directory names to skip, ADDED to the built-in defaults (node_modules, .git, …). */
  readonly skipDirs?: readonly string[];
  /**
   * Relative paths (POSIX, relative to root) surfaced FIRST and given a generous
   * per-file slice, before the rest. Use for the few artifacts the entity must
   * always hold in view (e.g. the standing baseline). Missing files are skipped.
   */
  readonly priorityFiles?: readonly string[];
  /**
   * Cap on the number of NON-priority files included, chosen most-recent-first by
   * mtime. Undefined = include all. Use to surface only the recent tail (e.g. the
   * last few forecast cycles) instead of an unbounded directory.
   */
  readonly maxFiles?: number;
}

const DEFAULT_SKIP = ['node_modules', '.git', 'dist', 'build', '.turbo'];

export function makeFsDigestSense(opts: FsDigestSenseOptions): Capability<never, FsDigestReading> {
  if (!opts.root || !isAbsolute(opts.root)) {
    throw new Error(`fs-digest: root must be an absolute path, got: ${String(opts.root)}`);
  }
  const jailedRoot = realpathSync(resolve(opts.root));
  const totalBytes = opts.totalBytes ?? 4000;
  const skipDirs = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const name = opts.name ?? 'fs-digest';
  const priorityRel = (opts.priorityFiles ?? []).map((p) => p.split(/[\\/]/).join('/'));
  const maxFiles = opts.maxFiles;

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

      const relOf = (full: string): string => relative(jailedRoot, full).split(sep).join('/');
      // Partition into priority (surfaced first, in declared order) and the rest.
      const priority = priorityRel
        .map((rel) => files.find((f) => relOf(f) === rel))
        .filter((f): f is string => typeof f === 'string');
      const prioritySet = new Set(priority);
      let rest = files.filter((f) => !prioritySet.has(f));
      // Most-recent first, then cap the tail.
      const mtime = (f: string): number => {
        try {
          return statSync(f).mtimeMs;
        } catch {
          return 0;
        }
      };
      rest.sort((a, b) => mtime(b) - mtime(a));
      if (typeof maxFiles === 'number') rest = rest.slice(0, Math.max(0, maxFiles));

      const read = (full: string, cap: number): string => {
        try {
          return readFileSync(full, 'utf8')
            .replace(/^---[\s\S]*?---\n/, '') // drop YAML frontmatter
            .replace(/\n{3,}/g, '\n\n')
            .slice(0, cap);
        } catch {
          return '';
        }
      };

      let digest = '';
      // Priority files: generous per-file slice (80% of budget, split across them).
      const priorityCap = priority.length
        ? Math.max(400, Math.floor((totalBytes * 0.8) / priority.length))
        : 0;
      for (const full of priority) {
        if (digest.length >= totalBytes) break;
        const cap = Math.min(priorityCap, totalBytes - digest.length);
        digest += `### ${relOf(full)}\n${read(full, cap)}\n\n`;
      }
      // Remaining budget distributed round-robin across the recent rest.
      const remaining = totalBytes - digest.length;
      if (rest.length && remaining > 200) {
        const perFile = Math.max(120, Math.floor((remaining - rest.length * 24) / rest.length));
        for (const full of rest) {
          if (digest.length >= totalBytes) break;
          digest += `### ${relOf(full)}\n${read(full, perFile)}\n\n`;
        }
      }
      return { root: jailedRoot, fileCount: n, digest: digest.slice(0, totalBytes) };
    },
  };
}
