import type {
  Capability,
  ObserveContext,
  PerceptionSnapshot,
  SenseReading,
} from './types.js';

/**
 * Perception — the slice-10 observe-phase implementation
 * (intent §6 observe; spec FR-005).
 *
 * - Reads every enabled sense in parallel via Promise.allSettled.
 * - Per-sense timeout (default 5_000ms) — one slow sense MUST NOT
 *   serialise others.
 * - Failed senses produce `result: 'failed'`; if a prior cached
 *   reading exists, the result is `'stale'` and `data` is the cached
 *   value.
 *
 * Per FR-005 (2026-05-24 clarification): a sense failure MUST NOT
 * pause the loop. The cycle continues with whatever readings we got.
 */

export interface PerceptionOptions {
  /** Per-sense timeout in ms. Default 5_000. */
  readonly senseTimeoutMs?: number;
}

interface CachedReading {
  data: unknown;
  freshAtMs: number;
}

export class Perception {
  private readonly cache = new Map<string, CachedReading>();
  private readonly senseTimeoutMs: number;

  constructor(opts: PerceptionOptions = {}) {
    this.senseTimeoutMs = opts.senseTimeoutMs ?? 5_000;
  }

  async observe(
    senses: readonly Capability<unknown, unknown>[],
    ctx: ObserveContext,
  ): Promise<PerceptionSnapshot> {
    const enabled = senses.filter((s) => s.role.sense && s.isEnabled());

    const reads = enabled.map((sense) =>
      this.readOneWithTimeout(sense, ctx).then(
        (data) => ({ sense, ok: true, data }) as const,
        (err) => ({ sense, ok: false, err }) as const,
      ),
    );
    const results = await Promise.all(reads);

    const out: Record<string, SenseReading> = {};
    for (const r of results) {
      const cached = this.cache.get(r.sense.name);
      if (r.ok) {
        const freshAtMs = Date.now();
        this.cache.set(r.sense.name, { data: r.data, freshAtMs });
        out[r.sense.name] = {
          capability: r.sense.name,
          result: 'ok',
          data: r.data,
          last_fresh_at_ms: freshAtMs,
        };
      } else {
        const reason = r.err instanceof Error ? r.err.message : String(r.err);
        if (cached) {
          out[r.sense.name] = {
            capability: r.sense.name,
            result: 'stale',
            data: cached.data,
            failed_reason: reason,
            last_fresh_at_ms: cached.freshAtMs,
          };
        } else {
          out[r.sense.name] = {
            capability: r.sense.name,
            result: 'failed',
            data: null,
            failed_reason: reason,
            last_fresh_at_ms: 0,
          };
        }
      }
    }
    return {
      cycle: ctx.cycle,
      at_ms: Date.now(),
      senses: out,
      unblocked_items: [],
    };
  }

  private readOneWithTimeout(
    sense: Capability<unknown, unknown>,
    ctx: ObserveContext,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`sense "${sense.name}" timed out after ${this.senseTimeoutMs}ms`));
      }, this.senseTimeoutMs);

      Promise.resolve()
        .then(() => sense.read!(ctx))
        .then(
          (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          },
        );
    });
  }
}
