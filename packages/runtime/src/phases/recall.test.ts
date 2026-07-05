import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { migrate } from '../migrations.js';
import { RuntimeMemoryAdapter } from '../sqlite-memory.js';

/**
 * BUG-2 regression: recall must REINFORCE the pulled window — increment access_count (f) and set
 * last_access_ms on each surfaced entry. Prior to the fix the recall stub only read (recentEpisodic),
 * so f stayed 0 and last_access_ms == written_at_ms on every entry, collapsing decay M to 0.
 */
describe('recall reinforcement — BUG-2 (access_count + last_access on the pulled window)', () => {
  let db: Database.Database;
  let mem: RuntimeMemoryAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db as never);
    mem = new RuntimeMemoryAdapter(db);
    // three episodic memories, oldest -> newest
    for (let i = 0; i < 3; i++) {
      mem.write(
        { system: 'episodic', body: `m${i}`, why: 'because', admissionTag: 'cycle-outcome' },
        { cycle: i + 1, at_ms: 1000 + i },
      );
    }
  });

  function rows() {
    return db
      .prepare(`SELECT body, access_count, last_access_ms, written_at_ms FROM memory_episodic ORDER BY written_at_ms`)
      .all() as { body: string; access_count: number; last_access_ms: number; written_at_ms: number }[];
  }

  it('starts with f=0 and last_access==written (the observed bug state)', () => {
    for (const r of rows()) {
      expect(r.access_count).toBe(0);
      expect(r.last_access_ms).toBe(r.written_at_ms);
    }
  });

  it('reinforceRecalled increments f and sets last_access on the pulled window only', () => {
    const AT = 5000;
    const out = mem.reinforceRecalled(2, AT); // pulls the 2 most-recent (m2, m1)
    expect(out.map((m) => m.body).sort()).toEqual(['m1', 'm2']);

    const r = rows();
    const m0 = r.find((x) => x.body === 'm0')!;
    const m1 = r.find((x) => x.body === 'm1')!;
    const m2 = r.find((x) => x.body === 'm2')!;

    // pulled window reinforced
    expect(m1.access_count).toBe(1);
    expect(m2.access_count).toBe(1);
    expect(m1.last_access_ms).toBe(AT);
    expect(m2.last_access_ms).toBe(AT);
    // the untouched oldest entry is unchanged
    expect(m0.access_count).toBe(0);
    expect(m0.last_access_ms).toBe(m0.written_at_ms);
  });

  it('repeated recalls accumulate f (reinforcement climbs on reused memories)', () => {
    mem.reinforceRecalled(2, 5000);
    mem.reinforceRecalled(2, 6000);
    const r = rows();
    expect(r.find((x) => x.body === 'm2')!.access_count).toBe(2);
    expect(r.find((x) => x.body === 'm2')!.last_access_ms).toBe(6000);
  });
});
