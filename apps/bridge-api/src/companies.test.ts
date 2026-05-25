import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretStore } from './secret-store.js';
import { buildServer } from './server.js';

const PREBUILT_DIR = join(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  'prebuilt',
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runcor-companies-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function makeApp() {
  const built = await buildServer({
    dataDir: join(dir, 'lattices'),
    secrets: new SecretStore({ path: join(dir, 'secrets.json') }),
    prebuiltDir: PREBUILT_DIR,
  });
  await built.app.ready();
  return built;
}

/* ============================== T288 ============================== */

describe('GET /api/bundles (T288)', () => {
  it('returns the prebuilt role bundles (ceo / cfo / marketing / sales / software-engineer)', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/bundles' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<{ id: string }>;
    const ids = body.map((b) => b.id).sort();
    expect(ids).toEqual(['ceo', 'cfo', 'marketing', 'sales', 'software-engineer']);
    await supervisor.closeAll();
    await app.close();
  });
});

/* ============================== T287 + T298 ============================== */

describe('POST /api/companies — bundle-based instantiation (T287, T298)', () => {
  it('instantiates each member from its bundle and seeds identity + semantic memory', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: {
        members: [{ bundle_id: 'ceo' }, { bundle_id: 'cfo' }, { bundle_id: 'sales' }],
      },
    });
    expect(r.statusCode).toBe(201);
    const out = r.json() as Array<{ lattice_id: string; bundle_id: string }>;
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.bundle_id).sort()).toEqual(['ceo', 'cfo', 'sales']);

    // Each member should have seeded memory rows from its bundle.
    for (const member of out) {
      const rec = supervisor.get(member.lattice_id)!;
      const db = rec.lattice.dbHandle();
      const idCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_identity`).get() as { n: number }).n;
      const semCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_semantic`).get() as { n: number }).n;
      expect(idCount).toBeGreaterThan(0);
      expect(semCount).toBeGreaterThan(0);
    }
    await supervisor.closeAll();
    await app.close();
  });

  it('respects autonomy + dialecticDepth from each bundle defaults', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: { members: [{ bundle_id: 'cfo' }] },
    });
    const out = r.json() as Array<{ lattice_id: string }>;
    const cfo = supervisor.get(out[0]!.lattice_id)!;
    expect(cfo.lattice.autonomy).toBe('low'); // CFO is risk-averse
    expect(cfo.lattice.decider.name).toBe('dialectic'); // depth=1 → dialectic
    await supervisor.closeAll();
    await app.close();
  });

  it('respects seed_prompt_override per member', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: {
        members: [
          {
            bundle_id: 'ceo',
            seed_prompt_override: 'I am the CEO of a custom override company.',
          },
        ],
      },
    });
    const out = r.json() as Array<{ lattice_id: string }>;
    const rec = supervisor.get(out[0]!.lattice_id)!;
    expect(rec.lattice.identity.composed_body).toContain('custom override');
    await supervisor.closeAll();
    await app.close();
  });

  it('returns 400 with details when a bundle_id is unknown', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: { members: [{ bundle_id: 'ceo' }, { bundle_id: 'nope-not-a-role' }] },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: { code: string; details?: { rejections?: { bundle_id: string }[] } } };
    expect(body.error.code).toBe('unknown_bundles');
    expect(body.error.details?.rejections?.[0]?.bundle_id).toBe('nope-not-a-role');
    await supervisor.closeAll();
    await app.close();
  });
});

/* ============================== T289 ============================== */

describe('No shared memory (T289 / FR-044 / Principle XIV)', () => {
  it('each company member owns its own SQLite file; they do not share rows', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: { members: [{ bundle_id: 'ceo' }, { bundle_id: 'cfo' }] },
    });
    const out = r.json() as Array<{ lattice_id: string; bundle_id: string }>;
    const ceo = supervisor.get(out.find((o) => o.bundle_id === 'ceo')!.lattice_id)!;
    const cfo = supervisor.get(out.find((o) => o.bundle_id === 'cfo')!.lattice_id)!;
    expect(ceo.sqlitePath).not.toBe(cfo.sqlitePath);

    // CEO's identity rows do not appear in CFO's identity table.
    const ceoIdRows = ceo.lattice
      .dbHandle()
      .prepare(`SELECT body FROM memory_identity`)
      .all() as Array<{ body: string }>;
    const cfoIdRows = cfo.lattice
      .dbHandle()
      .prepare(`SELECT body FROM memory_identity`)
      .all() as Array<{ body: string }>;
    const ceoBodies = new Set(ceoIdRows.map((r) => r.body));
    for (const row of cfoIdRows) {
      // CFO has its OWN identity rows; no overlap with CEO's.
      expect(ceoBodies.has(row.body)).toBe(false);
    }
    await supervisor.closeAll();
    await app.close();
  });
});
