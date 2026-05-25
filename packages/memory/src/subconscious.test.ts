import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { Memory } from './memory.js';
import { runSubconsciousSweep } from './subconscious.js';
import { DEPRECATION_MARKER, orphanIndexRowRule } from './sweep-rules.js';

/** Same schema bootstrap as the memory test — keeps this self-contained. */
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_identity (
      id TEXT PRIMARY KEY, written_at_ms INTEGER NOT NULL, cycle INTEGER NOT NULL,
      body TEXT NOT NULL, why TEXT NOT NULL CHECK (length(why) > 0)
    );
    CREATE TABLE identity_current (
      id TEXT PRIMARY KEY CHECK (id = 'self'),
      composed_body TEXT NOT NULL, composed_at_ms INTEGER NOT NULL, composed_at_cycle INTEGER NOT NULL
    );
    CREATE TABLE memory_episodic (
      id TEXT PRIMARY KEY, written_at_ms INTEGER NOT NULL, cycle INTEGER NOT NULL,
      body TEXT NOT NULL, why TEXT NOT NULL CHECK (length(why) > 0),
      reinforcement REAL NOT NULL DEFAULT 1.0, access_count INTEGER NOT NULL DEFAULT 0,
      last_access_ms INTEGER NOT NULL, durability REAL
    );
    CREATE TABLE memory_semantic (
      id TEXT PRIMARY KEY, written_at_ms INTEGER NOT NULL, last_validated_ms INTEGER NOT NULL,
      cycle INTEGER NOT NULL, body TEXT NOT NULL, why TEXT NOT NULL CHECK (length(why) > 0),
      source_kind TEXT NOT NULL, source_ref TEXT
    );
    CREATE TABLE memory_semantic_correction (
      id TEXT PRIMARY KEY,
      semantic_id TEXT NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
      cycle INTEGER NOT NULL, was TEXT NOT NULL, now_is TEXT NOT NULL,
      rule TEXT NOT NULL, at_ms INTEGER NOT NULL
    );
    CREATE TABLE memory_index (
      id TEXT PRIMARY KEY, memory_table TEXT NOT NULL, memory_id TEXT NOT NULL,
      description TEXT NOT NULL, written_at_ms INTEGER NOT NULL,
      UNIQUE (memory_table, memory_id)
    );
  `);
  return db;
}

/* ============================== T143 ============================== */

describe('subconscious sweep — stale_semantic_marker (T143)', () => {
  let db: Database.Database;
  let memory: Memory;

  beforeEach(() => {
    db = freshDb();
    memory = new Memory(db);
  });

  it('detects, fixes, and audits a marker-tagged semantic row', () => {
    // Plant a stale semantic row.
    memory.write(
      'semantic',
      {
        body: `${DEPRECATION_MARKER} old fact about the world`,
        why: 'rule',
        admissionTag: 'guidance',
      },
      { cycle: 1, at_ms: 1_000 },
    );
    const planted = memory.semantic.all()[0]!;

    const result = runSubconsciousSweep(db, { cycle: 2, at_ms: 2_000 });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.rule).toBe('stale_semantic_marker');
    expect(result.applied[0]?.memoryId).toBe(planted.id);
    expect(result.applied[0]?.was).toContain(DEPRECATION_MARKER);
    expect(result.applied[0]?.now_is).not.toContain(DEPRECATION_MARKER);

    // Body actually updated.
    const after = memory.semantic.get(planted.id)!;
    expect(after.body).toBe('old fact about the world');

    // Audit row inserted.
    const audit = db
      .prepare(`SELECT was, now_is, rule, cycle FROM memory_semantic_correction WHERE semantic_id = ?`)
      .all(planted.id) as Array<{ was: string; now_is: string; rule: string; cycle: number }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.rule).toBe('stale_semantic_marker');
    expect(audit[0]?.cycle).toBe(2);
  });
});

/* ============================== T144 ============================== */

describe('subconscious sweep — judgement-required issues are observed, NOT acted (T144 / Principle V)', () => {
  it('hedging semantic row is detected but the sweep does not modify it', () => {
    const db = freshDb();
    const memory = new Memory(db);
    memory.write(
      'semantic',
      { body: 'this might be the right call', why: 'rule', admissionTag: 'guidance' },
      { cycle: 1, at_ms: 1_000 },
    );
    const planted = memory.semantic.all()[0]!;

    const result = runSubconsciousSweep(db, { cycle: 2, at_ms: 2_000 });
    expect(result.applied).toHaveLength(0);
    expect(result.observedOnly).toHaveLength(1);
    expect(result.observedOnly[0]?.rule).toBe('ambiguous_semantic');
    expect(result.observedOnly[0]?.reason).toBe('requires_judgement');

    // The body is unchanged.
    const after = memory.semantic.get(planted.id)!;
    expect(after.body).toBe('this might be the right call');
    // No correction audit row was written.
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction`).get() as {
      n: number;
    };
    expect(audit.n).toBe(0);
  });
});

