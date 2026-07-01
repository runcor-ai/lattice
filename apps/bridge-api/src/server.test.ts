import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    // Item 4 appends a planning disposition to the operator's seed.
    expect(body.identity.composed_body.startsWith('I am a test lattice.')).toBe(true);
    expect(body.identity.composed_body).toContain('checklist plan');
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

  it('attaches the row id and windows by before_cycle (visualizer read)', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE });
    const created = create.json() as InstantiateResponse;

    // Let the lattice tick enough to span several cycles.
    await new Promise((r) => setTimeout(r, 150));

    const all = await app.inject({
      method: 'GET',
      url: `/api/lattices/${created.lattice_id}/trace?limit=500`,
    });
    const rows = all.json() as Array<{ id: number; cycle: number; kind: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Every row carries a stable numeric id (attached by the read API) and
    // the flat envelope fields (cycle/kind live inside body).
    expect(rows.every((r) => typeof r.id === 'number' && typeof r.cycle === 'number')).toBe(true);
    // ids are strictly increasing (ORDER BY id ASC) — stable ordering for the timeline.
    for (let i = 1; i < rows.length; i++) expect(rows[i].id).toBeGreaterThan(rows[i - 1].id);

    const maxCycle = Math.max(...rows.map((r) => r.cycle));
    if (maxCycle >= 1) {
      const windowed = await app.inject({
        method: 'GET',
        url: `/api/lattices/${created.lattice_id}/trace?before_cycle=${maxCycle}&limit=500`,
      });
      const wrows = windowed.json() as Array<{ cycle: number }>;
      expect(wrows.every((r) => r.cycle < maxCycle)).toBe(true);
    }

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

/* -------------------- Item 9 — pause on no open jobs -------------------- */

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

type MiniDb = { prepare(sql: string): { get(arg: string): unknown } };

/** Item 4 + 5 — every bridge-posted job now carries an auto-inserted
 * plan gate; once it passes, Item 5 chains the plan's checkboxes into
 * gated steps. Write a plan whose single step uses an always_pass gate so
 * the chained step passes immediately and the job can close. The gate's
 * absolute path is read from the system item. */
function satisfyPlanGate(db: MiniDb, jobId: string): void {
  const row = db
    .prepare("SELECT completion_check FROM plan_item WHERE job_id = ? AND source = 'system'")
    .get(jobId) as { completion_check: string } | undefined;
  if (!row) throw new Error('plan gate item not found');
  const spec = JSON.parse(row.completion_check) as { hooks: Array<{ name: string; args?: { path?: string } }> };
  const path = spec.hooks.find((h) => h.name === 'file_exists')?.args?.path;
  if (!path) throw new Error('plan gate has no file_exists path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# Plan\n\n- [ ] complete the work {{gate:always_pass}}\n${'x'.repeat(600)}`);
}

describe('Item 9 — pause-on-no-open-jobs dial', () => {
  async function instantiate(app: Awaited<ReturnType<typeof makeApp>>['app']): Promise<string> {
    const create = await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE });
    return (create.json() as InstantiateResponse).lattice_id;
  }
  function jobPayload(hook: 'always_pass' | 'always_fail') {
    return {
      title: 't',
      body: '',
      why: 'because the operator said so',
      items: [{ description: 'a', completion_check: JSON.stringify({ hooks: [{ name: hook }] }) }],
    };
  }
  async function postJob(
    app: Awaited<ReturnType<typeof makeApp>>['app'],
    id: string,
    hook: 'always_pass' | 'always_fail',
  ): Promise<string> {
    const r = await app.inject({ method: 'POST', url: `/api/lattices/${id}/jobs`, payload: jobPayload(hook) });
    return (r.json() as { job_id: string }).job_id;
  }
  // A plan-only job (no operator item): once its plan gate is satisfied and the
  // chained plan step passes, the job closes legitimately (closed_full) with no
  // operator attestation outstanding — the correct way to drive the entity to
  // "no open jobs". (An operator item would instead leave the job RESTING in
  // paused_awaiting_operator — see the rest-state test below. The old versions
  // of these tests used an operator item and only reached paused_no_jobs because
  // the no-progress ESCALATE breaker force-deferred it — the F1 bug now fixed.)
  async function postPlanJob(
    app: Awaited<ReturnType<typeof makeApp>>['app'],
    id: string,
  ): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: { title: 't', body: '', why: 'because the operator said so' },
    });
    return (r.json() as { job_id: string }).job_id;
  }
  // A job whose terminal item is a real operator_attested sign-off (the handler
  // forces source='operator'). After the plan gate clears, that item is the only
  // open work → the entity rests in paused_awaiting_operator (F1); only /attest
  // can close it.
  async function postAttestJob(
    app: Awaited<ReturnType<typeof makeApp>>['app'],
    id: string,
  ): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: {
        title: 't',
        body: '',
        why: 'because the operator said so',
        items: [
          { description: 'operator sign-off', completion_check: JSON.stringify({ hooks: [{ name: 'operator_attested', args: {} }] }) },
        ],
      },
    });
    return (r.json() as { job_id: string }).job_id;
  }

  it('auto-pauses (paused_no_jobs) once its only job closes', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    const jobId = await postPlanJob(app, id);
    satisfyPlanGate(supervisor.get(id)!.lattice.dbHandle() as MiniDb, jobId);

    const reached = await waitFor(() => supervisor.get(id)?.status === 'paused_no_jobs');
    expect(reached).toBe(true);

    const ops = supervisor.get(id)!.lattice.trace.filter((e) => e.kind === 'operator');
    expect(ops.some((e) => (e as { detail?: string }).detail === 'paused_no_jobs_remaining')).toBe(true);

    await supervisor.closeAll();
    await app.close();
  });

  it('handing a new job to an idle-paused lattice wakes it', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    const jobId = await postPlanJob(app, id);
    satisfyPlanGate(supervisor.get(id)!.lattice.dbHandle() as MiniDb, jobId);
    expect(await waitFor(() => supervisor.get(id)?.status === 'paused_no_jobs')).toBe(true);

    // A second job whose plan gate is NOT satisfied keeps the lattice running after wake.
    await postPlanJob(app, id);
    expect(await waitFor(() => supervisor.get(id)?.status === 'running')).toBe(true);

    const ops = supervisor.get(id)!.lattice.trace.filter((e) => e.kind === 'operator');
    expect(ops.some((e) => (e as { detail?: string }).detail === 'resumed_new_job_arrived')).toBe(true);

    await supervisor.closeAll();
    await app.close();
  });

  it('pauseOnNoOpenJobs=false keeps the lattice cycling even with no open jobs', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/lattices/${id}/dials`,
      payload: { dials: { pauseOnNoOpenJobs: false }, why: 'operator wants it always on' },
    });
    const jobId = await postJob(app, id, 'always_pass');
    satisfyPlanGate(supervisor.get(id)!.lattice.dbHandle() as MiniDb, jobId);

    // Give it time to run several cycles; with the dial off it must NOT idle-pause.
    await new Promise((r) => setTimeout(r, 250));
    expect(supervisor.get(id)?.status).toBe('running');

    await supervisor.closeAll();
    await app.close();
  });

  it('a lattice that never had a job keeps running (does not idle-pause)', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    await new Promise((r) => setTimeout(r, 200));
    expect(supervisor.get(id)?.status).toBe('running');
    await supervisor.closeAll();
    await app.close();
  });

  it('disabling the dial while idle-paused wakes the lattice', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    const jobId = await postPlanJob(app, id);
    satisfyPlanGate(supervisor.get(id)!.lattice.dbHandle() as MiniDb, jobId);
    expect(await waitFor(() => supervisor.get(id)?.status === 'paused_no_jobs')).toBe(true);

    await app.inject({
      method: 'PATCH',
      url: `/api/lattices/${id}/dials`,
      payload: { dials: { pauseOnNoOpenJobs: false }, why: 'operator disables idle-pause' },
    });
    expect(await waitFor(() => supervisor.get(id)?.status === 'running')).toBe(true);

    await supervisor.closeAll();
    await app.close();
  });

  it('an operator-only job rests as paused_awaiting_operator, then wakes to closed_full on attest', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiate(app);
    const jobId = await postAttestJob(app, id);
    satisfyPlanGate(supervisor.get(id)!.lattice.dbHandle() as MiniDb, jobId);

    // Plan gate clears and the chained plan step passes; the ONLY open item left is
    // the operator sign-off. The entity must REST (F1) — it must NOT churn the
    // no-progress breaker into force-deferring the operator item and idling.
    expect(await waitFor(() => supervisor.get(id)?.status === 'paused_awaiting_operator')).toBe(true);

    const db = supervisor.get(id)!.lattice.dbHandle() as MiniDb;
    const opId = (db.prepare("SELECT id FROM plan_item WHERE job_id = ? AND source = 'operator'").get(jobId) as { id: string }).id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/items/${opId}/attest`,
      payload: { operator_note: 'Reviewed. Approved.' },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { job_status?: string }).job_status).toBe('closed_full');

    // The attest wakes the resting entity; with its only job now closed it idles.
    expect(await waitFor(() => supervisor.get(id)?.status === 'paused_no_jobs')).toBe(true);

    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Item 4 — auto-append checklist plan gate -------------------- */

