import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { AdmissionRejection, check, isAdmissible } from './admission.js';
import { freshnessCaveat, humanAge } from './age.js';
import { DEFAULT_DECAY, classify, durability } from './decay.js';
import { Memory } from './memory.js';

/**
 * Helper — create a fresh in-memory DB with the lattice schema
 * applied. We reuse the runtime's migrations rather than duplicating
 * the SQL here.
 */
function freshDb() {
  const db = new Database(':memory:');
  // Inline the minimum table set needed by @runcor/memory's stores.
  // The full migration registry lives in @runcor/runtime; we keep
  // this test self-contained so the memory package has zero
  // dependency on runtime (no circular deps).
  db.exec(`
    CREATE TABLE memory_identity (
      id TEXT PRIMARY KEY,
      written_at_ms INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      body TEXT NOT NULL,
      why TEXT NOT NULL CHECK (length(why) > 0)
    );
    CREATE TABLE identity_current (
      id TEXT PRIMARY KEY CHECK (id = 'self'),
      composed_body TEXT NOT NULL,
      composed_at_ms INTEGER NOT NULL,
      composed_at_cycle INTEGER NOT NULL
    );
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
    );
    CREATE TABLE memory_semantic (
      id TEXT PRIMARY KEY,
      written_at_ms INTEGER NOT NULL,
      last_validated_ms INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      body TEXT NOT NULL,
      why TEXT NOT NULL CHECK (length(why) > 0),
      source_kind TEXT NOT NULL,
      source_ref TEXT
    );
    CREATE TABLE memory_semantic_correction (
      id TEXT PRIMARY KEY,
      semantic_id TEXT NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
      cycle INTEGER NOT NULL,
      was TEXT NOT NULL,
      now_is TEXT NOT NULL,
      rule TEXT NOT NULL,
      at_ms INTEGER NOT NULL
    );
    CREATE TABLE memory_index (
      id TEXT PRIMARY KEY,
      memory_table TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      description TEXT NOT NULL,
      written_at_ms INTEGER NOT NULL,
      UNIQUE (memory_table, memory_id)
    );
  `);
  return db;
}

describe('admission rule (T107 / FR-014 / Principle XII)', () => {
  it('rejects empty "why" regardless of tag', () => {
    let caught: AdmissionRejection | undefined;
    try {
      check({ system: 'episodic', body: 'x', why: '', admissionTag: 'cycle-outcome' });
    } catch (e) {
      caught = e as AdmissionRejection;
    }
    expect(caught).toBeInstanceOf(AdmissionRejection);
    expect(caught?.reason).toBe('empty_why');
  });

  it('rejects re-perceivable tags: file-content, tracker-state, code-structure', () => {
    for (const tag of ['file-content', 'tracker-state', 'code-structure'] as const) {
      const result = isAdmissible({
        system: 'episodic',
        body: 'x',
        why: 'because',
        admissionTag: tag,
      });
      expect(result, `tag=${tag} should be rejected`).toBe(false);
    }
  });

  it('accepts decisions, guidance, attribution, cycle-outcome, commitment', () => {
    for (const tag of [
      'decision',
      'guidance',
      'attribution',
      'cycle-outcome',
      'commitment',
    ] as const) {
      const result = isAdmissible({
        system: 'episodic',
        body: 'x',
        why: 'because',
        admissionTag: tag,
      });
      expect(result, `tag=${tag} should be admitted`).toBe(true);
    }
  });

  it('rejects unknown tag unless operatorOverride=true', () => {
    expect(
      isAdmissible({ system: 'episodic', body: 'x', why: 'y', admissionTag: 'unknown' }),
    ).toBe(false);
    expect(
      isAdmissible({
        system: 'episodic',
        body: 'x',
        why: 'y',
        admissionTag: 'unknown',
        operatorOverride: true,
      }),
    ).toBe(true);
  });
});

describe('identity is immune to decay (T108 / FR-012 / Principle IV.1)', () => {
  let db: Database.Database;
  let memory: Memory;
  beforeEach(() => {
    db = freshDb();
    memory = new Memory(db);
  });

  it('identity rows are NEVER classified for forget/promote by the decay sweep', () => {
    memory.write(
      'identity',
      { body: 'I am the test entity.', why: 'seed', admissionTag: 'decision' },
      { cycle: 1, at_ms: 1_000_000 },
    );
    // Sweep would only touch episodic; assert sweep doesn't see identity rows
    const result = memory.episodic.sweep(Date.now());
    expect(result.examined).toBe(0);
    expect(memory.identity.count()).toBe(1);
  });

  it('even with extreme age, identity entries remain', () => {
    memory.write(
      'identity',
      { body: 'I am ancient.', why: 'seed', admissionTag: 'decision' },
      { cycle: 1, at_ms: 0 }, // epoch start
    );
    // No matter how far in the future we sweep, identity must persist
    memory.episodic.sweep(Number.MAX_SAFE_INTEGER);
    expect(memory.identity.count()).toBe(1);
  });
});

