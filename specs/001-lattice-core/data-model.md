# Phase 1 — Data Model

The lattice's entire persistent state lives in **one SQLite file per
lattice** (constitution Principle II). This document specifies the schema
of that file, the on-disk JSONL trace shape, the SKILL.md frontmatter, and
the dial registry.

Every table is owned by exactly one package's queries. No package opens its
own database connection at module-load time; the runtime opens the file
once and passes a `Db` handle to each package.

## Conventions

- All `id` columns are `TEXT PRIMARY KEY` storing a UUIDv7 generated at
  insert (`uuid` library; sortable by creation time).
- All timestamp columns are `INTEGER NOT NULL` storing milliseconds since
  Unix epoch in UTC. A view (`cycle_time`) joins them to cycle numbers for
  trace queries.
- All free-text `why` / `reason` columns are `TEXT NOT NULL` — the
  admission rule (Principle XII) requires the why on every memory write.
- `cycle` columns are `INTEGER NOT NULL` and reference `entity.cycle`
  monotonically.
- All booleans are `INTEGER NOT NULL CHECK (col IN (0, 1))`.
- WAL mode on; `wal_autocheckpoint = 1000`; `synchronous = NORMAL`.
- Every table has appropriate indexes; only the most important are listed
  inline below.

## 1. Entity table (singleton)

The lattice itself.

```sql
CREATE TABLE entity (
  -- Singleton: exactly one row, id = 'self'
  id              TEXT PRIMARY KEY CHECK (id = 'self'),
  lattice_id      TEXT NOT NULL UNIQUE,        -- the Bridge-assigned ID
  name            TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  cycle           INTEGER NOT NULL DEFAULT 0,  -- the canonical cycle counter
  paused          INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  schema_version  INTEGER NOT NULL             -- migration target
);
```

Owner: `packages/runtime`. Writers: the `pulse` phase increments `cycle`.
The Bridge can write `paused`.

## 2. Identity memory

What the entity *is*. Permanent; immune to decay (Principle IV.1).

```sql
CREATE TABLE memory_identity (
  id            TEXT PRIMARY KEY,
  written_at_ms INTEGER NOT NULL,
  cycle         INTEGER NOT NULL,
  body          TEXT NOT NULL,        -- R++-formatted self-theory block
  why           TEXT NOT NULL         -- why this identity element is held
);
CREATE TABLE identity_current (
  -- The composed identity prior used by the substrate's ground phase.
  -- One row, id = 'self'. Rewritten by the reflective update.
  id            TEXT PRIMARY KEY CHECK (id = 'self'),
  composed_body TEXT NOT NULL,        -- R++ text injected into ground
  composed_at_ms INTEGER NOT NULL,
  composed_at_cycle INTEGER NOT NULL
);
```

Owner: `packages/identity`. The reflective update (decider-driven) reads
`memory_identity` and rewrites `identity_current.composed_body`.

## 3. Plan memory

Where the entity is going. Rewritable but never evaporates (Principle IV.2).
Carries the working state of jobs (intent spec §9.5).

```sql
CREATE TABLE plan_job (
  id              TEXT PRIMARY KEY,
  opened_at_cycle INTEGER NOT NULL,
  opened_at_ms    INTEGER NOT NULL,
  title           TEXT NOT NULL,
  source          TEXT NOT NULL,    -- 'operator' | 'delegation:<peer>' | 'self'
  status          TEXT NOT NULL CHECK (status IN ('open','closed_full','closed_partial')),
  closed_at_cycle INTEGER,
  closed_at_ms    INTEGER,
  why             TEXT NOT NULL
);

CREATE TABLE plan_item (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL REFERENCES plan_job(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  description         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('open','passed','deferred')),
  iteration_count     INTEGER NOT NULL DEFAULT 0,
  completion_check    TEXT NOT NULL,         -- R++ block: hooks + judgement pass spec
  passed_at_cycle     INTEGER,
  deferred_at_cycle   INTEGER,
  defer_reason        TEXT,                  -- required when deferred
  unblock_condition   TEXT,                  -- required when deferred
  unblock_test        TEXT                   -- the perception test for the condition
);
CREATE INDEX plan_item_job_state ON plan_item (job_id, state);
CREATE INDEX plan_item_deferred  ON plan_item (state) WHERE state = 'deferred';
```

Owner: `packages/jobs`. The deferred-item index makes the perception sweep
of unblock conditions efficient.

## 4. Episodic memory

What happened, in order. **Decays per the formula** (Principle IV.3 +
intent §9.3).

