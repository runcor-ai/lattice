import { makeAppendPlanItemAction, makeCloseJobItemAction, type Capability } from '@runcor/capabilities';
import { selectDecider, type Decider } from '@runcor/decider';
import { DialecticDecider } from '@runcor/dialectic';
import type { ModelBackend } from '@runcor/engine';
import { JobsService, builtinRegistry, parseSpec, summarizeGate } from '@runcor/jobs';
import type { AutonomyLevel } from '@runcor/substrate';
import { SqliteTraceIndex, Trace, type TraceOptions } from '@runcor/trace';

import { runCycle } from './cycle.js';
import { closeDb, openDb, type Db } from './db.js';
import { ensureEntity, readEntity } from './entity-store.js';
import { claimLock, type Lock } from './lockfile.js';
import { migrate } from './migrations.js';
import { SqliteMemorySink } from './sqlite-memory.js';
import type { CycleResult, LatticeIdentity, TasksView } from './types.js';

export interface LatticeSqliteConfig {
  /** Absolute path to the lattice's SQLite file, or `':memory:'` for ephemeral. */
  readonly path: string;
  /** Lockfile path override. Defaults to `${path}.lock`. Ignored for ':memory:'. */
  readonly lockfilePath?: string;
}

export interface LatticeOptions {
  readonly identity: LatticeIdentity;
  readonly engine: ModelBackend;
  readonly senses?: readonly Capability<unknown, unknown>[];
  readonly actions?: readonly Capability<unknown, unknown>[];
  readonly trace?: TraceOptions;
  /** Defaults to `{ path: ':memory:' }` (ephemeral). For persistence, pass a real file path. */
  readonly sqlite?: LatticeSqliteConfig;
  /** Lattice name persisted to the entity row on first start. Defaults to 'unnamed'. */
  readonly name?: string;
  /** Stable lattice ID; auto-generated if omitted on first start. */
  readonly latticeId?: string;
  /** Autonomy dial value. Defaults to 'medium'. Slice 14 wires the dial table. */
  readonly autonomy?: AutonomyLevel;
  /**
   * Dialectic depth (slice 8). 0 = SingleModelDecider (default);
   * >=1 = DialecticDecider with that many Coach rounds before Judge.
   */
  readonly dialecticDepth?: number;
  /** Override the constructed decider entirely. Tests use this to inject mocks. */
  readonly decider?: Decider;
  /** Item 1 — run the fast/medium memory clocks each cycle. Defaults to true. */
  readonly memoryClocks?: boolean;
}

/**
 * Lattice — the cycle-running, persistence-owning composer.
 *
 * Slice 3 is the persistence cut-over: every Lattice now owns a
 * SQLite handle (file or `:memory:`), runs migrations on open, and
 * persists its cycle counter in the `entity` row inside the cycle's
 * transaction. Resume parity (FR-007, SC-002) is provable from here.
 */
export class Lattice {
  readonly identity: LatticeIdentity;
  engine: ModelBackend;
  readonly trace: Trace;
  readonly memory: SqliteMemorySink;
  readonly senses: readonly Capability<unknown, unknown>[];
  readonly actions: readonly Capability<unknown, unknown>[];
  readonly sqlitePath: string;

  private readonly db: Db;
  private readonly lock: Lock | null;
  private readonly setCycleStmt: ReturnType<Db['prepare']>;
  private cycleCount: number;
  autonomy: AutonomyLevel;
  decider: Decider;
  readonly memoryClocks: boolean;

