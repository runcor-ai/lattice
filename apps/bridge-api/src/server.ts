import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from 'better-sqlite3';
import fastifyStatic from '@fastify/static';
import {
  AppendItemSchema,
  CompanyInstantiateSchema,
  DialAdjustmentSchema,
  EscalationDecisionSchema,
  InstantiateSchema,
  JobsHandSchema,
  TraceQuerySchema,
  type ErrorBody,
  type InspectResponse,
  type InstantiateResponse,
} from '@runcor/bridge-shared';
import Fastify, { type FastifyInstance } from 'fastify';

import { BundleLoader } from './bundle-loader.js';
import { readForecastReport } from './forecast.js';
import { loadPersonaRegistry } from './persona-loader.js';
import { SecretStore } from './secret-store.js';
import { cachedSummary, summarizeJob, summarizeThought } from './summarize.js';
import { Supervisor } from './supervisor.js';
import { ensureWorkspaceRoot } from './workspace.js';

export interface BuildServerOptions {
  readonly dataDir: string;
  readonly secrets?: SecretStore;
  readonly uiDistDir?: string | null;
  /** Root containing prebuilt role bundles. Default: <repo>/prebuilt */
  readonly prebuiltDir?: string;
}

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly supervisor: Supervisor;
  readonly secrets: SecretStore;
  readonly bundles: BundleLoader;
}

const errorBody = (code: string, message: string, details?: Record<string, unknown>): ErrorBody => ({
  error: { code, message, ...(details ? { details } : {}) },
});

