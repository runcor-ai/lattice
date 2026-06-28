import { randomUUID } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { closeDb, openDb, type Db } from './db.js';
import { migrate } from './migrations.js';
import { renderWatchdogCorrections } from './watchdog-corrections.js';

/**
 * Three-tier watchdog Step 1 — recall render.
 *
 * The header is the load-bearing piece: "corrections from last review (each
 * cites the object that proves it)" — showing, not telling. Tier-3 surfaces
 * will read in symmetry ("no authoritative object; your dialectic decides")
 * once they land in a separate table.
 */

function fresh(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function writeFinding(
  db: Db,
  args: {
    rule: string;
    body: string;
    sourceRef: string;
    cycle: number;
    at_ms: number;
    resolved_at_ms?: number | null;
    resolved_at_cycle?: number | null;
  },
): void {
  const semanticId = randomUUID();
  db.prepare(
    `INSERT INTO memory_semantic
       (id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, 'derived', ?)`,
  ).run(semanticId, args.at_ms, args.at_ms, args.cycle, args.body, 'test', args.sourceRef);
  db.prepare(
    `INSERT INTO memory_semantic_correction
       (id, semantic_id, cycle, was, now_is, rule, at_ms,
        resolved_at_ms, resolved_at_cycle)
     VALUES (?, ?, ?, 'stated need; no usage in window', ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    semanticId,
    args.cycle,
    args.body.replace(/^\[watchdog:[^\]]+\]\s*/, ''),
    args.rule,
    args.at_ms,
    args.resolved_at_ms ?? null,
    args.resolved_at_cycle ?? null,
  );
}

describe('renderWatchdogCorrections — recall section', () => {
  it('returns empty when no findings exist', () => {
    const db = fresh();
    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');
    closeDb(db);
  });

  it('renders the SHOWING header verbatim with each finding citing its proof', () => {
    const db = fresh();
    writeFinding(db, {
      rule: 'watchdog:tool_unused',
      body: '[watchdog:tool_unused] tool "foo" appears in stated need but has not been used in last 100 cycles',
      sourceRef: 'capability=foo; window=100',
      cycle: 50,
      at_ms: 1_000,
    });

    const out = renderWatchdogCorrections(db, 6, 1500);
    expect(out.split('\n')[0]).toBe(
      'corrections from last review (each cites the object that proves it):',
    );
    expect(out).toContain('[watchdog:tool_unused]');
    expect(out).toContain('proof: capability=foo; window=100');
    closeDb(db);
  });

  it('excludes resolved findings', () => {
    const db = fresh();
    writeFinding(db, {
      rule: 'watchdog:tool_unused',
      body: '[watchdog:tool_unused] tool "foo" …',
      sourceRef: 'capability=foo; window=100',
      cycle: 50,
      at_ms: 1_000,
      resolved_at_ms: 2_000,
      resolved_at_cycle: 60,
    });

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');
    closeDb(db);
  });

  it('caps by count, oldest-first', () => {
    const db = fresh();
    for (let i = 0; i < 20; i++) {
      writeFinding(db, {
        rule: 'watchdog:tool_unused',
        body: `[watchdog:tool_unused] tool "t${i}" stated; unused`,
        sourceRef: `capability=t${i}; window=100`,
        cycle: 100 + i, // monotonic — oldest first
        at_ms: 1_000 + i,
      });
    }
    const out = renderWatchdogCorrections(db, 6, 99_999);
    // Header + 6 lines.
    expect(out.split('\n')).toHaveLength(7);
    // Oldest-first: t0 must appear, t6+ must not.
    expect(out).toContain('"t0"');
    expect(out).toContain('"t5"');
    expect(out).not.toContain('"t6"');
    closeDb(db);
  });

  it('respects byte budget — stops adding lines that would exceed it', () => {
    const db = fresh();
    // A finding whose rendered line is ~95 bytes. Budget = 200 → header + 1
    // line fit; the second line would push past 200 and is dropped.
    writeFinding(db, {
      rule: 'watchdog:tool_unused',
      body: '[watchdog:tool_unused] tool "foo" appears in stated need but has not been used',
      sourceRef: 'capability=foo; window=100',
      cycle: 50,
      at_ms: 1_000,
    });
    writeFinding(db, {
      rule: 'watchdog:tool_unused',
      body: '[watchdog:tool_unused] tool "bar" appears in stated need but has not been used',
      sourceRef: 'capability=bar; window=100',
      cycle: 51,
      at_ms: 1_001,
    });

    const tight = renderWatchdogCorrections(db, 6, 130);
    // Header + first line fit; second line is dropped by byte budget.
    expect(tight.split('\n').length).toBe(2);
    expect(tight).toContain('"foo"');
    expect(tight).not.toContain('"bar"');
    closeDb(db);
  });

  it('does NOT render non-watchdog drift rows (off_purpose, etc.)', () => {
    const db = fresh();
    // Non-watchdog drift row — should NOT enter the corrections section.
    db.prepare(
      `INSERT INTO memory_semantic
         (id, written_at_ms, last_validated_ms, cycle, body, why, source_kind, source_ref)
       VALUES (?, 1, 1, 50, '[drift:off_purpose] 12 substrate blocks on law=memory',
               'slow-clock drift review @ cycle 50', 'derived', 'law=memory')`,
    ).run(randomUUID());
    // No audit row at all — off_purpose still writes single-row today.

    expect(renderWatchdogCorrections(db, 6, 1500)).toBe('');
    closeDb(db);
  });
});
