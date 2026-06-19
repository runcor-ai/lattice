import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AutonomyValue,
  Bundle,
  InstantiateRequest,
  ManifestEntry,
  ModelBackendSpec,
  RosterRow,
} from '@runcor/bridge-shared';
import {
  makeClaudeDelegateAction,
  makeEchoSense,
  makeFsDigestSense,
  makeFsReadContentAction,
  makeFsReadSense,
  makeFsWriteAction,
  makeNoopAction,
  makeShellExecAction,
  type Capability,
} from '@runcor/capabilities';
import {
  ClaudeCodeHostBackend,
  OpenRouterBackend,
  spawnCliRunner,
  StubBackend,
  type ModelBackend,
} from '@runcor/engine';
import { composePersona, PersonaBundleRegistry } from '@runcor/identity';
import { Memory } from '@runcor/memory';
import { Lattice, type LatticeOptions } from '@runcor/runtime';

import { ensureWorkspaceRoot } from './workspace.js';

/**
 * Item 4 — appended to every instantiated lattice's seed so it both
 * WANTS to plan (this line) and is GATED into planning (the auto-inserted
 * plan_item). Item 10 will fold this into the Layer-1 persona properly.
 */
const PLANNING_DISPOSITION =
  '\n\nOn a new job, my first cycle sets direction — a checklist plan, a list of `- [ ]` steps, ' +
  'each with a machine-checkable gate — before any work is delegated. When I discover work the ' +
  'plan missed, or need to break a step into sub-steps, I append a gated item to the job rather ' +
  'than letting work happen untracked.';

/** Item 16 — appended to a director lattice's Layer-1 persona. */
const DIRECTOR_DISPOSITION =
  '\n\nI am a director, not an executor. I hold direction over the long horizon and keep the ' +
  'work from drifting; the executor (a coding agent, reached through delegate) does the work. I do ' +
  'not author deliverables — I brief them, delegate them, and verify what comes back through ' +
  'gates, and I re-brief when verification fails. A file merely existing is not evidence it is ' +
  'correct. I have no file-write tool by design.';

/**
 * Supervisor — manages the set of running lattices the Bridge owns.
 *
 * Slice 14 runs lattices IN-PROCESS (one `Lattice` per entry). The
 * intent spec calls for child processes per lattice; slice 14b can
 * lift this to spawn `apps/lattice` per entry — the Lattice class
 * exposes the same surface either way. Tests + the operator's
 * golden path are the priority here.
 *
 * Each lattice still owns its own SQLite file + lockfile (so two
 * lattices can never collide on storage even though they share a
 * Node process here).
 */

export interface SupervisorOptions {
  /** Directory where per-lattice SQLite files live. */
  readonly dataDir: string;
  /** Secret resolver (closure over SecretStore.load()). */
  readonly resolveApiKey?: (provider: 'anthropic' | 'openai') => string | undefined;
  /** Item 11 — persona bundle registry for composing Layer 1. */
  readonly personas?: PersonaBundleRegistry;
}

interface Record {
  readonly id: string;
  readonly name: string;
  readonly sqlitePath: string;
  readonly lattice: Lattice;
  readonly modelBackendKind: ModelBackendSpec['kind'];
  status: 'running' | 'paused' | 'stopped' | 'crashed' | 'paused_no_jobs';
  loopController: AbortController | null;
  loopPromise: Promise<unknown> | null;
  /**
   * Item 9 — when true (default), the lattice auto-pauses cycling once
   * it has had ≥1 job and none remain open (the noop-forever fix Item 2
   * starts: Item 2 stops cycling on done work, Item 9 stops cycling when
   * there's no work). Toggleable from the bridge dials. A lattice that
   * has never had a job keeps running until its first job arrives —
   * "all jobs closed" requires jobs to have existed.
   */
  pauseOnNoOpenJobs: boolean;
}

