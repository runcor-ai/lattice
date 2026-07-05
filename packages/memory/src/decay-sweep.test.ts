import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { DEFAULT_DECAY } from './decay.js';
import { EpisodicStore } from './episodic-store.js';

/**
 * BUG-1 regression: the decay sweep must run, PERSIST durability for every row it examines, and
 * apply forget (M<floor) / promote (M>ceiling) / keep. Prior to the fix the sweep was never called,
 * so durability stayed NULL and nothing was ever forgotten or promoted.
 */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_episodic (
      id TEXT PRIMARY KEY,
      written_at_ms INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      body TEXT NOT NULL,
      why TEXT NOT NULL CHECK (length(why) > 0),
      reinforcement REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_access_ms INTEGER NOT NULL,
      durability REAL
    );`);
  return db;
}

const NOW = 1_000_000_000_000;
const TAU_S = DEFAULT_DECAY.tau; // 604800

function insert(db: Database.Database, id: string, f: number, lastAccessMs: number) {
  db.prepare(
    `INSERT INTO memory_episodic (id, written_at_ms, cycle, body, why, reinforcement, access_count, last_access_ms)
     VALUES (@id, @t, 1, @body, 'because', 1.0, @f, @la)`,
  ).run({ id, t: lastAccessMs, body: `mem ${id}`, f, la: lastAccessMs });
}

describe('EpisodicStore.sweep — BUG-1 (durability persisted; forget/promote/keep)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  beforeEach(() => {
    db = freshDb();
    store = new EpisodicStore(db);
  });

  it('persists durability for surviving rows and applies forget/promote/keep', () => {
    // A: f=0 -> M = 1*ln(1)*e^... = 0 -> below floor 0.05 -> FORGET
    insert(db, 'A', 0, NOW);
    // B: f=5, t=0 -> M = ln(6) ~ 1.79 -> above ceiling 0.6 -> PROMOTE
    insert(db, 'B', 5, NOW);
    // C: f=1, aged so M in keep band. M = ln2 * e^(-t/tau); t chosen so M ~ 0.20
    const keepT = 752_400; // seconds -> M ~ 0.20 (0.05 < M < 0.6)
    insert(db, 'C', 1, NOW - keepT * 1000);

    const promoted: string[] = [];
    const res = store.sweep(NOW, DEFAULT_DECAY, (entry) => promoted.push(entry.id));

    expect(res.examined).toBe(3);
    expect(res.forgotten).toBe(1); // A
    expect(res.promoted).toBe(1); // B
    expect(res.kept).toBe(1); // C
    expect(promoted).toEqual(['B']);

    // A was deleted; B and C remain WITH durability persisted (the core bug: it was always NULL)
    const rows = db
      .prepare(`SELECT id, durability FROM memory_episodic ORDER BY id`)
      .all() as { id: string; durability: number | null }[];
    expect(rows.map((r) => r.id)).toEqual(['B', 'C']);
    for (const r of rows) expect(r.durability).not.toBeNull();

    // C's persisted durability matches the formula (keep band)
    const cM = rows.find((r) => r.id === 'C')!.durability!;
    expect(cM).toBeGreaterThan(0.05);
    expect(cM).toBeLessThan(0.6);
    expect(cM).toBeCloseTo(Math.log(2) * Math.exp(-keepT / TAU_S), 3);
  });

  it('with f=0 everywhere (the observed run state), sweep forgets all and no durability survives', () => {
    insert(db, 'X', 0, NOW);
    insert(db, 'Y', 0, NOW);
    const res = store.sweep(NOW);
    expect(res.forgotten).toBe(2);
    expect(res.promoted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM memory_episodic`).get()).toEqual({ n: 0 });
  });
});