describe('episodic decay formula (T109 / FR-013 / Principle IV.3)', () => {
  it('matches the exact formula M = R × ln(f + 1) × e^(-t / (τ × D))', () => {
    // Hand-computed reference value:
    //   R = 2.0, f = 4 (so ln(5) ≈ 1.6094...),
    //   t = 3600 seconds, tau = 7200, D = 2.0
    //   exponent = -3600 / (7200 * 2.0) = -0.25
    //   e^-0.25 ≈ 0.7788007831
    //   M = 2.0 * ln(5) * 0.7788... = 2.0 * 1.6094 * 0.7788 ≈ 2.5072
    const now = 1_000_000_000_000;
    const M = durability(
      { reinforcement: 2.0, access_count: 4, last_access_ms: now - 3_600_000 },
      now,
      { tau: 7200, D: 2.0, forgetBelow: 0.05, promoteAbove: 0.6 },
    );
    const expected = 2.0 * Math.log(5) * Math.exp(-3600 / (7200 * 2.0));
    expect(M).toBeCloseTo(expected, 10);
  });

  it('classifies as forget when M < 0.05', () => {
    // Make a near-zero R so M is tiny.
    const r = classify(
      { reinforcement: 0.001, access_count: 1, last_access_ms: 0 },
      Number.MAX_SAFE_INTEGER,
    );
    expect(r.decision).toBe('forget');
    expect(r.M).toBeLessThan(0.05);
  });

  it('classifies as promote when M > 0.6', () => {
    const now = Date.now();
    // Strong: R=2, accessed 20 times, just-now access (t=0).
    const r = classify(
      { reinforcement: 2.0, access_count: 20, last_access_ms: now },
      now,
      DEFAULT_DECAY,
    );
    expect(r.decision).toBe('promote');
    expect(r.M).toBeGreaterThan(0.6);
  });

  it('classifies as keep in the middle band', () => {
    const now = Date.now();
    // Tune R, f so M lands between forgetBelow (0.05) and promoteAbove (0.6):
    //   R=0.5, f=1 → ln(2) ≈ 0.693; t=60s vs tau=1 week → exp ≈ 1.
    //   M ≈ 0.5 * 0.693 ≈ 0.347 — comfortably in the keep band.
    const r = classify(
      { reinforcement: 0.5, access_count: 1, last_access_ms: now - 60_000 },
      now,
      DEFAULT_DECAY,
    );
    expect(r.M).toBeGreaterThanOrEqual(DEFAULT_DECAY.forgetBelow);
    expect(r.M).toBeLessThanOrEqual(DEFAULT_DECAY.promoteAbove);
    expect(r.decision).toBe('keep');
  });
});

describe('semantic store: source_kind tracked, correction path works (T110)', () => {
  let memory: Memory;
  beforeEach(() => {
    memory = new Memory(freshDb());
  });

  it('writes semantic with source_kind=operator by default', () => {
    memory.write(
      'semantic',
      { body: 'lattices are entities', why: 'rule', admissionTag: 'guidance' },
      { cycle: 1, at_ms: 1 },
    );
    const all = memory.semantic.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.source_kind).toBe('operator');
  });

  it('writes semantic with source_kind=promoted carrying source_ref', () => {
    memory.write(
      'semantic',
      {
        body: 'recurring observation',
        why: 'promoted from episodic',
        admissionTag: 'decision',
        source_kind: 'promoted',
        source_ref: 'episodic-uuid-1',
      },
      { cycle: 1, at_ms: 1 },
    );
    const all = memory.semantic.all();
    expect(all[0]?.source_kind).toBe('promoted');
    expect(all[0]?.source_ref).toBe('episodic-uuid-1');
  });

  it('correct() writes an audit row and updates the body', () => {
    memory.write(
      'semantic',
      { body: 'the old fact', why: 'rule', admissionTag: 'guidance' },
      { cycle: 1, at_ms: 100 },
    );
    const target = memory.semantic.all()[0]!;
    memory.semantic.correct({
      semantic_id: target.id,
      was: 'the old fact',
      now_is: 'the corrected fact',
      rule: 'stale_semantic',
      cycle: 2,
      at_ms: 200,
    });
    const updated = memory.semantic.get(target.id)!;
    expect(updated.body).toBe('the corrected fact');
    expect(updated.last_validated_ms).toBe(200);
  });
});

