import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  ActContext,
  Capability,
  ObserveContext,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * FsReadContentAction — read the contents of one file, path-jailed to
 * a configured root. Symlinks resolved at construction; every read
 * re-validates that the requested path stays inside the jail.
 *
 * Role: sense=true, action=true. As a sense it does nothing on its
 * own (observe-phase reads emit `result: 'stale'`); the real work
 * happens via `invoke({ path, maxBytes })` from the act phase. Files
 * larger than maxBytes are truncated and `truncated: true` is set in
 * the reading so the lattice knows it didn't see the full file.
 */

export interface FsReadContentInput {
  readonly path: string;
  readonly maxBytes?: number;
}

export interface FsReadContentReading {
  readonly path: string;
  readonly readAtMs: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface FsReadContentOptions {
  readonly name?: string;
  readonly root: string;
  /** Default cap on file content bytes returned. Default 16_000. */
  readonly defaultMaxBytes?: number;
  /** Hard ceiling regardless of input. Default 200_000. */
  readonly hardMaxBytes?: number;
}

export function makeFsReadContentAction(
  opts: FsReadContentOptions,
): Capability<FsReadContentInput, FsReadContentReading> {
  if (!opts.root || !isAbsolute(opts.root)) {
    throw new Error(`fs-read-content: root must be an absolute path, got: ${String(opts.root)}`);
  }
  const jailedRoot = realpathSync(resolve(opts.root));
  const defaultMax = opts.defaultMaxBytes ?? 16_000;
  const hardMax = opts.hardMaxBytes ?? 200_000;
  const name = opts.name ?? 'fs-read-content';

  const resolveJailed = (requested: string): string => {
    const abs = isAbsolute(requested) ? requested : join(jailedRoot, requested);
    const norm = resolve(abs);
    const rel = relative(jailedRoot, norm);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
      throw new Error(`fs-read-content: path escapes jail (${jailedRoot}): ${requested}`);
    }
    return norm;
  };

  return {
    name,
    description: `Read the contents of one file under ${jailedRoot} (path-jailed). Input: { path: string, maxBytes?: int (default ${defaultMax}, max ${hardMax}) }.`,
    role: { sense: true, action: true },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async read(_ctx: ObserveContext): Promise<FsReadContentReading> {
      // Sense channel intentionally returns nothing useful — the
      // action channel does the work when the lattice decides to
      // read a specific path.
      return {
        path: '',
        readAtMs: Date.now(),
        bytes: 0,
        truncated: false,
        text: '',
      };
    },
    async invoke(input: FsReadContentInput, _ctx: ActContext): Promise<FsReadContentReading> {
      if (!input || typeof input.path !== 'string' || input.path.length === 0) {
        throw new Error('fs-read-content: input.path (string) is required');
      }
      const cap = Math.min(input.maxBytes ?? defaultMax, hardMax);
      const full = resolveJailed(input.path);
      const st = statSync(full);
      if (!st.isFile()) {
        throw new Error(`fs-read-content: not a regular file: ${input.path}`);
      }
      const buf = readFileSync(full);
      const truncated = buf.length > cap;
      const slice = truncated ? buf.subarray(0, cap) : buf;
      return {
        path: relative(jailedRoot, full).split(sep).join('/'),
        readAtMs: Date.now(),
        bytes: buf.length,
        truncated,
        text: slice.toString('utf8'),
      };
    },
  };
}
