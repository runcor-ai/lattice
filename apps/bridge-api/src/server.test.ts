import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InspectResponse, InstantiateResponse, RosterRow } from '@runcor/bridge-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretStore } from './secret-store.js';
import { buildServer } from './server.js';

// Resolve repo-root /prebuilt/ regardless of cwd the test runner is launched in.
const PREBUILT_DIR = join(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  'prebuilt',
);

let dir: string;
let secretsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runcor-bridge-'));
  secretsPath = join(dir, 'secrets.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function makeApp() {
  const built = await buildServer({
    dataDir: join(dir, 'lattices'),
    secrets: new SecretStore({ path: secretsPath }),
    prebuiltDir: PREBUILT_DIR,
  });
  await built.app.ready();
  return built;
}

const VALID_INSTANTIATE = {
  name: 'test-lattice',
  identity_seed: 'I am a test lattice.',
  model_backend: { kind: 'stub' },
};

/* -------------------- Health -------------------- */

describe('GET /api/health', () => {
  it('returns { ok: true }', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Instantiate -------------------- */

describe('POST /api/lattices', () => {
  it('returns 201 + lattice_id + pids on valid body', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as InstantiateResponse;
    expect(body.lattice_id).toBeTruthy();
    expect(body.trace_stream_url).toContain(body.lattice_id);
    expect(body.pids.fast).toBeGreaterThan(0);
    await supervisor.closeAll();
    await app.close();
  });

  it('returns 400 on missing identity_seed', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: { name: 'x', model_backend: { kind: 'stub' } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_request');
    await supervisor.closeAll();
    await app.close();
  });

  it('returns 400 on unknown backend kind', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: { ...VALID_INSTANTIATE, model_backend: { kind: 'nonsense' } },
    });
    expect(r.statusCode).toBe(400);
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Roster + inspect -------------------- */

describe('GET /api/lattices (roster) + GET /api/lattices/:id (inspect)', () => {
  it('roster lists the lattice; inspect returns identity + memory counts', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const created = create.json() as InstantiateResponse;

    // Roster
    const roster = await app.inject({ method: 'GET', url: '/api/lattices' });
    expect(roster.statusCode).toBe(200);
    const rows = roster.json() as RosterRow[];
    expect(rows.some((r) => r.lattice_id === created.lattice_id)).toBe(true);

    // Inspect
    const inspect = await app.inject({
      method: 'GET',
      url: `/api/lattices/${created.lattice_id}`,
    });
    expect(inspect.statusCode).toBe(200);
    const body = inspect.json() as InspectResponse;
    expect(body.identity.composed_body).toBe('I am a test lattice.');
    expect(body.memory_summary.episodic_count).toBeGreaterThanOrEqual(0);

    await supervisor.closeAll();
    await app.close();
  });

  it('returns 404 for unknown lattice', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/lattices/no-such-id' });
    expect(r.statusCode).toBe(404);
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Trace -------------------- */

describe('GET /api/lattices/:id/trace', () => {
  it('returns the trace entries; honors kind filter', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const created = create.json() as InstantiateResponse;

    // Let the lattice tick a few cycles.
    await new Promise((r) => setTimeout(r, 100));

    const all = await app.inject({
      method: 'GET',
      url: `/api/lattices/${created.lattice_id}/trace?limit=50`,
    });
    expect(all.statusCode).toBe(200);
    const entries = all.json() as Array<{ kind: string }>;
    expect(entries.length).toBeGreaterThan(0);

    const phaseOnly = await app.inject({
      method: 'GET',
      url: `/api/lattices/${created.lattice_id}/trace?kind=phase&limit=50`,
    });
    const phaseEntries = phaseOnly.json() as Array<{ kind: string }>;
    expect(phaseEntries.every((e) => e.kind === 'phase')).toBe(true);

    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Dials -------------------- */

describe('PATCH /api/lattices/:id/dials', () => {
  it('autonomy update lands on the lattice', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const created = create.json() as InstantiateResponse;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/lattices/${created.lattice_id}/dials`,
      payload: { dials: { autonomy: 'high' }, why: 'operator chose high autonomy' },
    });
    expect(r.statusCode).toBe(200);
    const after = supervisor.get(created.lattice_id);
    expect(after?.lattice.autonomy).toBe('high');
    await supervisor.closeAll();
    await app.close();
  });

  it('400 on missing why', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const created = create.json() as InstantiateResponse;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/lattices/${created.lattice_id}/dials`,
      payload: { dials: { autonomy: 'high' } },
    });
    expect(r.statusCode).toBe(400);
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Lifecycle actions -------------------- */

describe('POST /api/lattices/:id/actions/:action', () => {
  it('pause + resume work', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const id = (create.json() as InstantiateResponse).lattice_id;

    const pause = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/actions/pause`,
    });
    expect(pause.statusCode).toBe(200);
    expect(supervisor.get(id)?.status).toBe('paused');

    const resume = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/actions/resume`,
    });
    expect(resume.statusCode).toBe(200);
    expect(supervisor.get(id)?.status).toBe('running');

    await supervisor.closeAll();
    await app.close();
  });

  it('400 for unknown action', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const id = (create.json() as InstantiateResponse).lattice_id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/actions/nope`,
    });
    expect(r.statusCode).toBe(400);
    await supervisor.closeAll();
    await app.close();
  });

  it('swap-backend with valid spec succeeds', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const id = (create.json() as InstantiateResponse).lattice_id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/actions/swap-backend`,
      payload: { model_backend: { kind: 'stub' } },
    });
    expect(r.statusCode).toBe(200);
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Jobs -------------------- */

describe('POST /api/lattices/:id/jobs', () => {
  it('hands a job to the lattice; persists in plan_job', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: VALID_INSTANTIATE,
    });
    const id = (create.json() as InstantiateResponse).lattice_id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: {
        title: 'test job',
        body: '',
        why: 'because the operator said so',
        items: [
          {
            description: 'first item',
            completion_check: JSON.stringify({ hooks: [{ name: 'always_pass' }] }),
          },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { job_id: string };
    expect(typeof body.job_id).toBe('string');

    // Verify the job persisted.
    const rec = supervisor.get(id);
    const count = rec!
      .lattice.dbHandle()
      .prepare('SELECT COUNT(*) AS n FROM plan_job')
      .get() as { n: number };
    expect(count.n).toBe(1);

    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Companies (slice 14 shape only) -------------------- */

describe('POST /api/companies', () => {
  it('instantiates each member with a synthetic seed prompt (slice 14 placeholder)', async () => {
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
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Secrets -------------------- */

describe('Secrets', () => {
  it('returns redacted summary; never raw keys', async () => {
    const { app, supervisor, secrets } = await makeApp();
    secrets.save({ anthropicApiKey: 'sk-real-secret-key' });
    const r = await app.inject({ method: 'GET', url: '/api/secrets' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { hasAnthropicKey: boolean; hasOpenaiKey: boolean };
    expect(body.hasAnthropicKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-real-secret-key');
    await supervisor.closeAll();
    await app.close();
  });
});
