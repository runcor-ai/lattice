---
name: runcor-lattice
description: Operate a running Runcor Lattice via its local bridge HTTP API. Use when the user wants to instantiate an autonomous engineering agent, hand it a job, watch progress, or query its trace. The lattice owns its own SQLite entity file; you talk to the bridge daemon on http://127.0.0.1:7100 (or operator-configured port). NEVER write to the source codebase the operator handed in — only via lattice tool_manifest capabilities, with operator-supplied paths.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Runcor Lattice — operator skill

You are operating the Runcor Lattice from a project's context. The
lattice is a long-running autonomous cognitive entity (one SQLite
file IS the entity); you are NOT the lattice — you are its
operator, the way a senior engineer is operator of a junior who
they hand work to and review.

## How to know the bridge is up

The bridge is the HTTP API the lattice exposes. By default it
binds `127.0.0.1:7100`. Operators sometimes override via
`RUNCOR_BRIDGE_PORT`.

```bash
curl -sS http://127.0.0.1:7100/api/health
# {"ok":true}  → up
# refused / no response → ask the operator to boot it:
#   cd ~/runcor-lattice && pnpm bridge:start
```

If the operator hasn't cloned the lattice yet, point them at
`https://github.com/runcor-ai/lattice`. Quickstart in that repo's
README is:

```bash
git clone https://github.com/runcor-ai/lattice ~/runcor-lattice
cd ~/runcor-lattice
pnpm install         # native build scripts auto-approved via pnpm-workspace.yaml
pnpm build           # ~50s on first run; cached after
pnpm bridge:build
pnpm bridge:start    # boots on :7100 (or RUNCOR_BRIDGE_PORT)
```

### Bridge install / boot troubleshooting

