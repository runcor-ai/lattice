import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { GoalsStore } from './index.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goal (
      id TEXT PRIMARY KEY, body TEXT NOT NULL,
      proposed_at_cycle INTEGER NOT NULL,
      parent_id TEXT REFERENCES goal(id),
      state TEXT NOT NULL CHECK (state IN ('proposed','active','satisfied','abandoned')),
      why TEXT NOT NULL CHECK (length(why) > 0)
    );
  `);
  return db;
}

describe('GoalsStore (T210)', () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore(fresh());
  });

  it('propose() inserts at state=proposed and requires why', () => {
    const g = store.propose({ body: 'help me read', cycle: 1, why: 'operator request' });
    expect(g.state).toBe('proposed');
    expect(() =>
      store.propose({ body: 'no why', cycle: 1, why: '' }),
    ).toThrow(/why/);
  });

  it('state transitions: activate, satisfy, abandon', () => {
    const g = store.propose({ body: 'g', cycle: 1, why: 'why' });
    store.activate(g.id);
    expect(store.get(g.id)?.state).toBe('active');
    store.satisfy(g.id);
    expect(store.get(g.id)?.state).toBe('satisfied');

    const g2 = store.propose({ body: 'g2', cycle: 2, why: 'why' });
    store.abandon(g2.id);
    expect(store.get(g2.id)?.state).toBe('abandoned');
  });

  it('active() returns proposed + active only', () => {
    const a = store.propose({ body: 'a', cycle: 1, why: 'y' });
    const b = store.propose({ body: 'b', cycle: 2, why: 'y' });
    store.activate(a.id);
    store.satisfy(b.id);
    const _c = store.propose({ body: 'c', cycle: 3, why: 'y' });

    const names = store.active().map((g) => g.body);
    expect(names).toContain('a');
    expect(names).toContain('c');
    expect(names).not.toContain('b');
  });

  it('counts() returns a per-state summary', () => {
    const g1 = store.propose({ body: 'a', cycle: 1, why: 'y' });
    const g2 = store.propose({ body: 'b', cycle: 1, why: 'y' });
    store.activate(g1.id);
    store.satisfy(g2.id);
    const counts = store.counts();
    expect(counts.active).toBe(1);
    expect(counts.satisfied).toBe(1);
    expect(counts.proposed).toBe(0);
  });

  it('parent_id is preserved', () => {
    const parent = store.propose({ body: 'big', cycle: 1, why: 'y' });
    const child = store.propose({ body: 'small', cycle: 2, why: 'y', parentId: parent.id });
    expect(child.parent_id).toBe(parent.id);
  });
});