/* ============================== T145 ============================== */

describe('subconscious sweep — repeated firings are observable in the trace (T145)', () => {
  it('the same rule firing on the same row over multiple cycles is visible', () => {
    const db = freshDb();
    const memory = new Memory(db);
    // Plant a hedging row that the ambiguous rule will keep flagging.
    memory.write(
      'semantic',
      { body: 'this might be true', why: 'rule', admissionTag: 'guidance' },
      { cycle: 1, at_ms: 1_000 },
    );
    const id = memory.semantic.all()[0]!.id;

    const firings: Array<{ rule: string; memoryId: string; cycle: number }> = [];
    for (let cycle = 2; cycle <= 5; cycle += 1) {
      const r = runSubconsciousSweep(db, { cycle, at_ms: 1_000 * cycle });
      for (const o of r.observedOnly) {
        firings.push({ rule: o.rule, memoryId: o.memoryId, cycle });
      }
    }
    expect(firings).toHaveLength(4);
    expect(firings.every((f) => f.rule === 'ambiguous_semantic' && f.memoryId === id)).toBe(
      true,
    );
  });
});

/* ============================== orphan rule ============================== */

describe('subconscious sweep — orphan_index_row rule', () => {
  it('detects an orphan and deletes the index row', () => {
    const db = freshDb();
    // Plant an orphan: an index row pointing at a nonexistent episodic id.
    const indexId = randomUUID();
    const orphanMemId = randomUUID();
    db.prepare(
      `INSERT INTO memory_index (id, memory_table, memory_id, description, written_at_ms)
       VALUES (?, 'episodic', ?, 'orphan', 1000)`,
    ).run(indexId, orphanMemId);

    expect(orphanIndexRowRule.detect(db)).toHaveLength(1);
    const result = runSubconsciousSweep(db, { cycle: 1, at_ms: 1_000 });
    expect(result.applied.some((a) => a.rule === 'orphan_index_row')).toBe(true);

    // Index row gone.
    const left = db.prepare(`SELECT COUNT(*) AS n FROM memory_index WHERE id = ?`).get(indexId) as {
      n: number;
    };
    expect(left.n).toBe(0);
  });
});

/* ============================== integration with Memory ============================== */

describe('subconscious sweep — clean store sees nothing', () => {
  it('no candidates on a freshly-populated store', () => {
    const db = freshDb();
    const memory = new Memory(db);
    memory.write(
      'episodic',
      { body: 'good episode', why: 'auto', admissionTag: 'cycle-outcome' },
      { cycle: 1, at_ms: 1_000 },
    );
    memory.write(
      'semantic',
      { body: 'a clear true statement', why: 'rule', admissionTag: 'guidance' },
      { cycle: 1, at_ms: 1_001 },
    );
    const result = runSubconsciousSweep(db, { cycle: 2, at_ms: 2_000 });
    expect(result.applied).toHaveLength(0);
    expect(result.observedOnly).toHaveLength(0);
  });
});