describe('Item 4 — auto-append checklist plan gate', () => {
  async function instantiatePaused(app: Awaited<ReturnType<typeof makeApp>>['app'], supervisor: Awaited<ReturnType<typeof makeApp>>['supervisor']): Promise<string> {
    const create = await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE });
    const id = (create.json() as InstantiateResponse).lattice_id;
    // Stop the cycle loop deterministically so manual checks don't race it.
    supervisor.pause(id);
    await supervisor.get(id)!.loopPromise;
    return id;
  }

  it('inserts a system plan-gate item at ordinal 0; operator items follow', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiatePaused(app, supervisor);

    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: {
        title: 't', body: '', why: 'operator asked',
        items: [{ description: 'real work', completion_check: JSON.stringify({ hooks: [{ name: 'always_pass' }] }) }],
      },
    });
    expect(r.statusCode).toBe(201);
    const jobId = (r.json() as { job_id: string }).job_id;

    const db = supervisor.get(id)!.lattice.dbHandle() as unknown as {
      prepare(sql: string): { all(arg: string): Array<{ ordinal: number; source: string; description: string; completion_check: string }> };
    };
    const items = db
      .prepare('SELECT ordinal, source, description, completion_check FROM plan_item WHERE job_id = ? ORDER BY ordinal ASC')
      .all(jobId);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ ordinal: 0, source: 'system' });
    expect(items[0]!.description).toContain('checklist plan');
    const gate = JSON.parse(items[0]!.completion_check) as { hooks: Array<{ name: string }> };
    expect(gate.hooks.map((h) => h.name)).toEqual(['file_exists', 'content_contains']);
    expect(items[1]).toMatchObject({ ordinal: 1, source: 'operator', description: 'real work' });

    await supervisor.closeAll();
    await app.close();
  });

  it('the plan gate blocks job close until a checkbox plan is written', async () => {
    const { app, supervisor } = await makeApp();
    const id = await instantiatePaused(app, supervisor);

    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: { title: 't', body: '', why: 'operator asked', items: [] },
    });
    const jobId = (r.json() as { job_id: string }).job_id;

    const db = supervisor.get(id)!.lattice.dbHandle();
    const { JobsService } = await import('@runcor/jobs');
    const jobs = new JobsService(db);
    const planItem = jobs.checklist.items(jobId)[0]!;
    expect(planItem.source).toBe('system');

    // No plan file → gate fails → job not_ready.
    expect((await jobs.attemptCheck(planItem.id, { cycle: 1 })).outcome).toBe('failed_iterating');
    expect(jobs.close({ jobId, cycle: 2, at_ms: 2, autonomy: 'high' }).result).toBe('not_ready');

    // Write a satisfying plan → gate passes AND Item 5 chains a step.
    satisfyPlanGate(db as unknown as MiniDb, jobId);
    expect((await jobs.attemptCheck(planItem.id, { cycle: 3 })).outcome).toBe('passed');

    // The chained plan_step now gates close — the job still cannot close.
    const step = jobs.checklist.items(jobId).find((i) => i.source === 'plan_step')!;
    expect(step).toBeDefined();
    expect(jobs.close({ jobId, cycle: 4, at_ms: 4, autonomy: 'high' }).result).toBe('not_ready');

    // Pass the chained step → now the job closes.
    expect((await jobs.attemptCheck(step.id, { cycle: 5 })).outcome).toBe('passed');
    expect(jobs.close({ jobId, cycle: 6, at_ms: 6, autonomy: 'high' }).result).toBe('closed');

    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Item 8 — lattice-authored items endpoint -------------------- */