```sql
CREATE TABLE memory_episodic (
  id              TEXT PRIMARY KEY,
  written_at_ms   INTEGER NOT NULL,
  cycle           INTEGER NOT NULL,
  body            TEXT NOT NULL,         -- R++ or structured text
  why             TEXT NOT NULL,

  -- Decay formula: M = R * ln(f + 1) * exp(-t / (tau * D))
  reinforcement   REAL NOT NULL DEFAULT 1.0,   -- R
  access_count    INTEGER NOT NULL DEFAULT 0,  -- f
  last_access_ms  INTEGER NOT NULL,            -- contributes to t

  -- Computed by the recall pass at query time; persisted only on the
  -- consolidation pass for forget/promote decisions:
  durability      REAL                          -- M
);
CREATE INDEX memory_episodic_cycle ON memory_episodic (cycle);
```

Owner: `packages/memory`. The consolidation pass on the slow clock applies
the decay formula, deletes rows with `M < forget_threshold`, and *promotes*
rows with `M > promote_threshold` into `memory_semantic` (with compression).

## 5. Semantic memory

Settled facts and rules. Persists but correctable when a fact goes stale
(Principle IV.4). The subconscious sweep (Principle V) writes corrections
here.

```sql
CREATE TABLE memory_semantic (
  id              TEXT PRIMARY KEY,
  written_at_ms   INTEGER NOT NULL,
  last_validated_ms INTEGER NOT NULL,
  cycle           INTEGER NOT NULL,
  body            TEXT NOT NULL,
  why             TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('promoted','derived','operator','collaboration')),
  source_ref      TEXT                       -- e.g. promoted-from episodic id
);

CREATE TABLE memory_semantic_correction (
  -- Subconscious sweep audit. Every correction it makes lands here AND in trace.
  id              TEXT PRIMARY KEY,
  semantic_id     TEXT NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  cycle           INTEGER NOT NULL,
  was             TEXT NOT NULL,
  now_is          TEXT NOT NULL,
  rule            TEXT NOT NULL,        -- which rule fired
  at_ms           INTEGER NOT NULL
);
```

Owner: `packages/memory`.

## 6. Memory index (recall surface)

One short description line per memory in any of the four systems. The
recall pass selects from this index via a cheap LLM call (intent §9.4),
keeping the four backing tables narrow.

```sql
CREATE TABLE memory_index (
  id              TEXT PRIMARY KEY,
  memory_table    TEXT NOT NULL CHECK (memory_table IN
                    ('identity','plan_job','plan_item','episodic','semantic')),
  memory_id       TEXT NOT NULL,
  description     TEXT NOT NULL,       -- "what is this memory" in one line
  written_at_ms   INTEGER NOT NULL,
  UNIQUE (memory_table, memory_id)
);
CREATE INDEX memory_index_desc ON memory_index (description);
```

Owner: `packages/memory`. Index rows are written whenever a memory is
written (a single transaction commits both).

## 7. Skills

A skill is a Claude `SKILL.md` file with frontmatter + R++ body, stored
inside the SQLite file (the file IS the entity — Principle II — so skills
travel with it).

```sql
CREATE TABLE skill (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,                       -- SKILL.md frontmatter name
  description     TEXT NOT NULL,                       -- SKILL.md frontmatter description
  body_rpp        TEXT NOT NULL,                       -- R++ body, parser-validated
  abstraction     TEXT NOT NULL CHECK (abstraction IN ('specific','generic')),
  minted_at_cycle INTEGER NOT NULL,
  source_job_id   TEXT REFERENCES plan_job(id),
  source_item_id  TEXT REFERENCES plan_item(id),
  active          INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  UNIQUE (name, abstraction)
);
CREATE INDEX skill_active_desc ON skill (active, description);

CREATE TABLE skill_attachment (
  -- Files a skill's body references (the "bundled supporting files" of a
  -- Claude SKILL.md). Stored inside the SQLite file as blobs.
  skill_id        TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  relpath         TEXT NOT NULL,
  bytes           BLOB NOT NULL,
  PRIMARY KEY (skill_id, relpath)
);
```

Owner: `packages/skills`. `active = 0` means proposed-but-not-adopted;
adoption is gated per the autonomy dial.

### SKILL.md frontmatter format

When a skill is exported (e.g. via MCP to a peer lattice — read-only, per
intent §13), it is serialized as:

```markdown
---
name: <kebab-case-name>
description: <one-line "what this is and when to use it">
abstraction: specific | generic
minted_at_cycle: <integer>
---

<R++ body>
```

