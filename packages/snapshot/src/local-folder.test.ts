import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LocalFolderDestination } from './local-folder.js';

describe('LocalFolderDestination — slice 3 (T086)', () => {
  let dir: string;
  let destDir: string;
  let srcPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-snap-'));
    destDir = join(dir, 'snapshots');
    srcPath = join(dir, 'source.sqlite');
    writeFileSync(srcPath, 'pretend-this-is-sqlite-bytes', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('put → list → get round-trips byte-for-byte', async () => {
    const dest = new LocalFolderDestination({ path: destDir });
    const put = await dest.put(srcPath, 'cycle-5.sqlite');
    expect(put.bytes).toBeGreaterThan(0);

    const all = await dest.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.key).toBe('cycle-5.sqlite');

    const back = join(dir, 'restored.sqlite');
    const got = await dest.get('cycle-5.sqlite', back);
    expect(got).not.toBeNull();
    expect(readFileSync(back, 'utf8')).toEqual(readFileSync(srcPath, 'utf8'));
  });

  it('get returns null when key missing', async () => {
    const dest = new LocalFolderDestination({ path: destDir });
    const got = await dest.get('no-such-key', join(dir, 'x'));
    expect(got).toBeNull();
  });

  it('delete removes a key', async () => {
    const dest = new LocalFolderDestination({ path: destDir });
    await dest.put(srcPath, 'a.sqlite');
    await dest.delete('a.sqlite');
    const all = await dest.list();
    expect(all).toHaveLength(0);
  });

  it('list ignores .tmp files', async () => {
    const dest = new LocalFolderDestination({ path: destDir });
    writeFileSync(join(destDir, 'in-flight.tmp'), 'partial', 'utf8');
    await dest.put(srcPath, 'final.sqlite');
    const all = await dest.list();
    expect(all.map((k) => k.key)).toEqual(['final.sqlite']);
  });
});