export class Supervisor {
  private readonly records = new Map<string, Record>();
  private readonly dataDir: string;
  private readonly resolveApiKey: SupervisorOptions['resolveApiKey'];
  private readonly personas: PersonaBundleRegistry;

  constructor(opts: SupervisorOptions) {
    this.dataDir = opts.dataDir;
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.resolveApiKey = opts.resolveApiKey;
    this.personas = opts.personas ?? new PersonaBundleRegistry();
  }

  list(): readonly RosterRow[] {
    return [...this.records.values()].map((r) => this.toRow(r));
  }

  get(id: string): Record | undefined {
    return this.records.get(id);
  }

  /**
   * Optionally seeds memory rows from a Bundle's startingKnowledge.
   * Called from `instantiate` when a bundle is supplied.
   */
  private seedFromBundle(lattice: Lattice, bundle: Bundle): void {
    const memory = new Memory(lattice.dbHandle());
    const ctx = { cycle: 0, at_ms: Date.now() };
    for (const row of bundle.startingKnowledge.identity) {
      memory.write(
        'identity',
        { body: row.body, why: row.why, admissionTag: 'decision' },
        ctx,
      );
    }
    for (const row of bundle.startingKnowledge.semantic) {
      memory.write(
        'semantic',
        { body: row.body, why: row.why, admissionTag: 'guidance' },
        ctx,
      );
    }
  }

