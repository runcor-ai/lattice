import { describe, it, expect } from 'vitest';

import { closeDb, openDb } from './db.js';
import { MIGRATIONS, appliedVersions, migrate } from './migrations.js';

describe('migrations — slice 3 (T085)', () => {
  it('applies all migrations on a fresh DB and records each version', () => {
    const db = openDb(':memory:');
    const ran = migrate(db);
    expect(ran.length).toBe(MIGRATIONS.length);
    const applied = appliedVersions(db);
    expect(applied.size).toBe(MIGRATIONS.length);
    for (const m of MIGRATIONS) {
      expect(applied.has(m.version)).toBe(true);
    }
    closeDb(db);
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = openDb(':memory:');
    migrate(db);
    const second = migrate(db);
    expect(second).toEqual([]);
    closeDb(db);
  });

  it('creates the 15 user tables from data-model.md', () => {
    const db = openDb(':memory:');
    migrate(db);
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    // The 15 tables in data-model.md §1..§14 (some migrations create more than one table):
    const expected = [
      'entity',
      'memory_identity',
      'identity_current',
      'plan_job',
      'plan_item',
      'memory_episodic',
      'memory_semantic',
      'memory_semantic_correction',
      'memory_index',
      'skill',
      'skill_attachment',
      'trace',
      'dial',
      'capability',
      'goal',
      'drive_state',
      'commitment',
      'peer_known',
      'snapshot_log',
      'schema_migration',
    ];
    for (const t of expected) {
      expect(names.has(t), `expected table ${t} to exist`).toBe(true);
    }
    closeDb(db);
  });

  it('enforces phase enum on trace.phase', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(`INSERT INTO trace (cycle, at_ms, kind, phase, body) VALUES (1, 1, 'phase', 'badphase', '{}')`)
        .run(),
    ).toThrow(/CHECK/);
    closeDb(db);
  });
});
