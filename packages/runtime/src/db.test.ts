import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, openDb } from './db.js';

describe('openDb — slice 3 (T084)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcor-db-'));
    path = join(dir, 'test.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens with WAL mode and foreign keys ON', () => {
    const db = openDb(path);
    expect((db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode).toBe(
      'wal',
    );
    expect(
      (db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys,
    ).toBe(1);
    closeDb(db);
  });

  it('opens :memory: ephemerally', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (n INT)');
    db.prepare('INSERT INTO t VALUES (?)').run(7);
    const row = db.prepare('SELECT n FROM t').get() as { n: number };
    expect(row.n).toBe(7);
    closeDb(db);
  });
});