describe('Item 8 — POST /api/lattices/:id/jobs/:job_id/items', () => {
  async function paused(app: Awaited<ReturnType<typeof makeApp>>['app'], supervisor: Awaited<ReturnType<typeof makeApp>>['supervisor']): Promise<string> {
    const create = await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE });
    const id = (create.json() as InstantiateResponse).lattice_id;
    supervisor.pause(id);
    await supervisor.get(id)!.loopPromise;
    return id;
  }
  async function postJob(app: Awaited<ReturnType<typeof makeApp>>['app'], id: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs`,
      payload: { title: 't', body: '', why: 'operator asked', items: [] },
    });
    return (r.json() as { job_id: string }).job_id;
  }
  const gate = { type: 'file_exists', args: { path: '/tmp/x' } };

  it('appends an item to an open job (201) with source=lattice_appended', async () => {
    const { app, supervisor } = await makeApp();
    const id = await paused(app, supervisor);
    const jobId = await postJob(app, id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs/${jobId}/items`,
      payload: { description: 'extra step', gate },
    });
    expect(r.statusCode).toBe(201);
    const itemId = (r.json() as { item_id: string }).item_id;

    const db = supervisor.get(id)!.lattice.dbHandle() as unknown as MiniDb;
    const row = db.prepare('SELECT source, description FROM plan_item WHERE id = ?').get(itemId) as { source: string; description: string };
    expect(row.source).toBe('lattice_appended');
    expect(row.description).toBe('extra step');

    await supervisor.closeAll();
    await app.close();
  });

  it('rejects an invalid gate type (400)', async () => {
    const { app, supervisor } = await makeApp();
    const id = await paused(app, supervisor);
    const jobId = await postJob(app, id);
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs/${jobId}/items`,
      payload: { description: 'x', gate: { type: 'definitely_not_a_hook' } },
    });
    expect(r.statusCode).toBe(400);
    await supervisor.closeAll();
    await app.close();
  });

  it('rejects a non-existent blocker (400)', async () => {
    const { app, supervisor } = await makeApp();
    const id = await paused(app, supervisor);
    const jobId = await postJob(app, id);
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs/${jobId}/items`,
      payload: { description: 'x', gate, blocked_by: 'no-such-item' },
    });
    expect(r.statusCode).toBe(400);
    await supervisor.closeAll();
    await app.close();
  });

  it('returns 404 for an unknown lattice', async () => {
    const { app, supervisor } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/no-such/jobs/no-job/items`,
      payload: { description: 'x', gate },
    });
    expect(r.statusCode).toBe(404);
    await supervisor.closeAll();
    await app.close();
  });

  it('rejects append to a closed job (409)', async () => {
    const { app, supervisor } = await makeApp();
    const id = await paused(app, supervisor);
    // A bare job opened + closed directly (no plan gate, no items).
    const { JobsService } = await import('@runcor/jobs');
    const jobs = new JobsService(supervisor.get(id)!.lattice.dbHandle());
    const job = jobs.openJob({ title: 'bare', source: 'operator', why: 'y', cycle: 0, at_ms: 0 });
    expect(jobs.close({ jobId: job.id, cycle: 1, at_ms: 1, autonomy: 'high' }).result).toBe('closed');

    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/jobs/${job.id}/items`,
      payload: { description: 'x', gate },
    });
    expect(r.statusCode).toBe(409);
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Item 11 — persona bundle composition -------------------- */