If the operator hits any of these on a fresh machine, here's what
to look at — these are real friction points caught during the
public-repo cold-clone smoke test. The current `main` has the
fixes; older clones may not.

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm install` warns `ERR_PNPM_IGNORED_BUILDS` for `better-sqlite3`, `esbuild`, or `vue-demi` | The `allowBuilds:` map in `pnpm-workspace.yaml` is missing / has placeholder text values instead of `true` | Set `allowBuilds: { better-sqlite3: true, esbuild: true, vue-demi: true }` in `pnpm-workspace.yaml`. Pull latest if you can; otherwise edit + `pnpm install` again. The `pnpm.onlyBuiltDependencies` key in `package.json` is NO LONGER read in pnpm 11 — don't put it there. |
| `Cannot find module 'better-sqlite3'` or missing `better_sqlite3.node` at runtime | Native binding never compiled (above bug, OR a stale install) | `rm -rf node_modules && pnpm install` after the `allowBuilds:` map is in place |
| Bridge is up (`/api/health` returns ok) but `/api/bundles` returns `[]` | The bridge resolved `prebuilt/` from the wrong cwd | Pull latest (the bridge now resolves it relative to its own module path), OR set `RUNCOR_BRIDGE_PREBUILT=<repo-root>/prebuilt` before `pnpm bridge:start` |
| `claude-code-host` backend hangs / never returns on Windows | Node `spawn` can't resolve the `.cmd` shim by bare name. The shipped `spawnCliRunner` uses `shell: true` on `win32` — if you see this, you're on an older clone | Pull latest. Or set the engine to use `command: "claude.cmd"` explicitly via the `claude_code_host.config.command` override. |
| `pnpm bridge:start` exits with `EADDRINUSE` on :7100 | A previous bridge is still running, OR another service uses 7100 | `RUNCOR_BRIDGE_PORT=7110 pnpm bridge:start` (or any free port) |

Health check after a clean boot SHOULD show:

```bash
curl -sS http://127.0.0.1:7100/api/health        # {"ok":true}
curl -sS http://127.0.0.1:7100/api/bundles | jq length   # 5
curl -sS http://127.0.0.1:7100/api/lattices              # []
```

If `/api/bundles` is `0`, NOTHING ELSE WILL WORK with bundles —
instantiating from `bundle_id` will silently fail. Confirm `5`
first.

## What you do with the bridge

The bridge has six operator-facing endpoint families:

| Endpoint | What |
|---|---|
| `GET  /api/health` | Liveness check |
| `GET  /api/lattices` | Roster of running lattices |
| `POST /api/lattices` | Instantiate a new lattice (or resume an existing one via `resume_from_path`) |
| `GET  /api/lattices/:id` | Inspect (cycle, memory counts, identity, recent decisions, dial state, drift history) |
| `GET  /api/lattices/:id/trace` | Paginated trace (filter by `kind`, `phase`, `after_cycle`) |
| `GET  /api/lattices/:id/trace/stream` | SSE live trace (server-side coalesced) |
| `PATCH /api/lattices/:id/dials` | Adjust dials mid-flight (autonomy / etc) — requires `why` field |
| `POST /api/lattices/:id/actions/{pause,resume,stop,swap-backend}` | Lifecycle controls |
| `POST /api/lattices/:id/jobs` | Hand the lattice a job (title + why + items[]) |
| `POST /api/lattices/:id/escalations/:escalation_id/decide` | Approve / reject substrate-escalated outputs |
| `GET  /api/bundles` | List prebuilt role bundles available |
| `POST /api/companies` | Instantiate multiple lattices from bundles in one call (bundles with placeholder tool paths will reject) |
| `GET  /api/secrets`, `POST /api/secrets` | Configure API keys for model backends |

The full schemas (zod-typed) are in the bridge-shared package; if
you need them, ask the operator to point you at
`packages/bridge-shared/src/index.ts`.

## The shape of an instantiate request

For a software-engineering task, you'll typically POST something
like this. Fill `<...>` with operator-supplied or operator-confirmed
values:

```js
const res = await fetch('http://127.0.0.1:7100/api/lattices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'descriptive-name',
    identity_seed: '<seed prompt — what this lattice IS>',  // or omit if bundle_id covers it
    goals: ['<one-line goal>'],
    bundle_id: 'software-engineer',     // pulls identity + starting knowledge from prebuilt/software-engineer/
    autonomy: 'medium',                 // 'low' | 'medium' | 'high'
    dialecticDepth: 0,                  // 0 = single-model decider; ≥1 = dialectic with N coach rounds
    model_backend: { kind: 'claude-code-host' },  // or { kind: 'direct-api', config: { provider: 'anthropic' } }
    tool_manifest: [
      // The lattice's tool surface. Each entry must specify a concrete config.
      // PATH-JAIL DISCIPLINE: every path is absolute; the runtime realpaths it
      // at construction and re-checks on every read/write so the lattice
      // cannot escape via symlinks or '..'.
      {
        name: 'src-listing',
        kind: 'fs-read',
        role: { sense: true, action: false },
        readOnly: true, destructive: false, concurrencySafe: true,
        config: { root: '<absolute path to source repo>', maxEntries: 300 },
      },
      {
        name: 'src-read',
        kind: 'fs-read-content',
        role: { sense: true, action: true },
        readOnly: true, destructive: false, concurrencySafe: true,
        config: { root: '<absolute path to source repo>', defaultMaxBytes: 16000, hardMaxBytes: 200000 },
      },
      {
        name: 'out-write',
        kind: 'fs-write',
        role: { sense: false, action: true },
        readOnly: false, destructive: false, concurrencySafe: false,
        config: { outDir: '<absolute path to writable output dir — the lattice will auto-pair an fs-read sense over this dir>' },
      },
      {
        name: 'src-shell',
        kind: 'shell-exec',
        role: { sense: false, action: true },
        readOnly: false, destructive: false, concurrencySafe: false,
        config: {
          cwd: '<absolute path to source repo>',
          timeoutMs: 30000, outputMaxBytes: 8000,
          // Default allowlist is read-only verbs: grep/find/ls/cat/git/npm/node/pnpm/jq/tree etc.
          // To allow writes / file ops / build commands, supply allowedVerbs explicitly.
        },
      },
      {
        name: 'delegate-cc',
        kind: 'claude-delegate',
        role: { sense: false, action: true },
        readOnly: false, destructive: false, concurrencySafe: false,
        config: {
          workdir: '<absolute path — typically same as the writable output dir or port dir>',
          timeoutMs: 600000, outputMaxBytes: 32000,
        },
      },
    ],
  }),
});
const { lattice_id, sqlite_path, trace_stream_url } = await res.json();
```

## The shape of a job

A job is what the operator hands the lattice. Title + why + items.
Each item has a `completion_check` — JSON describing how to verify
it's done. **Always prefer deterministic `file_exists` checks**:

```js
const fe = (path, minBytes = 200) =>
  JSON.stringify({ hooks: [{ name: 'file_exists', args: { path, minBytes } }] });

await fetch(`http://127.0.0.1:7100/api/lattices/${lattice_id}/jobs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '<one-line job title>',
    body: '<full task description with all constraints>',
    why: '<why this matters>',
    items: [
      {
        description: 'Write X.md analysing Y of the codebase. Cite file paths supporting each row.',
        completion_check: fe('<absolute path to X.md>', 500),
      },
      // ... more items
    ],
  }),
});
```

The lattice's write phase auto-attempts every open item's
deterministic checks every cycle. When the lattice writes the
deliverable file via its `fs-write` capability, the very next cycle's
sweep sees `file_exists → true` and auto-closes the item. No LLM
cycles burned on bookkeeping.

## Watching progress

Three options, choose by need:

```bash
# Poll-friendly
curl -sS http://127.0.0.1:7100/api/lattices/$LATTICE_ID | jq .

# Live SSE — every cycle's phases stream in
curl -sS -N http://127.0.0.1:7100/api/lattices/$LATTICE_ID/trace/stream

# Direct SQL on the entity (great for forensics)
sqlite3 <sqlite_path from instantiate response>
sqlite> SELECT ordinal, state, iteration_count, description FROM plan_item ORDER BY ordinal;
sqlite> SELECT cycle, body FROM memory_episodic ORDER BY id DESC LIMIT 20;
sqlite> SELECT cycle, body FROM trace WHERE kind='substrate' ORDER BY id DESC LIMIT 10;
```

## Resuming an existing lattice

If a lattice's SQLite file exists on disk but the lattice is not in
the bridge's roster (the bridge was restarted, or the lattice was
explicitly stopped), resume it:

