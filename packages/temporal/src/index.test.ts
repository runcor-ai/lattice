import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { CommitmentsStore, pressureBand } from './index.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plan_job (
      id TEXT PRIMARY KEY, opened_at_cycle INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL, closed_at_cycle INTEGER, closed_at_ms INTEGER, why TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE commitment (
      id TEXT PRIMARY KEY, description TEXT NOT NULL,
      deadline_cycle INTEGER NOT NULL,
      pressure_band TEXT NOT NULL CHECK (pressure_band IN ('green','yellow','orange','red')),
      job_id TEXT REFERENCES plan_job(id), source TEXT NOT NULL
    );
  `);
  return db;
}

describe('pressureBand (T212)', () => {
  it('green when >= 50% horizon remains', () => {
    expect(pressureBand(50, 100, 100)).toBe('green');
    expect(pressureBand(0, 100, 100)).toBe('green');
  });

  it('yellow when 25..50% remains', () => {
    expect(pressureBand(60, 100, 100)).toBe('yellow');
    expect(pressureBand(74, 100, 100)).toBe('yellow');
  });

  it('orange when 0..25% remains', () => {
    expect(pressureBand(80, 100, 100)).toBe('orange');
    expect(pressureBand(99, 100, 100)).toBe('orange');
  });

  it('red when past the deadline', () => {
    expect(pressureBand(101, 100, 100)).toBe('red');
    expect(pressureBand(500, 100, 100)).toBe('red');
  });
});

describe('CommitmentsStore', () => {
  let store: CommitmentsStore;

  beforeEach(() => {
    store = new CommitmentsStore(fresh());
  });

  it('add + list + get', () => {
    const c = store.add({
      description: 'ship the spec',
      deadline_cycle: 100,
      source: 'operator',
    });
    expect(store.all()).toHaveLength(1);
    expect(store.get(c.id)?.description).toBe('ship the spec');
  });

  it('refreshBands moves bands as the cycle advances', () => {
    store.add({ description: 'd', deadline_cycle: 100, source: 's' });
    const moved1 = store.refreshBands(60);
    expect(moved1).toHaveLength(1);
    expect(moved1[0]?.pressure_band).toBe('yellow');

    const moved2 = store.refreshBands(85);
    expect(moved2).toHaveLength(1);
    expect(moved2[0]?.pressure_band).toBe('orange');

    const moved3 = store.refreshBands(110);
    expect(moved3[0]?.pressure_band).toBe('red');
  });
});
