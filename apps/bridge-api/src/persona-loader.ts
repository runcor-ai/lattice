import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PersonaBundleRegistry } from '@runcor/identity';

/**
 * Load persona bundles (Item 11) from `<prebuiltDir>/_personas/*.md`.
 * Filename (without .md) is the bundle name; file contents are the body.
 * (The `_` prefix keeps the BundleLoader, which scans prebuilt/ for ROLE
 * bundles, from mistaking this for one — same convention as `_meta`.)
 * Missing directory → an empty registry (legacy single-document personas
 * keep working). Editing a file changes the bundle for every lattice that
 * references it on the next instantiation.
 */
export function loadPersonaRegistry(prebuiltDir: string): PersonaBundleRegistry {
  const reg = new PersonaBundleRegistry();
  const dir = join(prebuiltDir, '_personas');
  if (!existsSync(dir)) return reg;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      reg.register(file.replace(/\.md$/, ''), readFileSync(join(dir, file), 'utf8'));
    } catch {
      /* skip unreadable bundle file */
    }
  }
  return reg;
}