export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'test' ? 'error' : 'info' },
    bodyLimit: 1_048_576,
  });

  const secrets = opts.secrets ?? new SecretStore();
  const prebuiltRoot = opts.prebuiltDir ?? join(process.cwd(), 'prebuilt');
  const bundles = new BundleLoader({ root: prebuiltRoot });
  const personas = loadPersonaRegistry(prebuiltRoot); // Item 11

  const supervisor = new Supervisor({
    dataDir: opts.dataDir,
    personas,
    resolveApiKey: (provider) => {
      const s = secrets.load();
      if (provider === 'anthropic') return s.anthropicApiKey;
      if (provider === 'openai') return s.openaiApiKey;
      return undefined;
    },
  });

  /* --------------- Health --------------- */
  app.get('/api/health', async () => ({ ok: true }));

  /* --------------- Secrets --------------- */
  app.get('/api/secrets', async () => secrets.redactedSummary());
  app.post('/api/secrets', async (req, reply) => {
    const body = req.body as Partial<{
      anthropicApiKey: string;
      openaiApiKey: string;
    }>;
    const current = secrets.load();
    secrets.save({
      ...(body.anthropicApiKey !== undefined
        ? { anthropicApiKey: body.anthropicApiKey }
        : current.anthropicApiKey
          ? { anthropicApiKey: current.anthropicApiKey }
          : {}),
      ...(body.openaiApiKey !== undefined
        ? { openaiApiKey: body.openaiApiKey }
        : current.openaiApiKey
          ? { openaiApiKey: current.openaiApiKey }
          : {}),
    });
    return reply.code(204).send();
  });

  /* --------------- Roster --------------- */
  app.get('/api/lattices', async () => supervisor.list());

  /* --------------- Instantiate --------------- */
  app.post('/api/lattices', async (req, reply) => {
    const parsed = InstantiateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    // If bundle_id is supplied, pull the bundle so its
    // starting-knowledge.json gets seeded into memory by the
    // supervisor's seedFromBundle pass. The request's other fields
    // (identity_seed, tool_manifest, model_backend, autonomy) still
    // win — bundle is only used for memory seeding here.
    const bundle = parsed.data.bundle_id ? bundles.get(parsed.data.bundle_id) : undefined;
    const out = supervisor.instantiate(parsed.data, bundle ? { bundle } : {});
    const response: InstantiateResponse = {
      lattice_id: out.id,
      sqlite_path: out.sqlitePath,
      pids: out.pids,
      trace_stream_url: `/api/lattices/${out.id}/trace/stream`,
    };
    return reply.code(201).send(response);
  });

  /* --------------- Inspect --------------- */
  app.get('/api/lattices/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const list = supervisor.list().find((row) => row.lattice_id === id);
    if (!list) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));

    // Compose the inspect payload by reading the lattice's DB directly.
    const db = r.lattice.dbHandle();
    const idRow = db
      .prepare<[]>(`SELECT composed_body, composed_at_cycle FROM identity_current WHERE id='self'`)
      .get() as { composed_body: string; composed_at_cycle: number } | undefined;
    const counts = {
      identity_count: (db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_identity`).get() as { n: number }).n,
      plan_jobs_open: (db.prepare<[]>(`SELECT COUNT(*) AS n FROM plan_job WHERE status='open'`).get() as { n: number }).n,
      plan_jobs_closed: (db.prepare<[]>(`SELECT COUNT(*) AS n FROM plan_job WHERE status LIKE 'closed_%'`).get() as { n: number }).n,
      episodic_count: (db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_episodic`).get() as { n: number }).n,
      semantic_count: (db.prepare<[]>(`SELECT COUNT(*) AS n FROM memory_semantic`).get() as { n: number }).n,
    };
    const decisions = (
      db
        .prepare<[]>(
          `SELECT body FROM trace WHERE phase='decide' ORDER BY id DESC LIMIT 10`,
        )
        .all() as Array<{ body: string }>
    ).map((row) => safeJson(row.body));
    const drift = (
      db
        .prepare<[]>(
          `SELECT body FROM trace WHERE kind='operator' AND body LIKE '%drift%' ORDER BY id DESC LIMIT 5`,
        )
        .all() as Array<{ body: string }>
    ).map((row) => safeJson(row.body));

    const inspect: InspectResponse = {
      ...list,
      identity: {
        composed_body: idRow?.composed_body ?? r.lattice.identity.composed_body,
        at_cycle: idRow?.composed_at_cycle ?? 0,
      },
      memory_summary: counts,
      dials: { autonomy: r.lattice.autonomy },
      recent_decisions: decisions,
      drift_history: drift,
    };
    return inspect;
  });

  /* --------------- Trace (paginated) --------------- */
  app.get('/api/lattices/:id/trace', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const parsed = TraceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_query', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    const q = parsed.data;
    const db = r.lattice.dbHandle();
    let sql = `SELECT id, cycle, at_ms, kind, phase, body FROM trace WHERE 1=1`;
    const args: unknown[] = [];
    if (q.after_cycle !== undefined) {
      sql += ` AND cycle > ?`;
      args.push(q.after_cycle);
    }
    if (q.before_cycle !== undefined) {
      sql += ` AND cycle < ?`;
      args.push(q.before_cycle);
    }
    if (q.kind !== undefined) {
      sql += ` AND kind = ?`;
      args.push(q.kind);
    }
    if (q.phase !== undefined) {
      sql += ` AND phase = ?`;
      args.push(q.phase);
    }
    sql += ` ORDER BY id ASC LIMIT ?`;
    args.push(q.limit);
    const rows = db.prepare(sql).all(...args) as Array<{
      id: number;
      cycle: number;
      at_ms: number;
      kind: string;
      phase: string | null;
      body: string;
    }>;
    // body is the full flat entry (kind/cycle/at_ms/phase included). Attach
    // the DB row id so the visualizer has a stable key for hover + ordering.
    return rows.map((row) => ({ ...safeJson(row.body), id: row.id }));
  });

  /* --------------- Memory (read-only) --------------- */
  // Surfaces the lattice's actual mind — episodic/semantic/identity memories
  // (each with its "why"), current plan, goals, and the running situation
  // summary — for the visualizer's thoughts panel. Pure reads; no writes.
  app.get('/api/lattices/:id/memory', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 30) || 30));
    const db = r.lattice.dbHandle();
    const all = <T>(sql: string, ...args: unknown[]): T[] => {
      try {
        return db.prepare(sql).all(...args) as T[];
      } catch {
        return [];
      }
    };
    const one = <T>(sql: string): T | null => {
      try {
        return (db.prepare(sql).get() as T) ?? null;
      } catch {
        return null;
      }
    };
    const situation = one<{ body: string; updated_at_cycle: number }>(
      `SELECT body, updated_at_cycle FROM situation_current WHERE id='self'`,
    );
    return {
      situation: situation?.body ?? null,
      situation_cycle: situation?.updated_at_cycle ?? null,
      episodic: all<{ cycle: number; body: string; why: string }>(
        `SELECT cycle, body, why FROM memory_episodic ORDER BY id DESC LIMIT ?`,
        limit,
      ),
      semantic: all<{ cycle: number; body: string; why: string }>(
        `SELECT cycle, body, why FROM memory_semantic ORDER BY id DESC LIMIT ?`,
        limit,
      ),
      identity: all<{ cycle: number; body: string; why: string }>(
        `SELECT cycle, body, why FROM memory_identity ORDER BY id DESC LIMIT ?`,
        limit,
      ),
      goals: all<{ body: string; state: string; why: string }>(
        `SELECT body, state, why FROM goal ORDER BY proposed_at_cycle DESC LIMIT ?`,
        limit,
      ),
      plan: all<{ ordinal: number; description: string; state: string }>(
        `SELECT ordinal, description, state FROM plan_item ORDER BY ordinal ASC LIMIT 100`,
      ),
      jobs: readJobs(db),
    };
  });

  /* --------------- Job summary (Claude pass) --------------- */
  app.get('/api/lattices/:id/job-summary', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const jobs = readJobs(r.lattice.dbHandle());
    if (jobs.length === 0) return { summary: null };
    const jobText = jobs
      .map((j) => {
        const items = j.items
          .map((it) => `  - [${it.state}] ${it.description}`)
          .join('\n');
        return `JOB: ${j.title}\nstatus: ${j.status}\nwhy: ${j.why}\n${j.body}\nitems:\n${items}`;
      })
      .join('\n\n');
    // Signature: re-summarize only when status or any item state changes.
    const signature = jobs
      .map((j) => `${j.id}:${j.status}:${j.items.map((it) => it.state).join('')}`)
      .join('|');
    try {
      const summary = await summarizeJob(id, jobText, signature);
      return { summary };
    } catch (err) {
      return reply
        .code(503)
        .send(errorBody('summarize_failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /* --------------- Forecast / predictions (analyst view) --------------- */
  // Parses this lattice's forecast ledger (baseline standing calls + each dated
  // forecast cycle) into an analyst-readable report: current calls + confidence,
  // leading indicators (what would flip a call), revisions, and call evolution.
  app.get('/api/lattices/:id/forecasts', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = supervisor.get(id);
    if (!rec) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    // Resolve the ledger per lattice (keyed by stable spec name, so re-instantiation is safe).
    // RUNCOR_FORECAST_LEDGERS = JSON {specName: ledgerDir}; unmapped names fall back to the default.
    // Map spec-name -> ledger dir from env, then OVERLAID by a file (ops/run/forecast-ledgers.json,
    // beside the default ledger) so a new domain can be wired in with a safe bridge-only restart,
    // without a full supervisor relaunch to change the env.
    let ledgerMap: Record<string, string> = {};
    try { ledgerMap = JSON.parse(process.env.RUNCOR_FORECAST_LEDGERS ?? '{}') as Record<string, string>; } catch { /* env unset */ }
    try {
      const base = process.env.RUNCOR_FORECAST_LEDGER;
      if (base) ledgerMap = { ...ledgerMap, ...(JSON.parse(readFileSync(join(dirname(base), 'ops', 'run', 'forecast-ledgers.json'), 'utf8')) as Record<string, string>) };
    } catch { /* no file → env only */ }
    const perLatticeLedger = ledgerMap[rec.name];
    try {
      return readForecastReport(perLatticeLedger ? { ledgerDir: perLatticeLedger } : {});
    } catch (err) {
      return reply.code(500).send(errorBody('forecast_read_failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /* --------------- Cycle thought summary (Claude pass) --------------- */
  // A one-shot Claude summarization of a cycle's raw reasoning → one/two
  // plain sentences for the thoughts box. On-demand + cached. `?refresh=1`
  // returns the cached value only (no model call) when absent.
  app.get('/api/lattices/:id/cycles/:cycle/summary', async (req, reply) => {
    const params = req.params as { id: string; cycle: string };
    const id = params.id;
    const cycle = Number(params.cycle);
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    if (!Number.isFinite(cycle)) {
      return reply.code(400).send(errorBody('invalid_query', 'cycle must be a number'));
    }

    const cached = cachedSummary(id, cycle);
    if (cached !== undefined) return { cycle, summary: cached, cached: true };
    // Cache-only mode: don't trigger a model call, just report miss.
    if ((req.query as { cached_only?: string }).cached_only === '1') {
      return { cycle, summary: null, cached: false };
    }

    const db = r.lattice.dbHandle();
    const cog = db
      .prepare<[number]>(
        `SELECT body FROM trace WHERE kind='cognition' AND cycle=? ORDER BY id DESC LIMIT 1`,
      )
      .get(cycle) as { body: string } | undefined;
    let reasoning = '';
    let action: string | null = null;
    if (cog) {
      const b = safeJson(cog.body);
      reasoning = typeof b.reasoning === 'string' ? b.reasoning : '';
      action = typeof b.action === 'string' ? b.action : null;
    } else {
      const ep = db
        .prepare<[number]>(`SELECT why, body FROM memory_episodic WHERE cycle=? ORDER BY id DESC LIMIT 1`)
        .get(cycle) as { why: string; body: string } | undefined;
      if (ep) reasoning = ep.why || ep.body;
    }
    if (!reasoning) return { cycle, summary: null, cached: false };

    try {
      const summary = await summarizeThought(id, cycle, reasoning, action);
      return { cycle, summary, cached: false };
    } catch (err) {
      return reply
        .code(503)
        .send(errorBody('summarize_failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /* --------------- Trace SSE --------------- */
  app.get('/api/lattices/:id/trace/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));

    // Tell Fastify we're taking over the raw response.
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Catch-up: from Last-Event-Id if provided.
    const lastIdHeader = req.headers['last-event-id'];
    const lastId = typeof lastIdHeader === 'string' ? Number(lastIdHeader) : 0;
    const db = r.lattice.dbHandle();
    // Catchup is the LAST 50 entries (chronological) so the operator
    // lands with a recent snapshot — not 500 entries from cycle 1.
    const catchup = db
      .prepare<[number]>(
        `SELECT id, body FROM (
           SELECT id, body FROM trace WHERE id > ? ORDER BY id DESC LIMIT 50
         ) ORDER BY id ASC`,
      )
      .all(lastId) as Array<{ id: number; body: string }>;
    let highestId = lastId;
    for (const row of catchup) {
      reply.raw.write(`id: ${row.id}\nevent: trace\ndata: ${row.body}\n\n`);
      if (row.id > highestId) highestId = row.id;
    }

    // Heartbeat so proxies / EventSource keep the connection open.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: keepalive\n\n`);
      } catch {
        /* socket closed; close handler will clean up */
      }
    }, 15_000);

    // Coalesce: the stub backend can cycle hundreds of times per second
    // (~1.4k trace writes/sec). Browsers cannot reactively render that.
    // Buffer entries from the subscriber and drain at ~5 Hz, capped at
    // SSE_BATCH_MAX entries per drain. Anything over emits a skipped-N
    // marker so the operator can see throttling is active. The full
    // trace remains queryable via GET /api/lattices/:id/trace.
    // Throttle only kicks in for runaway streams (the stub backend
    // emits ~1,440 trace events/sec). Real-backend lattices emit
    // ~10-20 events per cycle clustered around the long decide
    // phase — the cap below comfortably absorbs that without
    // emitting sse_throttled markers.
    const SSE_DRAIN_MS = 250;
    const SSE_BATCH_MAX = 100;
    const buf: unknown[] = [];
    let dropped = 0;
    const drain = (): void => {
      if (buf.length === 0 && dropped === 0) return;
      const take = buf.splice(0, Math.min(buf.length, SSE_BATCH_MAX));
      if (buf.length > 0) {
        dropped += buf.length;
        buf.length = 0;
      }
      try {
        for (const entry of take) {
          highestId += 1;
          reply.raw.write(
            `id: ${highestId}\nevent: trace\ndata: ${JSON.stringify(entry)}\n\n`,
          );
        }
        if (dropped > 0) {
          highestId += 1;
          reply.raw.write(
            `id: ${highestId}\nevent: trace\ndata: ${JSON.stringify({
              kind: 'operator',
              cycle: 0,
              at_ms: Date.now(),
              action: 'sse_throttled',
              detail: `skipped ${dropped} trace entries (server-side coalesce); full trace via GET /trace`,
            })}\n\n`,
          );
          dropped = 0;
        }
      } catch {
        /* socket closed; close handler will clean up */
      }
    };
    const drainTimer = setInterval(drain, SSE_DRAIN_MS);

    const unsubscribe = r.lattice.trace.subscribe((entry) => {
      buf.push(entry);
    });

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(drainTimer);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* already ended */
      }
    });
  });

  /* --------------- Dials --------------- */
  app.patch('/api/lattices/:id/dials', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const parsed = DialAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    // Slice 14: only autonomy is wired live; other dials are accepted but
    // their effect lands as Bridge follow-up (dial table writes).
    const autonomyVal = parsed.data.dials['autonomy'];
    if (autonomyVal === 'low' || autonomyVal === 'medium' || autonomyVal === 'high') {
      r.lattice.autonomy = autonomyVal;
    }
    // Item 9 — the pause-on-idle dial is mutable from the bridge.
    const pauseVal = parsed.data.dials['pauseOnNoOpenJobs'];
    if (typeof pauseVal === 'boolean') {
      supervisor.setPauseOnNoOpenJobs(id, pauseVal);
    }
    r.lattice.trace.write({
      kind: 'operator',
      cycle: r.lattice.completedCycle,
      at_ms: Date.now(),
      action: 'dial_adjusted',
      detail: `${JSON.stringify(parsed.data.dials)}; why: ${parsed.data.why}`,
    });
    return { applied_at_cycle: r.lattice.completedCycle };
  });

  /* --------------- Lifecycle actions --------------- */
  app.post('/api/lattices/:id/actions/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    switch (action) {
      case 'pause':
        supervisor.pause(id);
        return { applied_at_cycle: r.lattice.completedCycle };
      case 'resume':
        supervisor.resume(id);
        return { applied_at_cycle: r.lattice.completedCycle };
      case 'stop':
        await supervisor.stop(id);
        return { applied_at_cycle: r.lattice.completedCycle };
      case 'swap-backend': {
        const body = req.body as { model_backend?: unknown };
        if (!body.model_backend) {
          return reply
            .code(400)
            .send(errorBody('invalid_request', 'model_backend required'));
        }
        // Reuse the InstantiateSchema for shape validation; only model_backend matters.
        const parsed = InstantiateSchema.shape.model_backend.safeParse(body.model_backend);
        if (!parsed.success) {
          return reply
            .code(400)
            .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
        }
        supervisor.swapBackend(id, parsed.data);
        return { applied_at_cycle: r.lattice.completedCycle };
      }
      default:
        return reply.code(400).send(errorBody('invalid_action', `unknown action: ${action}`));
    }
  });

  /* --------------- Jobs --------------- */
  app.post('/api/lattices/:id/jobs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const parsed = JobsHandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    // Hand the job to the lattice via the JobsService directly (the
    // lattice's decide phase will pick it up next cycle).
    const { JobsService, planRelPath, planItemGateSpec, planItemDescription } = await import('@runcor/jobs');
    const jobs = new JobsService(r.lattice.dbHandle());
    const job = jobs.openJob({
      title: parsed.data.title,
      source: 'operator',
      why: parsed.data.why,
      cycle: r.lattice.completedCycle,
      at_ms: Date.now(),
      body: parsed.data.body, // Item 10 — Layer-3 job body
    });
    // Item 4 — force a checklist plan FIRST. The gated plan_item is
    // inserted at ordinal 0 (ahead of any operator item) and marked
    // system-inserted. The job cannot close until a real plan file with
    // a checkbox exists at the gate path, which the lattice writes via
    // its workspace write action (jailed to the same root).
    const workspaceRoot = ensureWorkspaceRoot(r.sqlitePath, r.id);
    const rel = planRelPath(job.id);
    jobs.addItem(job.id, {
      description: planItemDescription(rel),
      spec: planItemGateSpec(join(workspaceRoot, rel)),
      source: 'system',
    });
    if (parsed.data.items) {
      // Auto-chain operator items: each operator item is blocked_by the
      // previously-inserted item on this job (the plan-gate for the first,
      // each prior operator item for the rest). Required because
      // JobsService.addItem refuses to insert a source='operator' item with
      // blocked_by:null when non-operator items already exist (the plan-gate
      // is a non-operator item the bridge just inserted above). Without this
      // chaining, the bridge would 409 on its own first operator item.
      // Operators can override by setting blocked_by explicitly in the body
      // schema if they need a different topology — but the default of "block
      // each operator item on the most-recent prior item" is the right one
      // for the typical "rolling done-attestation closes after everything
      // else" pattern.
      const allItems = jobs.checklist.items(job.id);
      let prevId: string | null = allItems[allItems.length - 1]?.id ?? null;
      try {
        for (const item of parsed.data.items) {
          const inserted = jobs.addItem(job.id, {
            description: item.description,
            spec: safeJson(item.completion_check) as { hooks: { name: string }[] },
            source: 'operator',
            blocked_by: prevId,
          });
          prevId = inserted.id;
        }
      } catch (err) {
        const { OperatorItemValidationError } = await import('@runcor/jobs');
        if (err instanceof OperatorItemValidationError) {
          return reply.code(409).send(errorBody(err.code, err.message));
        }
        throw err;
      }
    }
    // Item 9 — if the lattice auto-paused for lack of open jobs, the new
    // job wakes it back into the cycle loop.
    supervisor.wake(id);
    return reply.code(201).send({ job_id: job.id });
  });

  /* --------------- Lattice-authored items (Item 8) --------------- */
  app.post('/api/lattices/:id/jobs/:job_id/items', async (req, reply) => {
    const { id, job_id } = req.params as { id: string; job_id: string };
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const parsed = AppendItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    const { JobsService } = await import('@runcor/jobs');
    const jobs = new JobsService(r.lattice.dbHandle());
    const result = jobs.appendLatticeItem(
      job_id,
      {
        description: parsed.data.description,
        gateType: parsed.data.gate.type,
        ...(parsed.data.gate.args ? { gateArgs: parsed.data.gate.args } : {}),
        blockedBy: parsed.data.blocked_by ?? null,
      },
      { cycle: r.lattice.completedCycle, at_ms: Date.now(), trace: r.lattice.trace },
    );
    if (!result.ok) {
      const status =
        result.code === 'job_not_found' ? 404 : result.code === 'job_not_open' ? 409 : result.code === 'append_cap' ? 429 : 400;
      return reply.code(status).send(errorBody(result.code, result.reason));
    }
    return reply.code(201).send({ item_id: result.item.id });
  });

  /* --------------- Operator attestation --------------- */
  /**
   * POST /api/lattices/:id/items/:item_id/attest
   *
   * The operator-side closer for items with source='operator'. This is the
   * only caller in the codebase that passes mode='operator' to JobsService
   * .attemptCheck — every other path (close-job-item, auto-sweep) is jailed
   * out by the entry-layer refusal in service.ts. Combined with the
   * source-immutability proof (jobs/src/source-immutability.test.ts), an
   * operator-source item can be closed ONLY by a deliberate operator HTTP
   * call to this endpoint. The architect's tool surface provides no path
   * to mint a source='operator' item nor to mutate one, and no manifest
   * action sets mode='operator'.
   *
   * The gate hook is still evaluated when this endpoint runs — so e.g. a
   * file_exists gate must still be met on disk. If the operator hits
   * /attest before the gate is satisfied, they get 409 with the hook's
   * reason. The endpoint is not a force-pass; it is the only mode in
   * which the gate is allowed to evaluate.
   */
  app.post('/api/lattices/:id/items/:item_id/attest', async (req, reply) => {
    const { id, item_id } = req.params as { id: string; item_id: string };
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    // Accept both `note` and `operator_note` so a common client key isn't
    // silently dropped from the audit trail (bonus fix — the field mismatch
    // left tonight's attestation note empty).
    const _b = (req.body ?? {}) as { note?: unknown; operator_note?: unknown };
    const note = typeof _b.note === 'string'
      ? _b.note
      : typeof _b.operator_note === 'string'
        ? _b.operator_note
        : '';
    const { JobsService } = await import('@runcor/jobs');
    const jobs = new JobsService(r.lattice.dbHandle());
    const item = jobs.checklist.getItem(item_id);
    if (!item) return reply.code(404).send(errorBody('item_not_found', `no item ${item_id}`));
    if (item.source !== 'operator') {
      return reply
        .code(409)
        .send(errorBody(
          'not_an_operator_item',
          `item ${item_id} has source='${item.source}' — only source='operator' items are attestable`,
        ));
    }
    if (item.state === 'passed') {
      return reply.code(200).send({ item_id, already: 'passed', passed_at_cycle: item.passed_at_cycle });
    }
    // Hard-reject items whose gate is file_exists (or any non-operator_attested
    // hook). The whole run-3 bug was a file standing in for an operator
    // judgment; refusing here makes the misconfiguration unrepresentable at
    // the endpoint boundary. Operators authoring a job MUST use the
    // operator_attested hook for their terminal attestation item.
    try {
      const spec = JSON.parse(item.completion_check) as { hooks?: Array<{ name?: string }> };
      const hookNames = (spec.hooks ?? []).map((h) => h.name).filter(Boolean);
      if (hookNames.length === 0 || !hookNames.every((n) => n === 'operator_attested')) {
        return reply.code(409).send(errorBody(
          'attestation_invalid_gate',
          `operator items must use the operator_attested hook only — found: ${hookNames.join(',') || '(empty)'}. A file_exists gate (or any other hook) lets a file or shell verb stand in for an operator judgment; refused.`,
        ));
      }
    } catch {
      return reply.code(409).send(errorBody('attestation_invalid_gate', 'item completion_check is unparseable'));
    }
    // Upsert the operator_attestation row BEFORE running attemptCheck so the
    // operator_attested hook sees it. The row is the ONLY satisfier — no
    // file at any path satisfies the gate.
    const db = r.lattice.dbHandle() as unknown as { prepare: (s: string) => { run: (...args: unknown[]) => unknown } };
    db.prepare(
      `INSERT INTO operator_attestation (item_id, lattice_id, attested_at_cycle, attested_at_ms, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET attested_at_cycle = excluded.attested_at_cycle, attested_at_ms = excluded.attested_at_ms, note = excluded.note`,
    ).run(item_id, id, r.lattice.completedCycle, Date.now(), note);
    const result = await jobs.attemptCheck(item_id, {
      cycle: r.lattice.completedCycle,
      mode: 'operator',
    });
    r.lattice.trace.write({
      kind: 'operator',
      cycle: r.lattice.completedCycle,
      at_ms: Date.now(),
      action: 'attest',
      detail: `item=${item_id} outcome=${result.outcome}${note ? ` note=${note.slice(0, 200)}` : ''}`,
    });
    if (result.outcome === 'passed') {
      // F3 — attestation is terminal, so close the job SYNCHRONOUSLY here. A
      // hard-stopped entity never cycles again (and cannot be woken), so without
      // this the job would stay `open` after a stopped-then-attested close.
      // operatorApproved:true so autonomy=low does not hold it pending — the
      // operator is the one approving.
      let job_status: string | undefined;
      try {
        const c = jobs.close({
          jobId: item.job_id,
          cycle: r.lattice.completedCycle,
          at_ms: Date.now(),
          autonomy: r.lattice.autonomy,
          operatorApproved: true,
        });
        if (c.result === 'closed') job_status = c.job.status;
      } catch {
        /* best-effort — the item is passed regardless of job-close outcome */
      }
      // If the entity is resting (paused_awaiting_operator) or idle, wake it so a
      // live cycle performs the idle transition (→ paused_no_jobs). No-op if stopped.
      supervisor.wake(id);
      return reply
        .code(200)
        .send({ item_id, outcome: 'passed', passed_at_cycle: result.item.passed_at_cycle, job_status });
    }
    // Gate didn't pass even under operator mode — the deliverable isn't on
    // disk yet, the blocker chain isn't clear, or some other hook says no.
    return reply
      .code(409)
      .send(errorBody('attestation_failed', `outcome=${result.outcome}: ${result.reason ?? '(no reason)'}`));
  });

  /* --------------- Escalations --------------- */
  app.post('/api/lattices/:id/escalations/:escalation_id/decide', async (req, reply) => {
    const { id } = req.params as { id: string; escalation_id: string };
    const r = supervisor.get(id);
    if (!r) return reply.code(404).send(errorBody('lattice_not_found', `no lattice ${id}`));
    const parsed = EscalationDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    r.lattice.trace.write({
      kind: 'operator',
      cycle: r.lattice.completedCycle,
      at_ms: Date.now(),
      action: 'escalation_decided',
      detail: `decision=${parsed.data.decision} note=${parsed.data.operator_note ?? '(none)'}`,
    });
    return { applied_at_cycle: r.lattice.completedCycle };
  });

  /* --------------- Bundles --------------- */

  app.get('/api/bundles', async () =>
    bundles.list().map((b) => ({
      id: b.id,
      autonomy: b.defaults.autonomy,
      dialecticDepth: b.defaults.dialecticDepth,
      tool_count: b.defaults.tool_manifest.length,
      identity_seed_preview: b.seedPrompt.slice(0, 280),
    })),
  );

  /* --------------- Companies (slice 15) --------------- */
  app.post('/api/companies', async (req, reply) => {
    const parsed = CompanyInstantiateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid'));
    }
    const results: { lattice_id: string; bundle_id: string; pids: { fast: number } }[] = [];
    const rejections: { bundle_id: string; reason: string }[] = [];

    for (const m of parsed.data.members) {
      const bundle = bundles.get(m.bundle_id);
      if (!bundle) {
        rejections.push({ bundle_id: m.bundle_id, reason: `unknown bundle id "${m.bundle_id}"` });
        continue;
      }
      const built = supervisor.instantiate(
        {
          name: m.name_override ?? bundle.id,
          identity_seed: m.seed_prompt_override ?? bundle.seedPrompt,
          goals: [],
          dials: bundle.defaults.dials as Record<
            string,
            string | number | boolean | Record<string, unknown>
          >,
          tool_manifest: [...bundle.defaults.tool_manifest],
          model_backend: { kind: 'stub' },
          autonomy: bundle.defaults.autonomy,
          dialecticDepth: bundle.defaults.dialecticDepth,
          bundle_id: bundle.id,
        },
        { bundle },
      );
      results.push({ lattice_id: built.id, bundle_id: bundle.id, pids: built.pids });
    }
    if (rejections.length > 0) {
      return reply.code(400).send(errorBody('unknown_bundles', 'one or more bundle ids could not be resolved', { rejections }));
    }
    return reply.code(201).send(results);
  });

  /* --------------- Static UI --------------- */
  if (opts.uiDistDir && existsSync(opts.uiDistDir)) {
    await app.register(fastifyStatic, {
      root: opts.uiDistDir,
      prefix: '/',
      decorateReply: true,
    });
    // SPA fallback: any non-/api/* path that didn't match a static
    // asset falls back to index.html so Vue Router can resolve the
    // route client-side. Without this, deep links like
    // /inspect/<lattice-id> 404 on hard-refresh.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send(errorBody('not_found', `no route for ${req.url}`));
      }
      const index = join(opts.uiDistDir!, 'index.html');
      if (existsSync(index)) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send(errorBody('not_found', `no route for ${req.url}`));
    });
  }

  return { app, supervisor, secrets, bundles };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}