```js
await fetch('http://127.0.0.1:7100/api/lattices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: '<can be anything>',
    identity_seed: '<not used on resume; supply a placeholder>',
    tool_manifest: [...SAME_manifest_as_original_instantiate...],  // important — match the original
    model_backend: { kind: 'claude-code-host' },
    autonomy: 'high',
    resume_from_path: '<absolute path to the entity SQLite file>',
  }),
});
```

The lattice picks up at `entity.cycle + 1` with full memory.
Don't change the tool_manifest's tool NAMES on resume — the
lattice's recent-actions block references prior actions by name,
and renaming them mid-life makes the prompt incoherent.

## Failure modes you've already prevented

The current runtime has the following invariants baked in. Don't
work around them or try to re-introduce the patterns they prevent:

- **Dir-loops.** The recent-actions block in `ground` surfaces the
  lattice's last 24 cycle-outcome memories. If you see the same
  action with the same input running >2 cycles in a row, the
  prompt instruction guides the lattice to choose differently.
  Don't add task-specific "don't loop" prompt instructions.
- **Write-without-close.** The subconscious sweep auto-attempts
  every open item every cycle. As soon as a deliverable file
  exists on disk, `file_exists` passes and the item auto-closes.
  You should NOT remind the lattice to manually invoke
  close-job-item — the sweep handles it.
- **Iteration-cap exhaustion via polling.** The sweep uses
  `mode='auto'` so failed polls don't consume iteration budget.
  The lattice's own explicit `close-job-item` calls DO consume
  budget. Don't conflate them.
- **Source-repo modification.** If the operator says "the source
  is read-only", build the manifest with the source root only in
  `fs-read*` capabilities. NEVER add an `fs-write` whose outDir
  is inside the source repo. NEVER add `shell-exec` with the
  source as cwd unless the allowlist is restricted to read-only
  verbs (the default).
- **Wholesale copy of the source.** Even if the user wants a
  "port" or "local version", DO NOT copy the source repo
  wholesale into the output dir. The lattice builds the port
  fresh, using the source only as reference via `fs-read*`. To
  enforce this mechanically, omit `copy`/`xcopy`/`robocopy`/
  `cp`/`mv`/`move` from the port-shell allowlist.

## What good Claude-as-operator looks like

1. **Confirm bridge is up** before doing anything else.
2. **Read the operator's constraints** carefully (local-only? read-only source? specific output dir?) and reflect them in the manifest BEFORE the lattice ever sees the task.
3. **Construct the job in operator-language** — items the operator will recognise as deliverables, with `file_exists` checks pointing at the deliverable paths.
4. **Use `bundle_id: 'software-engineer'`** for codebase-analysis-or-migration work; it pre-seeds engineering heuristics into semantic memory.
5. **Set `autonomy: 'high'`** for unattended runs, `'medium'` if the operator wants to approve destructive actions, `'low'` if they want every action to wait for them.
6. **Watch via the SSE stream** — don't poll faster than once-per-30-seconds for routine checks.
7. **Stop cleanly** with `POST .../actions/stop` when the operator is satisfied. Don't leave lattices idling on `noop` — each noop cycle still consumes one LLM call.
8. **Backup the SQLite** when something important happens — `sqlite3 entity.sqlite ".backup snapshot.sqlite"` produces a self-contained file.

## What the lattice is NOT

- Not a chatbot. You don't talk to it; you hand it work.
- Not a one-shot generator. It cycles continuously; the work happens across cycles, not in one prompt.
- Not stateless. The SQLite IS the entity. Treat it like a database, not a prompt.
- Not multi-tenant. One bridge per machine, single user. Public deployment was explicitly out-of-scope for v1.

## When to escalate to the human operator

- Bridge is down and you don't have authorization to boot it
- The lattice's autonomy dial is `low` and an action is `wait_operator` (substrate gate escalated it)
- A job's iteration_count is approaching `iterationCap` and the lattice can't make progress
- Quota / credit concerns (this runs on the operator's coding-agent subscription when using the host-CLI backend)
- Anything that requires write access to the source repo or external systems beyond the configured tool_manifest

## See also

- The README of this repo for architecture overview
- the quickstart for a worked example
- `.specify/memory/constitution.md` for the 14 principles the lattice is bound by — these are not negotiable inside the lattice's own behaviour