  instantiate(
    req: InstantiateRequest,
    opts: { bundle?: Bundle } = {},
  ): { id: string; sqlitePath: string; pids: { fast: number } } {
    // resume_from_path: the operator points at an existing entity SQLite
    // and the lattice opens it instead of creating a fresh one. The id
    // is derived from the file's basename so a resumed lattice keeps
    // the original identity end-to-end (Principle II: the DB IS the
    // entity; the running process is disposable). Bundle seeding is
    // skipped on resume — the existing entity already has its identity
    // and semantic memories from the original instantiation.
    let id: string;
    let sqlitePath: string;
    const resuming = typeof req.resume_from_path === 'string' && req.resume_from_path.length > 0;
    if (resuming) {
      sqlitePath = req.resume_from_path!;
      if (!existsSync(sqlitePath)) {
        throw new Error(`resume_from_path does not exist: ${sqlitePath}`);
      }
      const base = sqlitePath.split(/[/\\]/).pop() ?? '';
      id = base.replace(/\.sqlite$/i, '');
      if (id.length === 0) {
        throw new Error(`resume_from_path: cannot derive lattice id from "${sqlitePath}"`);
      }
      const existing = this.records.get(id);
      if (existing) {
        // A stopped/crashed record is retained only so the run stays viewable.
        // Resuming the SAME entity is allowed: close its (still-open) handle to
        // release the lock, evict the dead record, then reopen from SQLite.
        if (existing.status === 'stopped' || existing.status === 'crashed') {
          existing.loopController?.abort();
          try {
            existing.lattice.close();
          } catch {
            /* already closed */
          }
          this.records.delete(id);
        } else {
          throw new Error(`resume_from_path: a lattice with id "${id}" is already running; stop it first`);
        }
      }
    } else {
      id = req.bundle_id
        ? `${req.bundle_id}-${Math.random().toString(36).slice(2, 8)}`
        : `lat-${Math.random().toString(36).slice(2, 10)}`;
      sqlitePath = join(this.dataDir, `${id}.sqlite`);
      if (!existsSync(dirname(sqlitePath))) {
        mkdirSync(dirname(sqlitePath), { recursive: true });
      }
    }

    const engine = this.buildBackend(req.model_backend);
    // Optional second voice for the dialectic Coach (e.g. OpenRouter Nemotron).
    // Player + Judge use `engine`; Coach uses this when present.
    const coachEngine = req.coach_backend ? this.buildBackend(req.coach_backend) : undefined;

    // Item 16 — director posture: strip file-write/execute tools from the
    // manifest. The director delegates and verifies; it does not write.
    const directorMode = req.director === true;
    const manifest = directorMode
      ? (req.tool_manifest ?? []).filter((e) => e.kind !== 'fs-write' && e.kind !== 'shell-exec')
      : (req.tool_manifest ?? []);
    const { senses, actions } = this.buildCapabilities(manifest);

    // Item 4 — a non-director lattice gets a jailed workspace write-root so
    // it can satisfy the auto-inserted plan gate (and write deliverables),
    // paired with a listing sense. A DIRECTOR is provisioned NO write tool
    // at all (Item 16) — the plan/deliverables are produced by the executor
    // via delegate, and the gate verifies the result.
    const workspaceRoot = ensureWorkspaceRoot(sqlitePath, id);
    if (!directorMode) {
      actions.push(makeFsWriteAction({ name: 'workspace', outDir: workspaceRoot }) as Capability<unknown, unknown>);
      if (!senses.some((s) => s.name === 'workspace-listing')) {
        senses.push(
          makeFsReadSense({ name: 'workspace-listing', root: workspaceRoot }) as Capability<unknown, unknown>,
        );
      }
    }

    // Item 11 — Layer 1 is composed from the declared persona bundles with
    // the operator's identity_seed appended last (so it refines the shared
    // bundles). No bundles → the seed alone, unchanged (legacy path).
    const personaLayer1 = composePersona(this.personas, req.persona_bundles ?? [], {
      inline: req.identity_seed,
    }).composed;

    const latticeOpts: LatticeOptions = {
      // Item 10 — Layer 1 (persona) + dispositions; Layer 2 (init) is the
      // optional init_seed, promoted to memory once.
      identity: {
        composed_body: personaLayer1 + PLANNING_DISPOSITION + (directorMode ? DIRECTOR_DISPOSITION : ''),
        ...(req.init_seed ? { initLayer: req.init_seed } : {}),
      },
      engine,
      ...(coachEngine ? { coachEngine } : {}),
      senses,
      actions,
      sqlite: { path: sqlitePath },
      name: req.name,
      autonomy: req.autonomy as AutonomyValue,
      dialecticDepth: req.dialecticDepth,
    };
    const lattice = new Lattice(latticeOpts);

    // Skip bundle seeding when resuming — the existing entity already
    // has its starting-knowledge memories from the original run.
    if (opts.bundle && !resuming) {
      try {
        this.seedFromBundle(lattice, opts.bundle);
      } catch (err) {
        // bundle seed failure shouldn't take down the lattice;
        // operational log only (slice 14 follow-up adds pino here).
        void err;
      }
    }

    const ctrl = new AbortController();
    const record: Record = {
      id,
      name: req.name,
      sqlitePath,
      lattice,
      modelBackendKind: req.model_backend.kind,
      status: 'running',
      loopController: ctrl,
      loopPromise: null,
      pauseOnNoOpenJobs: true,
    };
    this.records.set(id, record);

    // Kick off the continuous loop, but yield first so the response can be sent.
    this.startLoop(record);

    return { id, sqlitePath, pids: { fast: process.pid } };
  }

