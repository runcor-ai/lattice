import type { Database as SqliteDb } from 'better-sqlite3';

/**
 * Watchdog (intent §12; spec US11).
 *
 * Rides the slow clock. Read-only observer. Catches the blind-spot
 * failure mode of *having a tool and never using it*:
 *
 *   stated need + tool that could meet it + no use in the recent window
 *     → gap finding
 *
 * Findings flow into the slow-clock drift review as additional input.
 */

export interface WatchdogFinding {
  readonly kind: 'tool_unused' | 'stated_need_unmet';
  readonly summary: string;
  readonly evidence: string;
}

export interface WatchdogInputs {
  readonly db: SqliteDb;
  readonly windowCycles?: number;
  readonly currentCycle: number;
}

/**
 * findGaps — examines:
 *   - capability table (available action tools)
 *   - goal + plan_item bodies (stated needs)
 *   - trace.act over the recent window (tool usage)
 *
 * Returns findings for tools that:
 *   - are present + enabled (capability.enabled = 1, role_action = 1),
 *   - appear by NAME in a goal or plan_item body,
 *   - have NOT been invoked successfully in the window.
 */
export function findGaps(inputs: WatchdogInputs): readonly WatchdogFinding[] {
  const { db, currentCycle } = inputs;
  const window = inputs.windowCycles ?? 100;
  const sinceCycle = Math.max(0, currentCycle - window);

  const caps = db
    .prepare<[]>(
      `SELECT name FROM capability WHERE enabled = 1 AND role_action = 1`,
    )
    .all() as Array<{ name: string }>;
  if (caps.length === 0) return [];

  const goalBodies = db
    .prepare<[]>(`SELECT body FROM goal WHERE state IN ('proposed','active')`)
    .all() as Array<{ body: string }>;
  const itemBodies = db
    .prepare<[]>(
      `SELECT description AS body FROM plan_item WHERE state IN ('open','deferred')`,
    )
    .all() as Array<{ body: string }>;
  const stated = [...goalBodies, ...itemBodies].map((r) => r.body);

  const usageRows = db
    .prepare<[number]>(
      `SELECT body FROM trace WHERE kind = 'phase' AND phase = 'act' AND cycle >= ?`,
    )
    .all(sinceCycle) as Array<{ body: string }>;
  const usedNames = new Set<string>();
  for (const r of usageRows) {
    try {
      const parsed = JSON.parse(r.body) as { output_summary?: string };
      if (parsed.output_summary) {
        const m = /action=([\w-]+)/.exec(parsed.output_summary);
        if (m) usedNames.add(m[1]!);
      }
    } catch {
      /* skip malformed entries */
    }
  }

  const findings: WatchdogFinding[] = [];
  for (const cap of caps) {
    const mentioned = stated.some((b) => b.toLowerCase().includes(cap.name.toLowerCase()));
    if (mentioned && !usedNames.has(cap.name)) {
      findings.push({
        kind: 'tool_unused',
        summary: `tool "${cap.name}" appears in stated need but has not been used in last ${window} cycles`,
        evidence: `capability=${cap.name}; window=${window}`,
      });
    }
  }
  return findings;
}
