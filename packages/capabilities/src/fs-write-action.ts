import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  ActContext,
  Capability,
  PermissionContext,
  PermissionResult,
} from './types.js';

/**
 * FsWriteAction — write a file path-jailed to a configured output
 * directory. The output dir is created if it doesn't exist (at
 * construction). NEVER permits writes outside the jail. Action-only.
 *
 * Modes:
 *   - 'overwrite' (default) — writeFileSync replaces existing
 *   - 'append'              — appendFileSync
 *
 * The lattice's substrate gate sees this capability as
 * `destructive: false` because it cannot affect anything OUTSIDE
 * its sandboxed output dir. From the dir's perspective, overwrite
 * IS destructive — but the dir itself is the lattice's scratch
 * space, so the blast radius is bounded.
 */

export interface FsWriteInput {
  readonly path: string;
  readonly body: string;
  readonly mode?: 'overwrite' | 'append';
}

export interface FsWriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly writtenAtMs: number;
  readonly mode: 'overwrite' | 'append';
}

export interface FsWriteOptions {
  readonly name?: string;
  /** Output directory (created if missing). All writes go under it. */
  readonly outDir: string;
}

export function makeFsWriteAction(opts: FsWriteOptions): Capability<FsWriteInput, FsWriteResult> {
  if (!opts.outDir || !isAbsolute(opts.outDir)) {
    throw new Error(`fs-write: outDir must be an absolute path, got: ${String(opts.outDir)}`);
  }
  if (!existsSync(opts.outDir)) {
    mkdirSync(opts.outDir, { recursive: true });
  }
  const jailedRoot = realpathSync(resolve(opts.outDir));
  const name = opts.name ?? 'fs-write';

  const resolveJailed = (requested: string): string => {
    const abs = isAbsolute(requested) ? requested : join(jailedRoot, requested);
    const norm = resolve(abs);
    const rel = relative(jailedRoot, norm);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
      throw new Error(`fs-write: path escapes jail (${jailedRoot}): ${requested}`);
    }
    return norm;
  };

  return {
    name,
    description: `Write a file under ${jailedRoot} (path-jailed sandbox). Input: { path: string (relative is best), body: string, mode?: "overwrite" | "append" (default overwrite) }.`,
    role: { sense: false, action: true },
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    isEnabled: () => true,
    canInvoke: (_ctx: PermissionContext): PermissionResult => ({ allow: true }),
    async invoke(input: FsWriteInput, _ctx: ActContext): Promise<FsWriteResult> {
      if (!input || typeof input.path !== 'string' || input.path.length === 0) {
        throw new Error('fs-write: input.path (string) is required');
      }
      if (typeof input.body !== 'string') {
        throw new Error('fs-write: input.body (string) is required');
      }
      const full = resolveJailed(input.path);
      const dir = dirname(full);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const mode = input.mode === 'append' ? 'append' : 'overwrite';
      const data = Buffer.from(input.body, 'utf8');
      if (mode === 'append') {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(full, data);
      } else {
        writeFileSync(full, data);
      }
      return {
        path: relative(jailedRoot, full).split(sep).join('/'),
        bytes: data.length,
        writtenAtMs: Date.now(),
        mode,
      };
    },
  };
}
