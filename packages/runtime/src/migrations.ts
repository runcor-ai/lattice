/**
 * Schema migrations.
 *
 * Each migration is an ordered `{version, description, sql}` record.
 * `migrate()` applies any pending migrations in a single SQLite
 * transaction per migration, then records the version in
 * `schema_migration`.
 *
 * Slice 3 ships the 15 tables defined in specs/001-lattice-core/
 * data-model.md. Some later slices will add columns or indexes; those
 * become migrations 016+.
 */

import type { Db } from './db.js';

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

export const CYCLE_PHASE_VALUES = "('observe','ground','recall','decide','act','judge','write','pulse')";

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'schema_migration bookkeeping (must be first)',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migration (
        version       INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL,
        description   TEXT    NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'entity (singleton)',
    sql: `
      CREATE TABLE entity (
        id              TEXT    PRIMARY KEY CHECK (id = 'self'),
        lattice_id      TEXT    NOT NULL UNIQUE,
        name            TEXT    NOT NULL,
        created_at_ms   INTEGER NOT NULL,
        cycle           INTEGER NOT NULL DEFAULT 0,
        paused          INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
        schema_version  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    description: 'memory_identity + identity_current',
    sql: `
      CREATE TABLE memory_identity (
        id            TEXT PRIMARY KEY,
        written_at_ms INTEGER NOT NULL,
        cycle         INTEGER NOT NULL,
        body          TEXT NOT NULL,
        why           TEXT NOT NULL CHECK (length(why) > 0)
      );
      CREATE TABLE identity_current (
        id                TEXT PRIMARY KEY CHECK (id = 'self'),
        composed_body     TEXT NOT NULL,
        composed_at_ms    INTEGER NOT NULL,
        composed_at_cycle INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    description: 'plan_job + plan_item',
    sql: `
      CREATE TABLE plan_job (
        id              TEXT PRIMARY KEY,
        opened_at_cycle INTEGER NOT NULL,
        opened_at_ms    INTEGER NOT NULL,
        title           TEXT NOT NULL,
        source          TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('open','closed_full','closed_partial')),
        closed_at_cycle INTEGER,
        closed_at_ms    INTEGER,
        why             TEXT NOT NULL CHECK (length(why) > 0)
      );
      CREATE TABLE plan_item (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL REFERENCES plan_job(id) ON DELETE CASCADE,
        ordinal             INTEGER NOT NULL,
        description         TEXT NOT NULL,
        state               TEXT NOT NULL CHECK (state IN ('open','passed','deferred')),
        iteration_count     INTEGER NOT NULL DEFAULT 0,
        completion_check    TEXT NOT NULL,
        passed_at_cycle     INTEGER,
        deferred_at_cycle   INTEGER,
        defer_reason        TEXT,
        unblock_condition   TEXT,
        unblock_test        TEXT
      );
      CREATE INDEX plan_item_job_state ON plan_item (job_id, state);
      CREATE INDEX plan_item_deferred  ON plan_item (state) WHERE state = 'deferred';
    `,
  },
  {
    version: 5,
    description: 'memory_episodic (carries decay parameters)',
    sql: `
      CREATE TABLE memory_episodic (
        id              TEXT PRIMARY KEY,
        written_at_ms   INTEGER NOT NULL,
        cycle           INTEGER NOT NULL,
        body            TEXT NOT NULL,
        why             TEXT NOT NULL CHECK (length(why) > 0),
        reinforcement   REAL NOT NULL DEFAULT 1.0,
        access_count    INTEGER NOT NULL DEFAULT 0,
        last_access_ms  INTEGER NOT NULL,
        durability      REAL
      );
      CREATE INDEX memory_episodic_cycle ON memory_episodic (cycle);
    `,
  },
  {
    version: 6,
    description: 'memory_semantic + correction audit',
    sql: `
      CREATE TABLE memory_semantic (
        id                TEXT PRIMARY KEY,
        written_at_ms     INTEGER NOT NULL,
        last_validated_ms INTEGER NOT NULL,
        cycle             INTEGER NOT NULL,
        body              TEXT NOT NULL,
        why               TEXT NOT NULL CHECK (length(why) > 0),
        source_kind       TEXT NOT NULL CHECK (source_kind IN ('promoted','derived','operator','collaboration')),
        source_ref        TEXT
      );
      CREATE TABLE memory_semantic_correction (
        id          TEXT PRIMARY KEY,
        semantic_id TEXT NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
        cycle       INTEGER NOT NULL,
        was         TEXT NOT NULL,
        now_is      TEXT NOT NULL,
        rule        TEXT NOT NULL,
        at_ms       INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    description: 'memory_index (recall surface)',
    sql: `
      CREATE TABLE memory_index (
        id            TEXT PRIMARY KEY,
        memory_table  TEXT NOT NULL CHECK (memory_table IN
                        ('identity','plan_job','plan_item','episodic','semantic')),
        memory_id     TEXT NOT NULL,
        description   TEXT NOT NULL,
        written_at_ms INTEGER NOT NULL,
        UNIQUE (memory_table, memory_id)
      );
      CREATE INDEX memory_index_desc ON memory_index (description);
    `,
  },
  {
    version: 8,
    description: 'skill + attachment',
    sql: `
      CREATE TABLE skill (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL,
        body_rpp        TEXT NOT NULL,
        abstraction     TEXT NOT NULL CHECK (abstraction IN ('specific','generic')),
        minted_at_cycle INTEGER NOT NULL,
        source_job_id   TEXT REFERENCES plan_job(id),
        source_item_id  TEXT REFERENCES plan_item(id),
        active          INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
        UNIQUE (name, abstraction)
      );
      CREATE INDEX skill_active_desc ON skill (active, description);
      CREATE TABLE skill_attachment (
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        relpath  TEXT NOT NULL,
        bytes    BLOB NOT NULL,
        PRIMARY KEY (skill_id, relpath)
      );
    `,
  },
  {
    version: 9,
    description: 'trace (indexed store)',
    sql: `
      CREATE TABLE trace (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle  INTEGER NOT NULL,
        at_ms  INTEGER NOT NULL,
        kind   TEXT NOT NULL CHECK (kind IN ('phase','subconscious','job','substrate','operator')),
        phase  TEXT CHECK (phase IS NULL OR phase IN ${CYCLE_PHASE_VALUES}),
        body   TEXT NOT NULL
      );
      CREATE INDEX trace_cycle ON trace (cycle);
      CREATE INDEX trace_kind  ON trace (kind);
      CREATE INDEX trace_phase ON trace (phase) WHERE phase IS NOT NULL;
    `,
  },
  {
    version: 10,
    description: 'dial registry (twelve named dials)',
    sql: `
      CREATE TABLE dial (
        name             TEXT PRIMARY KEY,
        value_json       TEXT NOT NULL,
        schema_id        TEXT NOT NULL,
        updated_at_ms    INTEGER NOT NULL,
        updated_at_cycle INTEGER NOT NULL,
        why              TEXT
      );
    `,
  },
  {
    version: 11,
    description: 'capability (tool manifest)',
    sql: `
      CREATE TABLE capability (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        source_kind     TEXT NOT NULL CHECK (source_kind IN ('manifest','discovered')),
        mcp_server_uri  TEXT,
        api_config_json TEXT,
        role_sense      INTEGER NOT NULL CHECK (role_sense IN (0,1)),
        role_action     INTEGER NOT NULL CHECK (role_action IN (0,1)),
        added_at_cycle  INTEGER NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        rejected_reason TEXT,
        CHECK (role_sense + role_action >= 1)
      );
    `,
  },
  {
    version: 12,
    description: 'goal + drive_state + commitment',
    sql: `
      CREATE TABLE goal (
        id                TEXT PRIMARY KEY,
        body              TEXT NOT NULL,
        proposed_at_cycle INTEGER NOT NULL,
        parent_id         TEXT REFERENCES goal(id),
        state             TEXT NOT NULL CHECK (state IN ('proposed','active','satisfied','abandoned')),
        why               TEXT NOT NULL CHECK (length(why) > 0)
      );
      CREATE TABLE drive_state (
        cycle INTEGER NOT NULL,
        drive TEXT    NOT NULL CHECK (drive IN ('resource_pressure','curiosity','reactivity','coherence')),
        value REAL    NOT NULL,
        PRIMARY KEY (cycle, drive)
      );
      CREATE TABLE commitment (
        id              TEXT PRIMARY KEY,
        description     TEXT NOT NULL,
        deadline_cycle  INTEGER NOT NULL,
        pressure_band   TEXT NOT NULL CHECK (pressure_band IN ('green','yellow','orange','red')),
        job_id          TEXT REFERENCES plan_job(id),
        source          TEXT NOT NULL
      );
    `,
  },
  {
    version: 13,
    description: "peer_known (this lattice's view of peers)",
    sql: `
      CREATE TABLE peer_known (
        id               TEXT PRIMARY KEY,
        essence          TEXT NOT NULL,
        registry_url     TEXT NOT NULL,
        first_seen_cycle INTEGER NOT NULL,
        last_seen_cycle  INTEGER NOT NULL,
        last_seen_ms     INTEGER NOT NULL
      );
    `,
  },
  {
    version: 14,
    description: 'snapshot_log (bookkeeping for the snapshot module)',
    sql: `
      CREATE TABLE snapshot_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        destination     TEXT NOT NULL,
        destination_uri TEXT NOT NULL,
        at_cycle        INTEGER NOT NULL,
        at_ms           INTEGER NOT NULL,
        bytes           INTEGER NOT NULL,
        result          TEXT NOT NULL CHECK (result IN ('ok','failed','skipped')),
        error           TEXT
      );
    `,
  },
  {
    version: 15,
    description: 'plan_item.source — provenance of an item (operator | system | lattice_appended). Items 4 & 8.',
    sql: `
      ALTER TABLE plan_item ADD COLUMN source TEXT NOT NULL DEFAULT 'operator';
    `,
  },
  {
    version: 16,
    description: 'plan_item.blocked_by — ordered chaining; an item cannot pass until its blocker passes. Item 5.',
    sql: `
      ALTER TABLE plan_item ADD COLUMN blocked_by TEXT REFERENCES plan_item(id);
    `,
  },
  {
    version: 17,
    description: 'recent_action — rolling window of dispatched actions for the Persistence substrate law. Item 6.',
    sql: `
      CREATE TABLE recent_action (
        cycle       INTEGER NOT NULL,
        action_name TEXT    NOT NULL,
        input_hash  TEXT    NOT NULL
      );
      CREATE INDEX recent_action_lookup ON recent_action (action_name, input_hash, cycle);
    `,
  },
  {
    version: 18,
    description: 'situation_current — the fast-clock running situation report (singleton). Item 1.',
    sql: `
      CREATE TABLE situation_current (
        id               TEXT PRIMARY KEY CHECK (id = 'self'),
        body             TEXT NOT NULL,
        updated_at_cycle INTEGER NOT NULL,
        updated_at_ms    INTEGER NOT NULL
      );
    `,
  },
  {
    version: 19,
    description: 'plan_job.body — the job-body content surfaced as the per-cycle Layer-3 block. Item 10.',
    sql: `
      ALTER TABLE plan_job ADD COLUMN body TEXT NOT NULL DEFAULT '';
    `,
  },
];

export function appliedVersions(db: Db): Set<number> {
  // schema_migration may not exist yet on first run.
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'`)
    .get();
  if (!tableExists) return new Set();
  const rows = db.prepare('SELECT version FROM schema_migration').all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((r) => r.version));
}

export function migrate(db: Db): readonly Migration[] {
  const applied = appliedVersions(db);
  const target = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  const ranNow: Migration[] = [];

  for (const m of target) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      // schema_migration table is itself migration 1; it must be in
      // place before we can write into it.
      const t = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'`,
      ).get();
      if (t) {
        db.prepare(
          'INSERT OR REPLACE INTO schema_migration(version, applied_at_ms, description) VALUES (?, ?, ?)',
        ).run(m.version, Date.now(), m.description);
      }
    })();
    ranNow.push(m);
  }
  return ranNow;
}