  constructor(opts: LatticeOptions) {
    this.identity = opts.identity;
    this.engine = opts.engine;
    this.senses = opts.senses ?? [];
    this.actions = opts.actions ?? [];
    this.autonomy = opts.autonomy ?? 'medium';
    this.memoryClocks = opts.memoryClocks ?? true;
    this.decider =
      opts.decider ??
      selectDecider(
        { engine: this.engine },
        {
          dialecticDepth: opts.dialecticDepth ?? 0,
          buildDialectic: (deps, depth) => new DialecticDecider(deps, { depth }),
        },
      );

    const sqliteCfg = opts.sqlite ?? { path: ':memory:' };
    this.sqlitePath = sqliteCfg.path;

    const isMemory = this.sqlitePath === ':memory:' || this.sqlitePath === '';

    // Claim lockfile FIRST for file-backed lattices (FR-010).
    this.lock = isMemory
      ? null
      : claimLock(sqliteCfg.lockfilePath ?? `${this.sqlitePath}.lock`);

    try {
      this.db = openDb(this.sqlitePath);
      migrate(this.db);
      ensureEntity(this.db, {
        name: opts.name ?? 'unnamed',
        ...(opts.latticeId !== undefined ? { latticeId: opts.latticeId } : {}),
      });
      const entity = readEntity(this.db);
      this.cycleCount = entity.cycle;
      this.setCycleStmt = this.db.prepare(`UPDATE entity SET cycle = ? WHERE id = 'self'`);

      const traceOpts: TraceOptions = {
        jsonlPath: opts.trace?.jsonlPath ?? null,
        sqliteIndex: new SqliteTraceIndex(this.db),
      };
      if (opts.trace?.initialCapacity !== undefined) {
        (traceOpts as { initialCapacity?: number }).initialCapacity = opts.trace.initialCapacity;
      }
      this.trace = new Trace(traceOpts);
      this.memory = new SqliteMemorySink(this.db);

      // Item 10 — Layer 2 (init): promote one-time setup content into
      // semantic memory ONCE, gated by a marker so a restart never
      // re-runs it. It is never injected into per-cycle prompts; if it
      // needs to persist, this is how (per the spec's Layer-2 rule).
      const initLayer = opts.identity.initLayer?.trim();
      if (initLayer) {
        const already = this.db
          .prepare(`SELECT 1 FROM memory_semantic WHERE source_ref = 'layer2-init' LIMIT 1`)
          .get();
        if (!already) {
          this.memory.memory.write(
            'semantic',
            {
              body: initLayer,
              why: 'Layer-2 init content promoted to memory at startup (Item 10)',
              admissionTag: 'decision',
              source_kind: 'operator',
              source_ref: 'layer2-init',
            },
            { cycle: this.cycleCount, at_ms: Date.now() },
          );
          this.trace.write({
            kind: 'operator',
            cycle: this.cycleCount,
            at_ms: Date.now(),
            action: 'lifecycle',
            detail: `seed Layer 2 (init) promoted to semantic memory (${initLayer.length} chars)`,
          });
        }
      }
    } catch (err) {
      // Open / migrate failed — release the lock so retry is possible.
      this.lock?.release();
      throw err;
    }
  }

  /** Direct DB handle. Used by the snapshot module and by dbEquals helpers. */
  dbHandle(): Db {
    return this.db;
  }

  get currentCycle(): number {
    return this.cycleCount + 1;
  }

  get completedCycle(): number {
    return this.cycleCount;
  }

