import { runSubconsciousSweep } from '@runcor/memory';
import { JobsService } from '@runcor/jobs';

import type { RuntimeMemoryAdapter } from '../sqlite-memory.js';
import type { CycleContext, JudgeOutput, WriteOutput } from '../types.js';

/**
 * write — records the cycle's outcome to episodic memory THEN runs
 * the subconscious sweep (slice 6).
 *
 * Constitution Principle V: deterministic, every-cycle, code-only.
 * Per FR-031 the sweep does three things together: fixes the
 * problem, flags it so judgement knows, writes it to the trace.
 *
 * The whole sequence runs inside the cycle's BEGIN/COMMIT (the
 * Lattice wraps runCycle in one), so the cycle write + sweep
 * commit together — or roll back together on a crash.
 */
export async function write(ctx: CycleContext, prev: JudgeOutput): Promise<WriteOutput> {
  // Persist the cycle's act-data so the lattice REMEMBERS what it
  // read / what command output it got. Without this the next cycle
  // would have only "cycle=N; chosen_action=X" and would keep
  // re-exploring instead of accumulating findings.
  const inputSummary = summariseRecord(prev.chosenInput);
  const dataSummary = summariseActData(prev.actData);

  ctx.memory.write(
    {
      system: 'episodic',
      admissionTag: 'cycle-outcome',
      body: [
        `cycle=${ctx.cycle}`,
        `chosen_action=${prev.chosenAction ?? '(none)'}`,
        inputSummary ? `input={${inputSummary}}` : '',
        `act_result=${prev.actResult}`,
        `judgement=${prev.judgement}`,
        dataSummary ? `data=${dataSummary}` : '',
        prev.actFailedReason ? `failed_reason=${prev.actFailedReason}` : '',
      ]
        .filter(Boolean)
        .join('; '),
      why: `auto-record of cycle ${ctx.cycle} outcome`,
    },
    { cycle: ctx.cycle, at_ms: ctx.at_ms },
  );

  // Subconscious sweep: deterministic, code-only, fixes flat
  // contradictions, observes (without acting on) judgement-required
  // ones. Runs against the same SQLite handle the cycle's writes
  // already committed to.
  const adapter = ctx.memory as RuntimeMemoryAdapter;
  const db = adapter.dbHandle();
  const sweep = runSubconsciousSweep(db, { cycle: ctx.cycle, at_ms: ctx.at_ms });

  for (const c of sweep.applied) {
    ctx.trace.write({
      kind: 'subconscious',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      rule: c.rule,
      memory_id: c.memoryId,
      was: c.was,
      now: c.now_is,
    });
  }
  for (const o of sweep.observedOnly) {
    ctx.trace.write({
      kind: 'subconscious',
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
      rule: `${o.rule} (observed, ${o.reason})`,
      memory_id: o.memoryId,
    });
  }

  // Auto-attempt all open plan_items' deterministic checks. This is
  // Principle V in action: closing an item when its file_exists
  // (or other code-only) hook passes is a flat correction; the
  // lattice should not have to consume a decide cycle just to call
  // close-job-item against a check it could never fail to pass.
  // The runtime does it every cycle inside the same transaction as
  // the action's writes — so newly-created files become detectable
  // by their owning item immediately. Items with judgement-required
  // checks stay open (auto-attempt only runs the deterministic
  // layer; the judgement layer remains for the decider).
  //
  // CRITICAL (bug fix 2026-05-25): pass `mode: 'auto'` so a hook
  // returning failed does NOT increment iteration_count. The sweep
  // polls every cycle; without this guard the cap would be exhausted
  // before the deliverable's marker file even exists, locking the
  // item closed forever even when the work was subsequently done.
  // Iteration_count is for "the lattice attempted close and failed,"
  // not for "the deterministic sweep polled and there's nothing yet."
  const jobs = new JobsService(db);
  let autoClosed = 0;
  for (const job of jobs.checklist.listOpen()) {
    for (const item of jobs.checklist.items(job.id)) {
      if (item.state !== 'open') continue;
      try {
        const r = jobs.attemptCheck(item.id, { cycle: ctx.cycle, mode: 'auto' });
        if (r.outcome === 'passed') {
          autoClosed += 1;
          ctx.trace.write({
            kind: 'subconscious',
            cycle: ctx.cycle,
            at_ms: ctx.at_ms,
            rule: 'auto-attempt-deterministic',
            memory_id: item.id,
            now: `item ${item.id.slice(0, 8)}… passed: ${item.description.slice(0, 80)}`,
          });
        }
      } catch {
        /* swallow per-item check errors — one bad item must not break the cycle */
      }
    }
  }

  return { ...prev, memoryWrites: 1 + sweep.applied.length + autoClosed };
}

/**
 * Stringify an input record compactly for memory. Caps each value at
 * 200 chars so the memory stays scannable. Paths and short args fit
 * fine; large bodies (e.g. fs-write body) get truncated.
 */
function summariseRecord(rec: Record<string, unknown>): string {
  const keys = Object.keys(rec);
  if (keys.length === 0) return '';
  return keys
    .map((k) => `${k}=${truncate(stringify(rec[k]), 200)}`)
    .join(', ');
}

/**
 * Stringify the action's returned data compactly. For object results
 * (e.g. shell-exec returning { stdout, exitCode, ... }), pick a few
 * informative fields. For string-ish results, truncate. Cap total
 * at 1200 chars so episodic memories stay digestible to the next
 * cycle's recall but still carry the substance of what was learned.
 */
function summariseActData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return JSON.stringify(truncate(data, 1200));
  if (typeof data !== 'object') return String(data);
  const o = data as Record<string, unknown>;
  // Recognised result shapes get a compact projection.
  if (typeof o.exitCode === 'number') {
    // shell-exec / claude-delegate
    return JSON.stringify({
      exitCode: o.exitCode,
      stdout: truncate(stringify(o.stdout ?? ''), 800),
      stderr: truncate(stringify(o.stderr ?? ''), 200),
      truncated: o.truncated ?? false,
    });
  }
  if (typeof o.text === 'string' && typeof o.bytes === 'number') {
    // fs-read-content
    return JSON.stringify({
      path: o.path,
      bytes: o.bytes,
      truncated: o.truncated ?? false,
      text: truncate(o.text as string, 800),
    });
  }
  if (typeof o.path === 'string' && typeof o.writtenAtMs === 'number') {
    // fs-write
    return JSON.stringify({
      path: o.path,
      bytes: o.bytes,
      mode: o.mode,
    });
  }
  if (Array.isArray(o.entries) && typeof o.fileCount === 'number') {
    // fs-read sense (listing) — keep first N entries
    const list = (o.entries as Array<{ path: string; bytes: number }>).slice(0, 12);
    return JSON.stringify({
      root: o.root,
      fileCount: o.fileCount,
      truncated: o.truncated ?? false,
      sample: list,
    });
  }
  return truncate(JSON.stringify(o), 1200);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max}]`;
}
