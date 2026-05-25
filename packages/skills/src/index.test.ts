import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  apply,
  composeSkillMd,
  defaultExtractor,
  keywordSelector,
  mint,
  parseSkillMd,
  SkillStore,
  surfaceActiveHandles,
} from './index.js';

function fresh() {
  const db = new Database(':memory:');
  // Skill table references plan_job/plan_item; tests pass synthetic
  // job_id/item_id strings, so disable FK enforcement here.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE plan_job (
      id TEXT PRIMARY KEY, opened_at_cycle INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
      closed_at_cycle INTEGER, closed_at_ms INTEGER, why TEXT NOT NULL
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES plan_job(id),
      ordinal INTEGER NOT NULL, description TEXT NOT NULL,
      state TEXT NOT NULL, iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT
    );
    CREATE TABLE skill (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      body_rpp TEXT NOT NULL,
      abstraction TEXT NOT NULL CHECK (abstraction IN ('specific','generic')),
      minted_at_cycle INTEGER NOT NULL,
      source_job_id TEXT REFERENCES plan_job(id),
      source_item_id TEXT REFERENCES plan_item(id),
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
      UNIQUE (name, abstraction)
    );
  `);
  return db;
}

/* ============================== SKILL.md ============================== */

describe('SKILL.md format', () => {
  it('round-trips compose → parse', () => {
    const text = composeSkillMd({
      frontmatter: {
        name: 'do-x',
        description: 'How to do x when y',
        abstraction: 'specific',
        minted_at_cycle: 42,
      },
      body: 'BEHAVIOR Apply { body }\n',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.name).toBe('do-x');
    expect(parsed.frontmatter.abstraction).toBe('specific');
    expect(parsed.frontmatter.minted_at_cycle).toBe(42);
    expect(parsed.body).toContain('BEHAVIOR Apply');
  });

  it('rejects malformed frontmatter', () => {
    expect(() => parseSkillMd('no delimiters')).toThrow(/missing frontmatter/);
    expect(() => parseSkillMd('---\nname: a\n---\n')).toThrow(/missing frontmatter field/);
  });
});

/* ============================== Mint (T213) ============================== */

describe('mint — extract 2 skills per passed item (T213 / intent §13)', () => {
  it('produces one specific and one generic skill per passed item', () => {
    const store = new SkillStore(fresh());
    const out = mint(
      store,
      [
        {
          item_id: 'i1',
          description: 'catalogue the reading queue',
          completion_check: '{"hooks":[{"name":"always_pass"}]}',
          job_id: 'j1',
        },
      ],
      { cycle: 10 },
    );
    expect(out.minted).toHaveLength(2);
    expect(out.minted.some((m) => m.name.endsWith('-specific'))).toBe(true);
    expect(out.minted.some((m) => m.name.endsWith('-generic'))).toBe(true);
    expect(store.size()).toBe(2);
  });

  it('skills are minted as inactive (proposed) by default', () => {
    const store = new SkillStore(fresh());
    mint(
      store,
      [{ item_id: 'i', description: 'x', completion_check: '{"hooks":[]}', job_id: 'j' }],
      { cycle: 1 },
    );
    expect(store.active()).toHaveLength(0);
  });

  it('zero passed items → zero skills', () => {
    const store = new SkillStore(fresh());
    const out = mint(store, [], { cycle: 1 });
    expect(out.minted).toHaveLength(0);
  });

  it('a deferred-item-only job mints nothing (caller passes only passed items)', () => {
    const store = new SkillStore(fresh());
    // The caller's responsibility — mint only sees passedItems.
    const out = mint(store, [], { cycle: 1 });
    expect(out.minted).toHaveLength(0);
  });

  it('extractor is pluggable', () => {
    const store = new SkillStore(fresh());
    const calls: string[] = [];
    const out = mint(
      store,
      [{ item_id: 'i', description: 'x', completion_check: '{}', job_id: 'j' }],
      { cycle: 1 },
      (item) => {
        calls.push(item.item_id);
        return [
          {
            frontmatter: {
              name: 'custom',
              description: 'd',
              abstraction: 'specific',
              minted_at_cycle: 1,
            },
            body: 'b',
          },
        ];
      },
    );
    expect(calls).toEqual(['i']);
    expect(out.minted).toHaveLength(1);
  });
});

/* ============================== Recall (T214) ============================== */

describe('skill recall — handle-then-body (T214)', () => {
  let store: SkillStore;

  beforeEach(() => {
    store = new SkillStore(fresh());
    mint(
      store,
      [
        { item_id: 'i1', description: 'catalogue reading queue', completion_check: '{}', job_id: 'j1' },
        { item_id: 'i2', description: 'send a status update email', completion_check: '{}', job_id: 'j1' },
      ],
      { cycle: 1 },
      defaultExtractor,
    );
    // Activate them.
    for (const s of store.all()) store.activate(s.id);
  });

  it('surfaceActiveHandles returns active skills as lightweight handles', () => {
    const handles = surfaceActiveHandles(store);
    expect(handles.length).toBeGreaterThan(0);
    for (const h of handles) {
      expect(h).toHaveProperty('name');
      expect(h).toHaveProperty('description');
      expect(h).not.toHaveProperty('body_rpp');
    }
  });

  it('keywordSelector picks skills whose description matches the query', () => {
    const handles = surfaceActiveHandles(store);
    const picked = keywordSelector(handles, 'email status', 5);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked[0]?.description.toLowerCase()).toMatch(/(email|status)/);
  });

  it('apply loads the R++ body only when called', () => {
    const handles = surfaceActiveHandles(store);
    const target = handles[0]!;
    const body = apply(store, target.id);
    expect(body).not.toBeNull();
    expect(body?.body_rpp).toContain('BEHAVIOR');
  });

  it('only ACTIVE skills surface in recall', () => {
    for (const s of store.all()) store.deactivate(s.id);
    expect(surfaceActiveHandles(store)).toEqual([]);
  });
});