The R++ body is the procedure. The frontmatter `description` is the
*handle* the lattice is shown in recall; the body is the *payload* loaded
into the decide prompt only on choosing (intent §13).

## 8. Trace (cognitive record)

Two surfaces (Principle X + spec FR-049):

1. **Durable JSONL file** at `<entity-dir>/trace.jsonl[.N]`. Rotates by
   size; oldest segments archived to the snapshot destination.
2. **In-SQLite indexed store** for fast Bridge queries.

### JSONL row format

One row per phase per cycle, plus one row per subconscious correction, job
event, substrate flag, and operator action.

```jsonc
// Phase entry
{ "kind": "phase", "cycle": 123, "phase": "decide",
  "at_ms": 1716566400000, "duration_ms": 412,
  "input_summary": "...", "output_summary": "...",
  "result": "ok" }

// Subconscious correction
{ "kind": "subconscious", "cycle": 123, "at_ms": ...,
  "rule": "stale_semantic", "memory_id": "...", "was": "...", "now": "..." }

// Job event
{ "kind": "job", "cycle": 123, "event": "item_passed",
  "job_id": "...", "item_id": "..." }
// event ∈ {opened, item_passed, item_failed_iterating, item_deferred,
//          item_unblocked, closed_full, closed_partial}

// Substrate flag
{ "kind": "substrate", "cycle": 123, "phase": "decide",
  "outcome": "block", "law": "Reality", "reason": "..." }

// Operator action
{ "kind": "operator", "cycle": 123, "action": "dial_adjusted",
  "dial": "autonomy", "from": "high", "to": "medium", "at_ms": ... }
```

### Indexed store

```sql
CREATE TABLE trace (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle           INTEGER NOT NULL,
  at_ms           INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  phase           TEXT,
  body            TEXT NOT NULL                -- JSON-serialized row from above
);
CREATE INDEX trace_cycle ON trace (cycle);
CREATE INDEX trace_kind  ON trace (kind);
CREATE INDEX trace_phase ON trace (phase) WHERE phase IS NOT NULL;
```

Owner: `packages/trace`. The writer commits to JSONL first, then mirrors
to the indexed store in the same SQLite transaction as the cycle's other
writes (so trace and state stay consistent on crash).

## 9. Dial registry

The runtime-adjustable operator parameters (constitution + spec FR-054).
Stored as key/value with a typed value column for safe Bridge edits.

```sql
CREATE TABLE dial (
  name            TEXT PRIMARY KEY,
  value_json      TEXT NOT NULL,        -- zod-validated against schema_id
  schema_id       TEXT NOT NULL,        -- e.g. 'enum:autonomy', 'float:0..1', 'int>0'
  updated_at_ms   INTEGER NOT NULL,
  updated_at_cycle INTEGER NOT NULL,
  why             TEXT                   -- operator note on the change
);
```

The twelve dials with their default values:

| Dial | Type | Default | Notes |
|---|---|---|---|
| `autonomy` | enum: low / medium / high | `medium` | Governs discernment-flag handling + job sign-off |
| `exploration` | float 0..1 | `0.3` | Exploit vs explore |
| `memoryDurability` | object `{tau: number, D: number}` | `{tau: 100, D: 1.0}` | Decay-formula parameters |
| `promotionThreshold` | float 0..1 | `0.6` | M-threshold for episodic→semantic |
| `memoryRecallBreadth` | int ≥ 1 | `12` | How many memories recall pulls |
| `planStability` | float 0..1 | `0.7` | How readily plan is rewritten |
| `dialecticDepth` | int ≥ 0 | `0` | 0 = single-model decider |
| `reviewCadence` | object `{baseline: int, loadAware: bool}` | `{baseline: 100, loadAware: true}` | Slow-clock cadence in cycles |
| `drivePressure` | float 0..2 | `1.0` | Drive function scaling |
| `riskTolerance` | float 0..1 | `0.5` | Confidence threshold |
| `budget` | object `{unit: 'usd'|'tokens'|'seconds', ceiling: number, spent: number}` | `{unit: 'usd', ceiling: 5, spent: 0}` | Per-lattice-lifetime |

Owner: `packages/runtime`. The Bridge writes via a validated API.

## 10. Capabilities (the tool manifest)

The starting manifest (spec FR-041..042) plus any tools discovered later.

```sql
CREATE TABLE capability (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('manifest','discovered')),
  mcp_server_uri  TEXT,                 -- when MCP
  api_config_json TEXT,                 -- when API
  role_sense      INTEGER NOT NULL CHECK (role_sense IN (0,1)),
  role_action     INTEGER NOT NULL CHECK (role_action IN (0,1)),
  added_at_cycle  INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  rejected_reason TEXT,                 -- when added but substrate-rejected
  CHECK (role_sense + role_action >= 1) -- at least one role
);
```