interface JobItemView {
  ordinal: number;
  description: string;
  state: string;
}
interface JobView {
  id: string;
  title: string;
  body: string;
  why: string;
  status: string;
  items: JobItemView[];
}
/** Read the lattice's jobs with their plan items grouped — the complete job. */
function readJobs(db: Database): JobView[] {
  const safe = <T>(sql: string): T[] => {
    try {
      return db.prepare(sql).all() as T[];
    } catch {
      return [];
    }
  };
  const jobs = safe<{ id: string; title: string; body: string; why: string; status: string }>(
    `SELECT id, title, body, why, status FROM plan_job ORDER BY rowid ASC`,
  );
  const items = safe<{ job_id: string; ordinal: number; description: string; state: string }>(
    `SELECT job_id, ordinal, description, state FROM plan_item ORDER BY ordinal ASC`,
  );
  return jobs.map((j) => ({
    ...j,
    items: items
      .filter((it) => it.job_id === j.id)
      .map(({ ordinal, description, state }) => ({ ordinal, description, state })),
  }));
}

const isMain = (() => {
  try {
    const me = fileURLToPath(import.meta.url);
    return me === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const dataDir = process.env.RUNCOR_BRIDGE_DATA ?? join(process.cwd(), 'data');
  const uiDist = process.env.RUNCOR_BRIDGE_UI_DIST ?? null;
  // Resolve prebuilt/ relative to THIS module's location (apps/bridge-api/dist/server.js
  // → ../../.. → repo root → /prebuilt) rather than process.cwd(), which would be
  // apps/bridge-api/ when launched via `pnpm --filter @runcor/bridge-api run start`.
  // Operator can override with RUNCOR_BRIDGE_PREBUILT for non-standard layouts.
  const prebuiltDir =
    process.env.RUNCOR_BRIDGE_PREBUILT ??
    join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'prebuilt');
  const built = await buildServer({ dataDir, uiDistDir: uiDist, prebuiltDir });
  const host = process.env.RUNCOR_BRIDGE_BIND ?? '127.0.0.1';
  const port = Number(process.env.RUNCOR_BRIDGE_PORT ?? 7100);
  if (host !== '127.0.0.1') {
    console.warn(`[bridge-api] WARNING: bound to ${host} (not loopback); single-tenant local-only is the v1 trust boundary (FR-055).`);
  }
  await built.app.listen({ host, port });
  console.log(`bridge-api listening on http://${host}:${port}`);
  process.on('SIGINT', async () => {
    console.log('\n[bridge-api] shutting down…');
    await built.supervisor.closeAll();
    await built.app.close();
    process.exit(0);
  });
}
