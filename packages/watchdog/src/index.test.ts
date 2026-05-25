import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { findGaps } from './index.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE capability (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      source_kind TEXT NOT NULL, mcp_server_uri TEXT, api_config_json TEXT,
      role_sense INTEGER NOT NULL, role_action INTEGER NOT NULL,
      added_at_cycle INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, rejected_reason TEXT,
      CHECK (role_sense + role_action >= 1)
    );
    CREATE TABLE goal (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, proposed_at_cycle INTEGER NOT NULL,
      parent_id TEXT, state TEXT NOT NULL, why TEXT NOT NULL
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      description TEXT NOT NULL, state TEXT NOT NULL,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT
    );
    CREATE TABLE trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle INTEGER NOT NULL, at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL, phase TEXT, body TEXT NOT NULL
    );
  `);
  return db;
}

function addCap(db: Database.Database, name: string): void {
  db.prepare(
    `INSERT INTO capability (id, name, source_kind, role_sense, role_action, added_at_cycle, enabled)
     VALUES (?, ?, 'manifest', 0, 1, 0, 1)`,
  ).run(randomUUID(), name);
}

function addGoal(db: Database.Database, body: string): void {
  db.prepare(
    `INSERT INTO goal (id, body, proposed_at_cycle, state, why)
     VALUES (?, ?, 0, 'active', 'test')`,
  ).run(randomUUID(), body);
}

function addAct(db: Database.Database, cycle: number, summary: string): void {
  db.prepare(
    `INSERT INTO trace (cycle, at_ms, kind, phase, body) VALUES (?, 0, 'phase', 'act', ?)`,
  ).run(cycle, JSON.stringify({ output_summary: summary }));
}

describe('findGaps (T215 / T225 / intent §12)', () => {
  it('reports an unused tool that appears in a goal body', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'I need to send-email to the stakeholder weekly.');
    // No act entries for send-email.
    const findings = findGaps({ db, currentCycle: 50 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('tool_unused');
    expect(findings[0]?.summary).toMatch(/send-email/);
  });

  it('does not report when the tool was used in the window', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'I need to send-email.');
    addAct(db, 30, 'action=send-email;result=ok');
    expect(findGaps({ db, currentCycle: 50 })).toHaveLength(0);
  });

  it('does not report when the tool is NOT mentioned anywhere', () => {
    const db = fresh();
    addCap(db, 'unrelated-tool');
    addGoal(db, 'totally different goal');
    expect(findGaps({ db, currentCycle: 50 })).toHaveLength(0);
  });

  it('respects the window — old usage outside the window still triggers', () => {
    const db = fresh();
    addCap(db, 'send-email');
    addGoal(db, 'use send-email please');
    addAct(db, 1, 'action=send-email;result=ok'); // very old
    // Window of 10 cycles: usage was at cycle 1; current cycle 100 → outside window.
    expect(findGaps({ db, currentCycle: 100, windowCycles: 10 })).toHaveLength(1);
  });

  it('returns empty when no capabilities exist', () => {
    const db = fresh();
    addGoal(db, 'some need');
    expect(findGaps({ db, currentCycle: 50 })).toEqual([]);
  });
});