Owner: `packages/capabilities`.

## 11. Goals, drives, temporal

```sql
CREATE TABLE goal (
  id              TEXT PRIMARY KEY,
  body            TEXT NOT NULL,         -- R++ goal block
  proposed_at_cycle INTEGER NOT NULL,
  parent_id       TEXT REFERENCES goal(id),
  state           TEXT NOT NULL CHECK (state IN ('proposed','active','satisfied','abandoned')),
  why             TEXT NOT NULL
);

CREATE TABLE drive_state (
  -- One row per drive per cycle (or per cycle-window for compactness).
  cycle           INTEGER NOT NULL,
  drive           TEXT NOT NULL CHECK (drive IN ('resource_pressure','curiosity','reactivity','coherence')),
  value           REAL NOT NULL,
  PRIMARY KEY (cycle, drive)
);

CREATE TABLE commitment (
  id              TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  deadline_cycle  INTEGER NOT NULL,        -- canonical unit: cycles, not wall-clock
  pressure_band   TEXT NOT NULL CHECK (pressure_band IN ('green','yellow','orange','red')),
  job_id          TEXT REFERENCES plan_job(id),
  source          TEXT NOT NULL            -- 'operator' | 'self' | 'collaboration:<peer>'
);
```

Owners: `packages/goals`, `packages/drives`, `packages/temporal`.

## 12. Collaboration registry — peers known to this lattice

Per constitution Principle XIV: a lattice never reads another's memory;
this table is *this* lattice's knowledge OF peers, not shared state.

```sql
CREATE TABLE peer_known (
  id              TEXT PRIMARY KEY,         -- peer's lattice_id
  essence         TEXT NOT NULL,            -- the peer's one-sentence essence
  registry_url    TEXT NOT NULL,
  first_seen_cycle INTEGER NOT NULL,
  last_seen_cycle  INTEGER NOT NULL,
  last_seen_ms     INTEGER NOT NULL
);
```

Owner: `packages/collaboration`.

## 13. Snapshot bookkeeping

```sql
CREATE TABLE snapshot_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  destination     TEXT NOT NULL,          -- backend name, e.g. 'local-folder'
  destination_uri TEXT NOT NULL,
  at_cycle        INTEGER NOT NULL,
  at_ms           INTEGER NOT NULL,
  bytes           INTEGER NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('ok','failed','skipped')),
  error           TEXT
);
```

Owner: `packages/snapshot`.

## 14. Migrations

```sql
CREATE TABLE schema_migration (
  version         INTEGER PRIMARY KEY,
  applied_at_ms   INTEGER NOT NULL,
  description     TEXT NOT NULL
);
```

Owner: `packages/runtime`. On first start, the runtime applies migrations
1..N in order. `entity.schema_version` records the latest applied.

## Logic-classification overlay (Principle V)

For every table above, which logic writes it?

| Table | Writer | Logic kind |
|---|---|---|
| `entity` | runtime | deterministic |
| `memory_identity` | identity (decider-driven reflective update) | LLM judgement |
| `identity_current` | identity (recomposition) | deterministic (mechanical merge) |
| `plan_job`, `plan_item` | jobs + decider | mixed (operator/decider opens; deterministic state transitions; LLM writes deferral reasons) |
| `memory_episodic` | runtime `write` phase | deterministic (mechanical persist of the cycle) |
| `memory_semantic` | promotion path + subconscious sweep | mixed (promotion = deterministic threshold; subconscious correction = deterministic; new fact writes = LLM judgement) |
| `memory_semantic_correction` | subconscious sweep | deterministic |
| `memory_index` | every memory write | deterministic (description is one line from the writer) |
| `skill` | skills (decider-driven extraction) | LLM judgement |
| `skill_attachment` | skills | deterministic |
| `trace` | trace writer | deterministic |
| `dial` | Bridge / runtime | deterministic |
| `capability` | runtime / discovery | mixed (manifest = operator; discovery = LLM judgement on candidate fit; substrate filter = deterministic) |
| `goal` | goals (decider) | LLM judgement |
| `drive_state` | drives | deterministic |
| `commitment` | temporal / jobs | mixed |
| `peer_known` | collaboration | deterministic |
| `snapshot_log` | snapshot | deterministic |
| `schema_migration` | runtime | deterministic |

If a future schema change adds a table, it picks a side and justifies it
(Principle V).