describe('Item 11 — persona bundle composition', () => {
  it('composes Layer 1 from declared bundles, in order, with the seed appended last', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: { ...VALID_INSTANTIATE, persona_bundles: ['software-engineer', 'public-services-applicant-facing'] },
    });
    const id = (create.json() as InstantiateResponse).lattice_id;

    const inspect = await app.inject({ method: 'GET', url: `/api/lattices/${id}` });
    const body = (inspect.json() as InspectResponse).identity.composed_body;

    expect(body).toContain('I am a software engineer');
    expect(body).toContain('I serve applicants to a public service');
    // declared order: software-engineer before public-services
    expect(body.indexOf('software engineer')).toBeLessThan(body.indexOf('applicants'));
    // the operator's inline seed is appended last (refines the shared bundles)
    expect(body).toContain('I am a test lattice.');

    await supervisor.closeAll();
    await app.close();
  });

  it('legacy: no persona_bundles → Layer 1 is the seed alone (+ dispositions)', async () => {
    const { app, supervisor } = await makeApp();
    const create = await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE });
    const id = (create.json() as InstantiateResponse).lattice_id;
    const inspect = await app.inject({ method: 'GET', url: `/api/lattices/${id}` });
    const body = (inspect.json() as InspectResponse).identity.composed_body;
    expect(body.startsWith('I am a test lattice.')).toBe(true);
    expect(body).not.toContain('I am a software engineer');
    await supervisor.closeAll();
    await app.close();
  });
});

/* -------------------- Item 16 — director tool surface -------------------- */

