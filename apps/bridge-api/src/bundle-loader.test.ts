import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { BundleLoader } from './bundle-loader.js';

// Resolve the repo's prebuilt/ directory relative to this test file.
const PREBUILT_DIR = join(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  'prebuilt',
);

describe('BundleLoader (T288)', () => {
  it('loads all prebuilt roles from the repo (ceo / cfo / marketing / sales / software-engineer)', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    const out = loader.loadAll();
    expect(out.rejected).toEqual([]);
    const ids = out.admitted.map((b) => b.id).sort();
    expect(ids).toEqual(['ceo', 'cfo', 'marketing', 'sales', 'software-engineer']);
  });

  it('every bundle has a non-empty seedPrompt + defaults + identity rows', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    for (const b of loader.list()) {
      expect(b.seedPrompt.length).toBeGreaterThan(0);
      expect(b.defaults).toBeDefined();
      expect(b.startingKnowledge.identity.length).toBeGreaterThan(0);
    }
  });

  it('ignores _meta directory', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    const ids = loader.list().map((b) => b.id);
    expect(ids.some((i) => i.startsWith('_'))).toBe(false);
  });

  it('get(id) returns a single bundle', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    const ceo = loader.get('ceo');
    expect(ceo).toBeDefined();
    expect(ceo?.defaults.autonomy).toBe('medium');
    expect(ceo?.defaults.dialecticDepth).toBe(1);
  });

  it('CFO defaults to autonomy=low (risk-averse)', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    expect(loader.get('cfo')?.defaults.autonomy).toBe('low');
  });

  it('sales bundle marks itself as a service-role lattice in its seed prompt', () => {
    const loader = new BundleLoader({ root: PREBUILT_DIR });
    const sales = loader.get('sales');
    expect(sales).toBeDefined();
    expect(sales?.seedPrompt.toLowerCase()).toContain('service-role');
  });
});
