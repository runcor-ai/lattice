import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, it, expect } from 'vitest';

import { makeFsDigestSense } from './fs-digest-sense.js';
import type { ObserveContext } from './types.js';

const ctx = {} as ObserveContext;
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'fsdigest-'));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('makeFsDigestSense — priority + recency surfacing', () => {
  it('surfaces priorityFiles FIRST with a generous slice', async () => {
    const root = fixture();
    writeFileSync(join(root, 'baseline.md'), '# BASELINE\n' + 'B'.repeat(2000));
    writeFileSync(join(root, 'other.md'), '# OTHER\n' + 'O'.repeat(2000));
    const sense = makeFsDigestSense({ root, totalBytes: 4000, priorityFiles: ['baseline.md'] });
    const r = await sense.read(ctx);
    // baseline header appears before other, and gets far more bytes than the round-robin share
    expect(r.digest.indexOf('baseline.md')).toBeLessThan(r.digest.indexOf('other.md'));
    expect((r.digest.match(/B/g) || []).length).toBeGreaterThan(1000);
  });

  it('maxFiles keeps only the most-recent N of the non-priority rest', async () => {
    const root = fixture();
    writeFileSync(join(root, 'baseline.md'), '# BASELINE\nx');
    mkdirSync(join(root, 'forecast'));
    // three cycles, ascending mtime: c3 newest
    for (const [f, t] of [['c1.md', 1000], ['c2.md', 2000], ['c3.md', 3000]] as const) {
      const p = join(root, 'forecast', f);
      writeFileSync(p, `# ${f}\nbody`);
      utimesSync(p, new Date(t * 1000), new Date(t * 1000));
    }
    const sense = makeFsDigestSense({
      root,
      totalBytes: 4000,
      priorityFiles: ['baseline.md'],
      maxFiles: 1,
    });
    const r = await sense.read(ctx);
    expect(r.digest).toContain('baseline.md'); // priority always present
    expect(r.digest).toContain('forecast/c3.md'); // newest of the rest kept
    expect(r.digest).not.toContain('forecast/c1.md'); // older dropped by maxFiles
    expect(r.digest).not.toContain('forecast/c2.md');
  });

  it('skipDirs are ADDED to defaults (jobs/ excluded, baseline kept)', async () => {
    const root = fixture();
    writeFileSync(join(root, 'baseline.md'), '# BASELINE\nx');
    mkdirSync(join(root, 'jobs'));
    writeFileSync(join(root, 'jobs', 'noise.md'), '# NOISE\nplan churn');
    const sense = makeFsDigestSense({ root, totalBytes: 4000, skipDirs: ['jobs'] });
    const r = await sense.read(ctx);
    expect(r.digest).toContain('baseline.md');
    expect(r.digest).not.toContain('noise.md');
  });
});