describe('Item 16 — director tool surface', () => {
  it('a director lattice has NO write tool; a non-director gets the workspace write', async () => {
    const { app, supervisor } = await makeApp();
    const manifest = [
      { kind: 'fs-write', name: 'app-write', config: { outDir: join(dir, 'wd') } },
      { kind: 'shell-exec', name: 'sh', config: { cwd: dir } },
      { kind: 'fs-read', name: 'src', config: { root: dir } },
    ];

    const dir1 = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: { ...VALID_INSTANTIATE, name: 'director', director: true, tool_manifest: manifest },
    });
    const dId = (dir1.json() as InstantiateResponse).lattice_id;
    const dActions = supervisor.get(dId)!.lattice.actions.map((a) => a.name);
    // no file-write or execute tool, and no auto workspace write
    expect(dActions).not.toContain('app-write');
    expect(dActions).not.toContain('sh');
    expect(dActions).not.toContain('workspace');
    // read-only sense survives
    expect(supervisor.get(dId)!.lattice.senses.map((s) => s.name)).toContain('src');
    // persona reflects the posture
    const inspectD = await app.inject({ method: 'GET', url: `/api/lattices/${dId}` });
    expect((inspectD.json() as InspectResponse).identity.composed_body).toContain('director, not an executor');

    const exec = await app.inject({
      method: 'POST',
      url: '/api/lattices',
      payload: { ...VALID_INSTANTIATE, name: 'executor', tool_manifest: manifest },
    });
    const nId = (exec.json() as InstantiateResponse).lattice_id;
    const nActions = supervisor.get(nId)!.lattice.actions.map((a) => a.name);
    expect(nActions).toContain('app-write');
    expect(nActions).toContain('workspace');

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

/* -------------------- attest: close-on-attest (F3) + note-key (bonus) -------------------- */

describe('POST /api/lattices/:id/items/:item_id/attest', () => {
  // Stage a terminal job directly on the entity DB: a passed system contract item
  // + an open operator_attested item blocked_by it. (Driving a real lattice to the
  // halt is covered empirically on the 7110 bridge.)
  async function stageTerminalJob(supervisor: Awaited<ReturnType<typeof makeApp>>['supervisor'], id: string) {
    const { JobsService } = await import('@runcor/jobs');
    const db = supervisor.get(id)!.lattice.dbHandle();
    const jobs = new JobsService(db);
    const job = jobs.openJob({ title: 'restack', source: 'operator', why: 'terminal', cycle: 1, at_ms: 1 });
    const sys = jobs.addItem(job.id, {
      description: 'plan gate',
      spec: { hooks: [{ name: 'file_exists', args: { path: 'Z:/plan.md' } }] },
      source: 'system',
    });
    jobs.checklist.markPassed(sys.id, 1, true); // the sole non-operator contract item, passed
    const op = jobs.addItem(job.id, {
      description: 'operator sign-off',
      spec: { hooks: [{ name: 'operator_attested', args: {} }] },
      source: 'operator',
      blocked_by: sys.id,
    });
    return { jobId: job.id, opId: op.id, db };
  }

  it('attest → job closes closed_full synchronously (even stopped) and records operator_note', async () => {
    const { app, supervisor } = await makeApp();
    const id = ((await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE })).json() as InstantiateResponse).lattice_id;
    await supervisor.stop(id); // hard-stopped: exercises the synchronous-close path (no cycle will run)
    const { opId, db } = await stageTerminalJob(supervisor, id);

    const r = await app.inject({
      method: 'POST',
      url: `/api/lattices/${id}/items/${opId}/attest`,
      payload: { operator_note: 'Reviewed. Parity verified.' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { outcome: string; job_status?: string };
    expect(body.outcome).toBe('passed');
    expect(body.job_status).toBe('closed_full'); // F3: closed even though the entity is stopped

    const { JobsService } = await import('@runcor/jobs');
    expect(new JobsService(db).checklist.getItem(opId)?.state).toBe('passed');
    const note = (db.prepare('SELECT note FROM operator_attestation WHERE item_id = ?').get(opId) as { note: string }).note;
    expect(note).toContain('Parity verified'); // 4c: operator_note key lands non-empty

    await supervisor.closeAll();
    await app.close();
  });

  it('also accepts the `note` key', async () => {
    const { app, supervisor } = await makeApp();
    const id = ((await app.inject({ method: 'POST', url: '/api/lattices', payload: VALID_INSTANTIATE })).json() as InstantiateResponse).lattice_id;
    await supervisor.stop(id);
    const { opId, db } = await stageTerminalJob(supervisor, id);
    const r = await app.inject({ method: 'POST', url: `/api/lattices/${id}/items/${opId}/attest`, payload: { note: 'via note key' } });
    expect(r.statusCode).toBe(200);
    const note = (db.prepare('SELECT note FROM operator_attestation WHERE item_id = ?').get(opId) as { note: string }).note;
    expect(note).toBe('via note key');
    await supervisor.closeAll();
    await app.close();
  });
});
