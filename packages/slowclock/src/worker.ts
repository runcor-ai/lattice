import { closeDb, openDb, type Db } from '@runcor/runtime';
import type { Lock } from '@runcor/runtime';
import { SqliteTraceIndex, Trace, type TraceOptions } from '@runcor/trace';

import { nextWakeAtCycle, type CadenceParams, DEFAULT_CADENCE } from './cadence.js';
import { consolidate, type ConsolidateResult } from './consolidate.js';
import { driftReview, type DriftDetector, type DriftReviewResult } from './drift-review.js';
import { claimSlowclockLock, slowclockLockPath } from './lock.js';

/**
 * SlowclockWorker — the second process per lattice (constitution
 * Principle VII; spec FR-025..029).
 *
 * Polls the shared SQLite for the entity's current cycle counter.
 * When `cycle >= nextWakeAtCycle`, runs consolidation + drift
 * review, writes corrections into memory, records a trace entry,
 * then computes the next wake. NEVER signals or interrupts the fast
 * loop (FR-028).
 *
 * Resume-friendly: persistent state is just `nextWakeAtCycle`,
 * computed fresh from the current cycle on startup.
 */

export interface SlowclockWorkerOptions {
  readonly sqlitePath: string;
  /** Polling interval in ms. Default 1000. Tests use 50. */
  readonly pollIntervalMs?: number;
  /** Cadence params; default baseline=100, load-aware. */
  readonly cadence?: CadenceParams;
  /** Per-cycle load metric (1.0 = neutral). Default constant 1.0. Slice 11 supplies real metric. */
  readonly loadMetric?: (db: Db) => number;
  /** Drift detector. Default = slice-7 stub. */
  readonly detector?: DriftDetector;
  /** Optional trace JSONL path for slow-clock events. */
  readonly tracePath?: string | null;
  /**
   * Optional base directory the watchdog's claim_vs_disk detector uses when
   * resolving RELATIVE claimed paths. Explicit — no implicit process.cwd().
   * If unset, relative paths are SKIPPED (a benign trace note is written).
   */
  readonly pathRoot?: string;
}

export interface SlowclockWakeOutcome {
  readonly cycle: number;
  readonly at_ms: number;
  readonly consolidate: ConsolidateResult;
  readonly drift: DriftReviewResult;
  readonly nextWakeAtCycle: number;
}

export class SlowclockWorker {
  private readonly db: Db;
  private readonly lock: Lock;
  private readonly trace: Trace;
  private readonly pollIntervalMs: number;
  private readonly cadence: CadenceParams;
  private readonly detector: DriftDetector | undefined;
  private readonly loadMetric: (db: Db) => number;
  private readonly pathRoot: string | undefined;

  private nextWakeAtCycleVal: number;
  private lastWakeAtCycle = 0;
  private closed = false;

  constructor(opts: SlowclockWorkerOptions) {
    this.lock = claimSlowclockLock(opts.sqlitePath);
    try {
      this.db = openDb(opts.sqlitePath, { fileMustExist: true });
    } catch (err) {
      this.lock.release();
      throw err;
    }
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.cadence = opts.cadence ?? DEFAULT_CADENCE;
    this.detector = opts.detector;
    this.loadMetric = opts.loadMetric ?? (() => 1.0);
    this.pathRoot = opts.pathRoot;

    const traceOpts: TraceOptions = {
      jsonlPath: opts.tracePath ?? null,
      sqliteIndex: new SqliteTraceIndex(this.db),
    };
    this.trace = new Trace(traceOpts);

    // First wake is anchored at the CURRENT cycle so we don't fire
    // immediately on startup unless the entity has already moved past
    // its baseline interval (resume-friendly).
    const cycle = this.readCycle();
    this.nextWakeAtCycleVal = nextWakeAtCycle(cycle, this.loadMetric(this.db), this.cadence);
  }

  get nextWakeAt(): number {
    return this.nextWakeAtCycleVal;
  }

  get lastWakeAt(): number {
    return this.lastWakeAtCycle;
  }

  private readCycle(): number {
    const row = this.db.prepare<[]>(`SELECT cycle FROM entity WHERE id = 'self'`).get() as
      | { cycle: number }
      | undefined;
    return row?.cycle ?? 0;
  }

  /** Run a single wake — exposed for tests. */
  tick(): SlowclockWakeOutcome | null {
    const cycle = this.readCycle();
    if (cycle < this.nextWakeAtCycleVal) return null;

    const at_ms = Date.now();
    // Consolidation + drift in a single transaction so the wake is
    // atomic: either both committed or both rolled back.
    let consResult!: ConsolidateResult;
    let driftResult!: DriftReviewResult;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      consResult = consolidate(this.db, { cycle, at_ms });
      const driftCtx = {
        cycle,
        at_ms,
        ...(this.pathRoot !== undefined ? { pathRoot: this.pathRoot } : {}),
      };
      driftResult = this.detector
        ? driftReview(this.db, driftCtx, this.detector)
        : driftReview(this.db, driftCtx);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }

    this.lastWakeAtCycle = cycle;
    this.nextWakeAtCycleVal = nextWakeAtCycle(cycle, this.loadMetric(this.db), this.cadence);

    // Trace the wake (kind='operator' until slice 8 adds a 'slowclock'
    // kind — slice 7 reuses 'operator' with a descriptive action).
    this.trace.write({
      kind: 'operator',
      cycle,
      at_ms,
      action: 'lifecycle',
      detail: `slowclock-wake forgotten=${consResult.decay.forgotten} promoted=${consResult.promoted} drift=${driftResult.findings.length}`,
    });

    return {
      cycle,
      at_ms,
      consolidate: consResult,
      drift: driftResult,
      nextWakeAtCycle: this.nextWakeAtCycleVal,
    };
  }

  /** Long-running loop. Blocks until abortSignal fires. */
  async run(abortSignal: AbortSignal): Promise<number> {
    let wakes = 0;
    while (!abortSignal.aborted) {
      try {
        const out = this.tick();
        if (out) wakes += 1;
      } catch {
        // Swallow + continue: the slow clock is non-fatal to the
        // lattice. Operational logging lands in slice 14.
      }
      await sleep(this.pollIntervalMs, abortSignal);
    }
    return wakes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeDb(this.db);
    } finally {
      this.lock.release();
    }
  }
}

function sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (abortSignal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    abortSignal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export { slowclockLockPath };