describe('recall: index-plus-selector (T111 / FR-016)', () => {
  let memory: Memory;
  beforeEach(() => {
    memory = new Memory(freshDb());
  });

  it('returns up to "breadth" memories chosen by the selector', async () => {
    // Plant 50 episodic memories with monotonic timestamps.
    for (let i = 0; i < 50; i += 1) {
      memory.write(
        'episodic',
        {
          body: `episode #${i}`,
          why: 'auto',
          admissionTag: 'cycle-outcome',
        },
        { cycle: i + 1, at_ms: 1_000 + i * 10 },
      );
    }
    const res = await memory.recall({ query: 'anything', breadth: 7, nowMs: 2_000 });
    expect(res.indexSize).toBe(50);
    expect(res.memories).toHaveLength(7);
    // Default selector is recent-first.
    expect(res.memories[0]?.entry.body).toBe('episode #49');
  });

  it('attaches human age and freshness caveat on stale entries', async () => {
    memory.write(
      'episodic',
      { body: 'fresh thing', why: 'auto', admissionTag: 'cycle-outcome' },
      { cycle: 1, at_ms: Date.now() - 1_000 },
    );
    memory.write(
      'episodic',
      { body: 'old thing', why: 'auto', admissionTag: 'cycle-outcome' },
      { cycle: 2, at_ms: Date.now() - 60 * 24 * 60 * 60 * 1_000 }, // 60 days
    );
    const res = await memory.recall({ query: 'q', breadth: 10, nowMs: Date.now() });
    const fresh = res.memories.find((m) => m.entry.body === 'fresh thing')!;
    const old = res.memories.find((m) => m.entry.body === 'old thing')!;
    expect(fresh.freshnessCaveat).toBe('');
    expect(old.freshnessCaveat).toContain('verify before relying on it');
  });

  it('recording access increments access_count on the underlying episodic row', async () => {
    memory.write(
      'episodic',
      { body: 'accessed entry', why: 'auto', admissionTag: 'cycle-outcome' },
      { cycle: 1, at_ms: 1_000 },
    );
    await memory.recall({ query: 'q', breadth: 5, nowMs: 2_000 });
    const after = memory.episodic.all()[0]!;
    expect(after.access_count).toBe(1);
  });
});

describe('human age formatting (T112 / FR-017)', () => {
  const NOW = 1_000_000_000_000;
  it('formats spans appropriately', () => {
    expect(humanAge(NOW, NOW)).toBe('just now');
    expect(humanAge(NOW - 30_000, NOW)).toBe('just now'); // < 1 min
    expect(humanAge(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(humanAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3 hours ago');
    expect(humanAge(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2 days ago');
    expect(humanAge(NOW - 14 * 24 * 60 * 60_000, NOW)).toBe('2 weeks ago');
    expect(humanAge(NOW - 47 * 24 * 60 * 60_000, NOW)).toBe('1 months ago'); // approximate
  });

  it('freshnessCaveat is empty for fresh memories, populated for stale', () => {
    expect(freshnessCaveat(NOW - 1_000, NOW)).toBe('');
    expect(freshnessCaveat(NOW - 47 * 24 * 60 * 60_000, NOW)).toContain('verify');
  });
});

describe('every memory carries a why (T112a / analyze C1 / FR-015)', () => {
  let memory: Memory;
  beforeEach(() => {
    memory = new Memory(freshDb());
  });

  it('write across all four supported systems requires why', () => {
    for (const system of ['identity', 'episodic', 'semantic'] as const) {
      expect(() =>
        memory.write(
          system,
          { body: 'x', why: '', admissionTag: 'decision' },
          { cycle: 1, at_ms: 1 },
        ),
      ).toThrow(/empty "why"/);
    }
  });

  it('successful writes always persist a non-empty why', () => {
    memory.write('identity', { body: 'a', why: 'idA', admissionTag: 'decision' }, { cycle: 1, at_ms: 1 });
    memory.write('episodic', { body: 'b', why: 'epB', admissionTag: 'cycle-outcome' }, { cycle: 1, at_ms: 2 });
    memory.write('semantic', { body: 'c', why: 'sC', admissionTag: 'guidance' }, { cycle: 1, at_ms: 3 });
    expect(memory.identity.all().every((e) => e.why.length > 0)).toBe(true);
    expect(memory.episodic.all().every((e) => e.why.length > 0)).toBe(true);
    expect(memory.semantic.all().every((e) => e.why.length > 0)).toBe(true);
  });
});