  /**
   * Run exactly one cycle.
   *
   * The cycle runs inside `BEGIN IMMEDIATE` / `COMMIT` so all of its
   * SQLite-bound writes (memory, trace index, entity.cycle increment)
   * commit atomically. A crash mid-cycle → rollback → next start
   * resumes from the last committed boundary (FR-007 + Edge Case
   * "crash mid-cycle").
   */
  async runOnce(abortSignal: AbortSignal = new AbortController().signal): Promise<CycleResult> {
    const cycle = this.cycleCount + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const jobs = new JobsService(this.db);
      // Built once per cycle; reused for every open item's live gate verdict.
      const checkRegistry = builtinRegistry();
      const tasks: TasksView = {
        listOpenJobs: () =>
          jobs.checklist
            .listOpen()
            .map((j) => ({ id: j.id, title: j.title, why: j.why, body: j.body })),
        listOpenItems: (jobId: string) =>
          jobs.checklist
            .items(jobId)
            .filter((it) => it.state === 'open')
            .map((it) => {
              // Evaluate the item's cheap deterministic gate live against the
              // filesystem so the reality slice carries ground truth that a
              // drifted situation summary cannot override.
              let gate: { passed: boolean; reason: string; deferred: boolean };
              try {
                gate = summarizeGate(parseSpec(it.completion_check), checkRegistry, it, cycle);
              } catch (err) {
                gate = {
                  passed: false,
                  reason: `gate spec unreadable: ${err instanceof Error ? err.message : String(err)}`,
                  deferred: false,
                };
              }
              return {
                id: it.id,
                description: it.description,
                iteration_count: it.iteration_count,
                gate,
              };
            }),
      };
      // close-job-item is a built-in, but only when the lattice has at
      // least one open job — otherwise the action would be unusable
      // (no items to close) and would just clutter the action menu.
      // The capability is bound to THIS cycle's JobsService.
      const hasOpenJobs = jobs.checklist.listOpen().length > 0;
      const hasCloseAlready = this.actions.some((a) => a.name === 'close-job-item');
      let actionsForCycle: readonly Capability<unknown, unknown>[] = this.actions;
      if (hasOpenJobs && !hasCloseAlready) {
        const closeAction = makeCloseJobItemAction({
          attemptCheck: async (itemId, attemptCtx) => {
            const r = await jobs.attemptCheck(itemId, attemptCtx);
            return {
              itemId,
              outcome: r.outcome,
              ...(r.reason ? { reason: r.reason } : {}),
            };
          },
        }) as Capability<unknown, unknown>;
        // Item 8 — let the lattice author its own items on its open jobs
        // (same validation + audit as the bridge endpoint).
        const appendAction = makeAppendPlanItemAction({
          append: (input) => {
            const res = jobs.appendLatticeItem(
              input.jobId,
              {
                description: input.description,
                gateType: input.gate.type,
                ...(input.gate.args ? { gateArgs: input.gate.args } : {}),
                blockedBy: input.blockedBy ?? null,
              },
              { cycle, at_ms: Date.now(), trace: this.trace },
            );
            return res.ok ? { ok: true, itemId: res.item.id } : { ok: false, reason: res.reason };
          },
        }) as Capability<unknown, unknown>;
        actionsForCycle = [...this.actions, closeAction, appendAction];
      }
      const result = await runCycle({
        cycle,
        at_ms: Date.now(),
        trace: this.trace,
        engine: this.engine,
        decider: this.decider,
        identity: this.identity,
        senses: this.senses,
        actions: actionsForCycle,
        memory: this.memory,
        recall: this.memory,
        abortSignal,
        autonomy: this.autonomy,
        tasks,
        memoryClocks: this.memoryClocks,
      });
      if (result.outcome === 'completed') {
        this.setCycleStmt.run(cycle);
        this.db.exec('COMMIT');
        this.cycleCount = cycle;
      } else {
        this.db.exec('ROLLBACK');
      }
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  /**
   * Swap the model backend mid-flight (slice 12; Bridge dial /
   * spec FR-054 swap-backend action). The next cycle uses the new
   * backend. Identity and memory are untouched; the lattice itself
   * is unaware of the swap.
   *
   * Also rebuilds the default decider against the new backend
   * unless a custom decider was injected at construction.
   */
  setEngine(engine: ModelBackend, opts: { rebuildDecider?: boolean } = {}): void {
    this.engine = engine;
    if (opts.rebuildDecider !== false) {
      this.decider = selectDecider(
        { engine: this.engine },
        {
          dialecticDepth: this.decider.name === 'dialectic' ? 1 : 0,
          buildDialectic: (deps, depth) => new DialecticDecider(deps, { depth }),
        },
      );
    }
    this.trace.write({
      kind: 'operator',
      cycle: this.cycleCount,
      at_ms: Date.now(),
      action: 'lifecycle',
      detail: `engine swapped to ${engine.name}`,
    });
  }

  /** Test-only: run exactly N cycles. */
  async runN(n: number, abortSignal: AbortSignal = new AbortController().signal): Promise<CycleResult[]> {
    const results: CycleResult[] = [];
    for (let i = 0; i < n; i += 1) {
      if (abortSignal.aborted) break;
      results.push(await this.runOnce(abortSignal));
    }
    return results;
  }

  /**
   * Run continuously until the abort signal fires. The loop body has
   * NO internal exit (FR-003 + Principle I).
   *
   * We yield to the macrotask queue between cycles so timers, I/O,
   * and the abort signal can run.
   */
  async runUntilAborted(abortSignal: AbortSignal): Promise<number> {
    while (!abortSignal.aborted) {
      await this.runOnce(abortSignal);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return this.cycleCount;
  }

  /**
   * Cleanly release SQLite and the lockfile. Test code calls this in
   * teardown; production code uses the graceful-shutdown registry.
   */
  close(): void {
    try {
      closeDb(this.db);
    } finally {
      this.lock?.release();
    }
  }
}