  /**
   * Drive the lattice's cycle loop from the operator plane. The runtime's
   * own loop (runUntilAborted) is exit-free by constitution (FR-003 /
   * Principle I) — so the IDLE-PAUSE decision lives HERE, in the
   * supervisor, exactly like a manual pause: we stop ticking and abort.
   * The cognitive loop never decides to stop itself.
   */
  private startLoop(record: Record): void {
    const ctrl = record.loopController;
    if (!ctrl) return;
    record.loopPromise = (async () => {
      try {
        while (!ctrl.signal.aborted) {
          await record.lattice.runOnce(ctrl.signal);
          if (record.pauseOnNoOpenJobs && this.shouldIdlePause(record.lattice)) {
            record.status = 'paused_no_jobs';
            record.lattice.trace.write({
              kind: 'operator',
              cycle: record.lattice.completedCycle,
              at_ms: Date.now(),
              action: 'lifecycle',
              detail: 'paused_no_jobs_remaining',
            });
            return; // stop ticking; record stays alive; wake() restarts it
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch (err) {
        record.status = 'crashed';
        // operational logging in slice 14 follow-up
        void err;
      }
    })();
  }

  /**
   * Item 9 — true when the lattice has had at least one job and none are
   * open now. A jobless lattice (total = 0) returns false so it keeps
   * cycling until its first job arrives.
   */
  private shouldIdlePause(lattice: Lattice): boolean {
    const db = lattice.dbHandle();
    const open = (db.prepare(`SELECT COUNT(*) AS n FROM plan_job WHERE status = 'open'`).get() as { n: number }).n;
    if (open > 0) return false;
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM plan_job`).get() as { n: number }).n;
    return total > 0;
  }

  pause(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    if (r.status !== 'running') return false;
    r.loopController?.abort();
    r.status = 'paused';
    return true;
  }

  resume(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    if (r.status !== 'paused') return false;
    r.loopController = new AbortController();
    r.status = 'running';
    this.startLoop(r);
    return true;
  }

  /**
   * Item 9 — resume a lattice that auto-paused for lack of open jobs.
   * Called when a new job is handed to it via the bridge. No-op unless
   * the lattice is in the paused_no_jobs state.
   */
  wake(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    if (r.status !== 'paused_no_jobs') return false;
    r.loopController = new AbortController();
    r.status = 'running';
    r.lattice.trace.write({
      kind: 'operator',
      cycle: r.lattice.completedCycle,
      at_ms: Date.now(),
      action: 'lifecycle',
      detail: 'resumed_new_job_arrived',
    });
    this.startLoop(r);
    return true;
  }

  /**
   * Item 9 — toggle the auto-pause dial from the bridge. Turning it OFF
   * while the lattice is idle-paused wakes it back into the running loop.
   */
  setPauseOnNoOpenJobs(id: string, value: boolean): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    r.pauseOnNoOpenJobs = value;
    if (!value && r.status === 'paused_no_jobs') {
      r.loopController = new AbortController();
      r.status = 'running';
      this.startLoop(r);
    }
    return true;
  }

  async stop(id: string): Promise<boolean> {
    const r = this.records.get(id);
    if (!r) return false;
    r.loopController?.abort();
    if (r.loopPromise) await r.loopPromise;
    r.status = 'stopped';
    // Keep the record + DB handle so a cleanly-stopped run stays viewable
    // (trace, memory, visualizer) instead of vanishing. Full teardown — the
    // DB close — happens on process shutdown via closeAll().
    return true;
  }

  swapBackend(id: string, spec: ModelBackendSpec): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    const next = this.buildBackend(spec);
    r.lattice.setEngine(next);
    return true;
  }

  /** Close everything (graceful shutdown) — abort loops AND close DBs. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.records.values()].map(async (r) => {
        r.loopController?.abort();
        if (r.loopPromise) await r.loopPromise;
        try {
          r.lattice.close();
        } catch {
          /* already closed */
        }
      }),
    );
    this.records.clear();
  }

  private toRow(r: Record): RosterRow {
    return {
      lattice_id: r.id,
      name: r.name,
      status: r.status,
      cycle: r.lattice.completedCycle,
      open_jobs: 0, // slice-15 wires real plan_job count
      current_plan_summary: '',
      goals_summary: [],
      budget: null,
      model_backend: r.modelBackendKind,
      pids: { fast: process.pid, slow: null },
      autonomy: r.lattice.autonomy,
    };
  }

  private buildCapabilities(manifest: readonly ManifestEntry[]): {
    senses: Capability<unknown, unknown>[];
    actions: Capability<unknown, unknown>[];
  } {
    const senses: Capability<unknown, unknown>[] = [];
    const actions: Capability<unknown, unknown>[] = [];
    let sawSense = false;
    let sawAction = false;

    for (const entry of manifest) {
      switch (entry.kind) {
        case 'echo':
          senses.push(makeEchoSense() as Capability<unknown, unknown>);
          sawSense = true;
          break;
        case 'noop':
          actions.push(makeNoopAction() as Capability<unknown, unknown>);
          sawAction = true;
          break;
        case 'fs-read': {
          const root = (entry.config as { root?: string } | undefined)?.root;
          if (typeof root !== 'string' || root.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (fs-read) requires config.root (absolute path)`,
            );
          }
          const maxEntries = (entry.config as { maxEntries?: number } | undefined)?.maxEntries;
          senses.push(
            makeFsReadSense({
              name: entry.name,
              root,
              ...(typeof maxEntries === 'number' ? { maxEntries } : {}),
            }) as Capability<unknown, unknown>,
          );
          sawSense = true;
          break;
        }
        case 'fs-digest': {
          const cfg = (entry.config ?? {}) as {
            root?: string;
            totalBytes?: number;
            priorityFiles?: string[];
            maxFiles?: number;
            skipDirs?: string[];
          };
          if (typeof cfg.root !== 'string' || cfg.root.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (fs-digest) requires config.root (absolute path)`,
            );
          }
          senses.push(
            makeFsDigestSense({
              name: entry.name,
              root: cfg.root,
              ...(typeof cfg.totalBytes === 'number' ? { totalBytes: cfg.totalBytes } : {}),
              ...(Array.isArray(cfg.priorityFiles) ? { priorityFiles: cfg.priorityFiles } : {}),
              ...(typeof cfg.maxFiles === 'number' ? { maxFiles: cfg.maxFiles } : {}),
              ...(Array.isArray(cfg.skipDirs) ? { skipDirs: cfg.skipDirs } : {}),
            }) as Capability<unknown, unknown>,
          );
          sawSense = true;
          break;
        }
        case 'fs-read-content': {
          const cfg = (entry.config ?? {}) as { root?: string; defaultMaxBytes?: number; hardMaxBytes?: number };
          if (typeof cfg.root !== 'string' || cfg.root.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (fs-read-content) requires config.root (absolute path)`,
            );
          }
          const cap = makeFsReadContentAction({
            name: entry.name,
            root: cfg.root,
            ...(typeof cfg.defaultMaxBytes === 'number' ? { defaultMaxBytes: cfg.defaultMaxBytes } : {}),
            ...(typeof cfg.hardMaxBytes === 'number' ? { hardMaxBytes: cfg.hardMaxBytes } : {}),
          }) as Capability<unknown, unknown>;
          // It's both a sense and an action; add to both arrays so it's discoverable in
          // both observe (for sense channel) and act (for action channel).
          senses.push(cap);
          actions.push(cap);
          sawSense = true;
          sawAction = true;
          break;
        }
        case 'fs-write': {
          const cfg = (entry.config ?? {}) as { outDir?: string };
          if (typeof cfg.outDir !== 'string' || cfg.outDir.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (fs-write) requires config.outDir (absolute path)`,
            );
          }
          actions.push(
            makeFsWriteAction({
              name: entry.name,
              outDir: cfg.outDir,
            }) as Capability<unknown, unknown>,
          );
          sawAction = true;
          // Deterministic auto-pairing: every fs-write capability comes
          // with a complimentary fs-read sense over the same outDir, so
          // the lattice automatically observes what it has produced on
          // every cycle — no LLM cycle required to invoke a "list my
          // outputs" action. The paired sense is named "<name>-listing"
          // and is suppressed only if the operator already declared a
          // sense with that exact name in the manifest.
          const pairedName = `${entry.name}-listing`;
          const alreadyDeclared = manifest.some(
            (e) => e.name === pairedName && (e.kind === 'fs-read' || e.kind === 'fs-read-content'),
          );
          if (!alreadyDeclared) {
            senses.push(
              makeFsReadSense({
                name: pairedName,
                root: cfg.outDir,
              }) as Capability<unknown, unknown>,
            );
            sawSense = true;
          }
          break;
        }
        case 'shell-exec': {
          const cfg = (entry.config ?? {}) as {
            cwd?: string;
            allowedVerbs?: string[];
            timeoutMs?: number;
            outputMaxBytes?: number;
          };
          if (typeof cfg.cwd !== 'string' || cfg.cwd.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (shell-exec) requires config.cwd (absolute path)`,
            );
          }
          actions.push(
            makeShellExecAction({
              name: entry.name,
              cwd: cfg.cwd,
              ...(Array.isArray(cfg.allowedVerbs) ? { allowedVerbs: cfg.allowedVerbs } : {}),
              ...(typeof cfg.timeoutMs === 'number' ? { timeoutMs: cfg.timeoutMs } : {}),
              ...(typeof cfg.outputMaxBytes === 'number' ? { outputMaxBytes: cfg.outputMaxBytes } : {}),
            }) as Capability<unknown, unknown>,
          );
          sawAction = true;
          break;
        }
        case 'claude-delegate': {
          const cfg = (entry.config ?? {}) as {
            workdir?: string;
            command?: string;
            args?: string[];
            timeoutMs?: number;
            outputMaxBytes?: number;
          };
          if (typeof cfg.workdir !== 'string' || cfg.workdir.length === 0) {
            throw new Error(
              `tool_manifest entry "${entry.name}" (claude-delegate) requires config.workdir (absolute path)`,
            );
          }
          actions.push(
            makeClaudeDelegateAction({
              name: entry.name,
              workdir: cfg.workdir,
              ...(typeof cfg.command === 'string' ? { command: cfg.command } : {}),
              ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
              ...(typeof cfg.timeoutMs === 'number' ? { timeoutMs: cfg.timeoutMs } : {}),
              ...(typeof cfg.outputMaxBytes === 'number' ? { outputMaxBytes: cfg.outputMaxBytes } : {}),
            }) as Capability<unknown, unknown>,
          );
          sawAction = true;
          break;
        }
        case 'api':
        case 'mcp':
          // Slice 14 follow-up: wire api/mcp factories from manifest config.
          // For now we accept the entry and skip — substrate would log this.
          break;
      }
    }

    // EchoSense is the baseline sense; only add it if no other sense
    // was wired. NoopAction is ALWAYS added — it's the always-available
    // "do nothing this cycle" escape hatch the substrate can fall back
    // to. Even with rich actions wired, the lattice may legitimately
    // choose noop (e.g. when no useful action is justified yet).
    if (!sawSense) senses.push(makeEchoSense() as Capability<unknown, unknown>);
    if (!actions.some((a) => a.name === 'noop')) {
      actions.push(makeNoopAction() as Capability<unknown, unknown>);
    }
    void sawAction;

    return { senses, actions };
  }

  private buildBackend(spec: ModelBackendSpec): ModelBackend {
    switch (spec.kind) {
      case 'openrouter':
        return new OpenRouterBackend({
          model: spec.config.model,
          ...(spec.config.baseUrl ? { baseUrl: spec.config.baseUrl } : {}),
        });
      case 'stub':
        return new StubBackend();
      case 'claude-code-host':
        return new ClaudeCodeHostBackend({
          runner: spawnCliRunner({
            ...(spec.config?.command ? { command: spec.config.command } : {}),
            ...(spec.config?.args ? { args: [...spec.config.args] } : {}),
          }),
        });
      case 'direct-api': {
        const provider = spec.config?.provider ?? 'anthropic';
        const key = this.resolveApiKey?.(provider);
        if (!key) {
          // Fall back to the stub so the Bridge can demo without a key.
          return new StubBackend({ name: `direct-api-${provider}-stub` });
        }
        // Real provider SDK wiring lives in slice 14b; for now we shim to stub.
        return new StubBackend({ name: `direct-api-${provider}-shimmed` });
      }
    }
  }
}
