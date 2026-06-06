# Runcor Lattice

> One autonomous cognitive entity that turns a large language model into something that operates on its own, continuously, over long time horizons — days, months, indefinitely.

A lattice is **not** a framework, **not** a pipeline, **not** an
orchestration of LLM calls. It is a **single running entity with a
persistent mind**. The SQLite file *is* the entity. Stop the
process, restart it months later — it picks up at the next cycle,
identity intact, memories intact, plan intact.

---

## What this gives you, practically

You're an operator. You have a task. You don't want to babysit a
chatbot or manage a queue of one-shot LLM calls. You want
**something with a name that knows the work** — that remembers
what it did yesterday, that reads its own actions in its own
prompt, that closes its own checklist items, that can be paused
and resumed without forgetting.

You hand it a job. It works the job. You read the trace. You stop
when satisfied. The SQLite file you keep is the proof — every
cycle, every decision, every memory write, every substrate finding
is in the trace, queryable with SQL.

The lattice is built around a small number of non-negotiable
invariants:

1. **The database is the entity.** SQLite is durable. The running
   Node process is a worker the supervisor can replace without
   the entity noticing.
2. **The substrate is enforced physics.** Eleven byte-equal laws
   live at the top of every model prompt. The lattice cannot see
   or disable them.
3. **Eight cycle phases in order.** `observe → ground → recall →
   decide → act → judge → write → pulse`. Every cycle is a tick;
   every phase emits a trace entry.
4. **Two tools for two problems.** Flat code-only checks
   (`file_exists`, the subconscious sweep, the discernment gate's
   pre-checks) versus LLM judgement. Mixing them is forbidden.
5. **R++ for every model call.** Every prompt is structured; every
   response is parser-validated. Bare prose fails fast.
6. **No shared memory between lattices.** Each lattice owns its
   own SQLite file. Collaboration happens through three permitted
   channels: conversation (a job over MCP), delegation (one
   lattice owns the plan), or a read-only shared source of truth.

The full set of 14 principles lives in
[`.specify/memory/constitution.md`](.specify/memory/constitution.md).

---

## Try it in 90 seconds

Prerequisites: **Node ≥ 22**, **pnpm**, **Windows / macOS / Linux**.
If you'll use the host-CLI model backend, also: a coding-agent CLI
installed and authenticated on your machine.

```bash
git clone https://github.com/runcor-ai/lattice ~/runcor-lattice
cd ~/runcor-lattice
pnpm install
pnpm build
pnpm bridge:build
pnpm bridge:start              # boots the bridge on :7100 (or set RUNCOR_BRIDGE_PORT)
```

Open `http://127.0.0.1:7100/` — that's the operator console. From
there you can instantiate a prebuilt role, hand it a job, and
watch every cycle in the live trace.

For the full operator walkthrough see
[`specs/001-lattice-core/quickstart.md`](specs/001-lattice-core/quickstart.md).

---

## A worked example — the AI GARAGE migration

[`docs/ai-garage-run/`](docs/ai-garage-run/) is a complete record
of one lattice analysing and porting a real codebase
(agent-builder-console — React + Supabase Edge Functions, ~150
features) to a local-only Vue 3 + Node + SQLite stack. **16 of
16 items closed in 74 cycles**, end-to-end, over a wall-clock
~3h 50m. The folder contains:

- The five required analysis deliverables ([features](docs/ai-garage-run/01-features.md), [vulnerabilities](docs/ai-garage-run/02-vulnerabilities.md), [migration](docs/ai-garage-run/03-migration.md), [plan](docs/ai-garage-run/04-plan.md), [privacy_controls](docs/ai-garage-run/05-privacy_controls.md)) — ~150 KB of structured engineering analysis
- A scorecard ([_run-7-scorecard.md](docs/ai-garage-run/_run-7-scorecard.md)) showing what landed, what was excluded, and what was verified live (server boot logs, endpoint responses, SQLite row counts)
- The lattice's own **unprompted** self-audit docs (the meta files prefixed `_run-*`)
- A seven-run lesson summary documenting the failure modes I caught and the systemic fixes I shipped in response — every fix is fundamental to the lattice runtime, none is task-specific

It's the best demonstration in the repo of what the lattice does.

---

## Architecture

```
apps/
├── lattice/        # CLI: one fast-clock process per lattice
├── slowclock/      # CLI: one slow-clock worker per lattice (separate process, same SQLite)
├── bridge-api/     # Fastify HTTP API (single-tenant, 127.0.0.1 by default)
└── bridge-ui/      # Vue 3 + Pinia + Vite operator console

packages/
├── rpp-parser/     # Vendored — pure TS, zero deps, never redesigned
├── substrate/      # Eleven laws + discernment gate + no-bypass export surface
├── memory/         # Four memory systems + decay formula + admission rule + subconscious sweep
├── identity/       # Identity memory + reflective composition
├── goals/          # Discovered intention stack
├── drives/         # Motivational pulse
├── temporal/       # Commitments + pressure bands (in cycles, not wall-clock)
├── decider/        # Single-model decider + lenient R++ extraction + selectDecider factory
├── dialectic/      # Player / Coach / Judge multi-pass decider
├── watchdog/       # Gap finder (stated-need-but-tool-unused)
├── skills/         # SKILL.md mint + handle-then-body recall
├── trace/          # JSONL + SQLite index + SSE ring
├── engine/         # Swappable model backends (Stub + host-CLI subprocess) with Windows `.cmd` resolution
├── capabilities/   # Six real capabilities + Perception + actOne + MCP / API factories + discovery
├── jobs/           # Checklist + completion checks (incl. file_exists) + deferral + mode='auto' attemptCheck
├── collaboration/  # Peer registry + MCP self-exposure + conversation/delegation + Law 11 standing
├── snapshot/       # LocalFolderDestination + Snapshotter + restorer
├── runtime/        # The lattice runtime: cycle.ts + lattice.ts + lockfile + migrations + write-phase auto-attempt sweep
├── slowclock/      # Slow-clock worker logic
└── bridge-shared/  # Zod schemas shared by API + UI

prebuilt/           # Role bundles (identity seed + starting knowledge + tool manifest)
├── ceo/
├── cfo/
├── marketing/
├── sales/
└── software-engineer/   # See note below — operator must override tool paths at instantiation

docs/
├── ai-garage-run/  # End-to-end demonstration: lattice ported a React/Supabase app to Vue/Node/SQLite
├── operations.md   # Day-to-day operator guide (backups, hung lattices, dials)
├── extending.md    # Adding new capabilities / backends / snapshot destinations / prebuilt roles
├── security-model.md  # Single-tenant local-only justification + threat model
└── r-plus-plus.md  # Developer's guide to R++

skills/
└── runcor-lattice/ # Anthropic-format skill: teaches Claude how to operate the bridge
```

---

## The eight cycle phases

Every cycle, every lattice, no exceptions:

| Phase | What it does | Trace shape |
|---|---|---|
| **observe** | Read every sense capability in parallel; build a perception snapshot | `senses=N` |
| **ground** | Substrate-wrap the cycle's prompt: laws on top, identity + reality slice + open tasks + recent actions + instruction | `prompt_bytes=N` |
| **recall** | Pull recent episodic memory + plan-item progress + any unblocked deferred items | `memories=N` |
| **decide** | Send the prompt to the configured decider (single-model or dialectic); parse the response as R++; extract `TARGET.output` as the chosen action and `TOKENS{}` as the input | `action=X;blocks=N` |
| **act** | At most one capability invocation per cycle. The substrate's `canInvoke` gate fires first; on `deny`, the cycle records but does nothing | `result=ok/no-action/failed` |
| **judge** | Run the discernment gate over the model's R++. Outcomes: pass / modify / block / escalate. Autonomy dial resolves to `execute`, `retry_decide`, or `wait_operator` | `judgement=X` |
| **write** | Persist episodic-memory record of the cycle + run the subconscious sweep (deterministic flat-problem corrections) + auto-attempt every open plan_item's deterministic checks. Items with passing hooks auto-close in the same transaction | `writes=N` |
| **pulse** | Update the drive state; record continue-signal. The pulse phase **NEVER** terminates the lattice — only an operator stop / process kill / unrecoverable substrate fault stops it (FR-003, Constitution Principle I) | `continue=true` |

The whole sequence runs inside one `BEGIN IMMEDIATE` / `COMMIT`
transaction. Crash mid-cycle → rollback → next restart resumes
from the last committed boundary.

---

## Capabilities (the tool surface)

The lattice's manifest entries declare what tools it has. Every
capability satisfies the rich-tool contract from
[`packages/capabilities/src/types.ts`](packages/capabilities/src/types.ts):
`name`, `description`, `role.{sense, action}`, `readOnly`,
`destructive`, `concurrencySafe`, `isEnabled()`, `canInvoke()`,
`read?()`, `invoke?()`, `onAbort?()`.

Ships with these capability factories:

| Factory | Kind | What |
|---|---|---|
| `makeEchoSense` | `echo` | Trivial sense returning the wall-clock at read; useful as a baseline |
| `makeNoopAction` | `noop` | Always-available "do nothing this cycle" escape hatch |
| `makeFsReadSense` | `fs-read` | Recursive listing of a path-jailed directory; symlinks realpath-resolved at construction |
| `makeFsReadContentAction` | `fs-read-content` | Read one file's contents, jailed to a root, with default + hard byte caps |
| `makeFsWriteAction` | `fs-write` | Write to a sandboxed output directory; **never** writes outside the jail; the supervisor auto-pairs every fs-write with a fs-read sense over the same outDir so the lattice always observes its own outputs |
| `makeShellExecAction` | `shell-exec` | Run one shell command in a jailed cwd. Safety: an allowlist of permitted first-token verbs (default: read-only inspection: grep/find/ls/cat/git/npm/node/pnpm/jq/tree/...). Operators wanting broader power must opt in explicitly |
| `makeClaudeDelegateAction` | `claude-delegate` | Spawn a fresh `claude --print` subprocess in a configured workdir with its own Read/Write/Bash tools. The pattern that makes engineering work practical: the lattice plans narrow subtasks; CC executes |
| `makeCloseJobItemAction` | (built-in, auto-injected when the lattice has open jobs) | Lattice's own R++ way to mark an item closed via `JobsService.attemptCheck` |
| `makeAppendPlanItemAction` | (built-in, auto-injected when the lattice has open jobs) | Lattice appends its **own** gated items to an open job — refine a step into sub-steps, or capture missed work — through the same validation + audit as the bridge endpoint |
| `makeApiCapability` | `api` | (Slice 10 stub — extend per [`docs/extending.md`](docs/extending.md)) |
| `makeMcpCapability` | `mcp` | (Slice 10 stub — extend per [`docs/extending.md`](docs/extending.md)) |

To add a new capability, satisfy the `Capability<I, O>` interface
in [`packages/capabilities/src/types.ts`](packages/capabilities/src/types.ts),
register a factory, add the kind to
[`packages/bridge-shared/src/index.ts`](packages/bridge-shared/src/index.ts)'s
`ManifestEntrySchema.kind` enum, wire it into
[`apps/bridge-api/src/supervisor.ts`](apps/bridge-api/src/supervisor.ts)'s
`buildCapabilities`. Three files. See `docs/extending.md`.

---

## Prebuilt roles

A bundle is three files under `prebuilt/<role>/`:

- `seed-prompt.rpp` — the R++ identity block (who this lattice is, what its constraints are)
- `starting-knowledge.json` — identity + semantic memories seeded at first instantiation
- `defaults.json` — autonomy / dialecticDepth / dials / tool_manifest defaults

The bridge picks them up at startup; `GET /api/bundles` lists them.

| Role | Identity, in one sentence | Tools |
|---|---|---|
| `ceo` | Sets direction, allocates attention, calls the calls | echo |
| `cfo` | Owns the financial picture; cautious, conservative defaults | echo |
| `marketing` | The company's external voice; positions, messages | echo |
| `sales` | Service-role; listens to customers; reports back | echo |
| `software-engineer` | Reads codebases, produces analyses, migration plans, and where appropriate the migrated code itself | fs-read, fs-read-content, fs-write, shell-exec, claude-delegate |

**Note on `software-engineer`'s defaults:** the tool_manifest paths
are placeholder sentinel strings — operators MUST override at
instantiation with concrete paths to the source repo and a writable
output dir. Going through `POST /api/companies` without overrides
will fail at the supervisor with a clear error (intentional —
running this role without operator-configured paths is a
security-boundary violation). See
[`prebuilt/software-engineer/_meta/README.md`](prebuilt/software-engineer/_meta/README.md).

---

## Jobs, items, and how items close

The job model lives in [`packages/jobs/`](packages/jobs/).

- **Job** — an externally-handed-in unit of work. Has a title, a
  why, and zero-or-more items. Lifecycle: `open → closed_*`. Closure
  modes: `full`, `partial`, `deferred`.
- **Item** — a discrete deliverable inside a job. Each item carries
  a `completion_check` — JSON describing how to verify its done-ness.
- **Completion check** — `{hooks: [...], judgement?, iterationCap?}`.
  Deterministic hooks (code-only, fast) run first; an optional
  judgement pass (LLM via the decider) runs second when configured.

**Built-in deterministic hooks** ([`packages/jobs/src/completion-check.ts`](packages/jobs/src/completion-check.ts)):

| Hook | Args | Passes when |
|---|---|---|
| `always_pass` | none | Always |
| `always_fail` | none | Never (for testing) |
| `description_contains` | `{ needle: string }` | Item description contains `needle` |
| `file_exists` | `{ path: string, minBytes?: int }` | `path` is an absolute path to a regular file with size ≥ `minBytes` |
| `content_contains` | `{ path, needle, isRegex? }` | File at `path` contains `needle` (substring, or regex when `isRegex: true`) |
| `command_exits_zero` | `{ command, cwd, timeoutMs? }` | Runs `command` in the **shell-exec sandbox** (same allowlist/cwd-jail); passes on exit 0 |
| `http_status_is` | `{ url, status? }` | Fetches `url`; passes when the response status equals `status` (default 200) |

Custom hooks are easy: pass a configured `CheckRegistry` into
`JobsService` and `.register('your-hook', fn, { costly? })`. Hooks may be
async — `command_exits_zero` / `http_status_is` are inherently so. Costly
hooks are **tiered out of the every-cycle auto-sweep** and only run on an
explicit close attempt, so the subconscious sweep never spawns a shell or
makes a network call inside the cycle transaction. Judgement still goes to
the LLM, not hooks (Principle V).

**Item auto-close:** every cycle, the write phase's subconscious
sweep runs `attemptCheck` with `mode='auto'` on every open item.
Passing hooks close the item in the same transaction. Failing
auto-attempts do **not** increment the item's iteration counter —
that counter is reserved for the lattice's own explicit
close-job-item calls. (This separation was the systemic fix that
made multi-item jobs actually progress; before it, the
deterministic sweep exhausted budget before deliverables existed.)

---

## Operating a lattice

The operator's job is small:

1. **Boot the bridge** — `pnpm bridge:start`. Single-tenant, 127.0.0.1 by default.
2. **Instantiate a lattice** — `POST /api/lattices` with name + identity_seed + tool_manifest + model_backend. Optional: `persona_bundles` (ordered Layer-1 fragments from `prebuilt/_personas/`), `init_seed` (Layer-2 one-time setup), `bundle_id` (seed memory from a prebuilt role), `resume_from_path` (reopen an existing entity).
3. **Hand it a job** — `POST /api/lattices/:id/jobs` with title + why + body + items. A gated **checklist-plan** item is auto-inserted first; the job won't close until the lattice writes its plan. Each item's completion_check uses the hook vocabulary (`file_exists` is the workhorse). The lattice can append its own items via `POST /api/lattices/:id/jobs/:job_id/items`.
4. **Watch** — `GET /api/lattices/:id/trace/stream` (SSE) or the Vue UI. Every cycle is visible.
5. **Adjust if needed** — `PATCH /api/lattices/:id/dials` (autonomy / etc) with a required `why`. `POST .../actions/{pause,resume,stop,swap-backend}`.
6. **Resume across restarts** — `POST /api/lattices` with `resume_from_path` pointing at the entity's SQLite. Same id, same memory, same cycle counter.

The full HTTP API contract is in
[`specs/001-lattice-core/contracts/`](specs/001-lattice-core/contracts).

### Letting an AI assistant operate the lattice for you

The repo ships with an operator skill at
[`skills/runcor-lattice/SKILL.md`](skills/runcor-lattice/SKILL.md)
in the Anthropic-skill format. Drop it into your project's
`.claude/skills/runcor-lattice/SKILL.md` (or globally at
`~/.claude/skills/runcor-lattice/SKILL.md`) and your assistant
knows:

- The bridge API endpoints
- The manifest schema with path-jail discipline
- The prebuilt-role catalogue
- How to construct a 5-item job with `file_exists` checks pointing
  at deliverable paths
- The deterministic mechanics (auto-attempt sweep, close-job-item,
  resume_from_path)
- The failure modes prevented in the current runtime

With the skill installed, the operator-Claude interaction is just
*"use the runcor lattice to do X"* — Claude does the rest.

---

## Status

The build progressed through 15 vertical slices to reach the
shipping baseline; see the constitution + plan documents for the
full ledger. Subsequent work (post-`docs/ai-garage-run/`) added
engineering-grade deterministic primitives:

- `file_exists` completion-check hook
- The subconscious sweep's per-cycle deterministic auto-attempt
- `mode='auto'` on `attemptCheck` (separates polling from
  iteration-budget consumption)
- Auto-paired fs-read sense for every fs-write outDir
- `resume_from_path` on the instantiate API
- Windows `.cmd` shim resolution in `spawnCliRunner`
- Lenient R++ extraction (strips prose preamble + code fences)
- R++ TARGET → chosenAction routing in the decide phase
- Manifest-driven action menu in the ground prompt
- Recent-actions surface (last 24 cycle-outcome memories) in the
  reality slice — closes the substrate Memory law's
  "memories-available-but-not-referenced" loop

Every fix above is fundamental to the lattice runtime, never
task-specific. The seven-run history in
[`docs/ai-garage-run/README.md`](docs/ai-garage-run/README.md)
walks through what was caught and what was changed.

A subsequent change set (the *lattice-changes* spec; grounding +
follow-ups in
[`specs/001-lattice-core/lattice-changes-grounding.md`](specs/001-lattice-core/lattice-changes-grounding.md))
layered on the upgrades below — all runtime-fundamental:

**The plan binds behaviour.** Prose describes; items are law.
- A job's first item is an auto-inserted **gated checklist plan** —
  the job cannot close until a real plan file (`.ai/notes/plans/<job>.md`,
  with checkbox steps) exists.
- Each checkbox becomes its own **ordered, chained `plan_item`** (step N
  blocked until N−1 passes), gated by a machine-checkable definition of
  done the lattice declares from the hook vocabulary above.
- The lattice **authors its own gated items** mid-run, in-process or via
  `POST /api/lattices/:id/jobs/:job_id/items`.
- Auto-close + close-error observability + **idle-pause** (a lattice with
  no open jobs stops cycling and resumes when a job arrives) retire the
  "noop forever" failure mode.

**Three-clock memory.** The slow clock (consolidation) gains two faster,
Claude-powered clocks: a **fast clock** every cycle that rewrites a running
"situation report" the next prompt reads instead of re-deriving from raw
history, and a **medium clock** that compacts episodic memory into a
mid-horizon record. (`LatticeOptions.memoryClocks`, default on.)

**Identity as cadenced layers + composable bundles.** The seed is split by
cadence — **Layer 1** (persona, every cycle), **Layer 2** (`init_seed`,
promoted to memory once at startup), **Layer 3** (the active job's body,
per-job). Layer 1 is composed from ordered, reusable **persona bundles**
(`prebuilt/_personas/*.md`, declared via `persona_bundles` at instantiate)
plus the operator's own seed.

**Persistence substrate law.** The runtime refuses to dispatch the same
action with the same inputs twice inside a rolling window — enforcement at
the dispatch layer, not advice in a prompt.

---

## Read more

| Doc | What |
|---|---|
| [`specs/001-lattice-core/quickstart.md`](specs/001-lattice-core/quickstart.md) | Operator quickstart (60 seconds to first cycle) |
| [`specs/001-lattice-core/spec.md`](specs/001-lattice-core/spec.md) | Functional spec — 57 FRs, 13 user stories, 12 SCs |
| [`specs/001-lattice-core/plan.md`](specs/001-lattice-core/plan.md) | Monorepo layout, build order, technical decisions |
| [`specs/001-lattice-core/data-model.md`](specs/001-lattice-core/data-model.md) | SQLite schema, JSONL trace shape, SKILL.md frontmatter |
| [`specs/001-lattice-core/contracts/`](specs/001-lattice-core/contracts) | Decider, model backend, snapshot, capability, perception, Bridge HTTP, MCP self-exposure |
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | The 14 principles the build is bound by |
| [`runcor-lattice-intent-spec.md`](runcor-lattice-intent-spec.md) | The original intent — source of truth |
| [`docs/operations.md`](docs/operations.md) | Day-to-day operator guide (backups, hung lattices, dials) |
| [`docs/extending.md`](docs/extending.md) | Adding new capabilities / backends / snapshot destinations / prebuilt roles |
| [`docs/security-model.md`](docs/security-model.md) | Single-tenant local-only justification + threat model |
| [`docs/r-plus-plus.md`](docs/r-plus-plus.md) | Developer's guide to R++ |
| [`docs/ai-garage-run/`](docs/ai-garage-run/) | Concrete end-to-end demonstration |
| [`skills/runcor-lattice/SKILL.md`](skills/runcor-lattice/SKILL.md) | Operator skill (Anthropic skill format) |

---

## Constitution principles, summarised

1. **Entity is the container, not the engagement.** No internal exit.
2. **Running program is disposable; the database IS the entity.** Resume parity is the test of this.
3. **The lattice steers itself by judgement.** No scheduler of tasks baked in.
4. **Memory is drift control.** Four systems, each with its own survival rule.
5. **Two tools for two kinds of problem.** Flat → code. Judgement → LLM. RUN 4's lesson.
6. **Eight cycle phases, in order.** No exit in pulse.
7. **Two clocks, cycle-count cadence.** Slow clock fires on cycle count, not wall-clock.
8. **Substrate is enforced physics.** Eleven laws on top of every prompt; entity cannot configure or bypass.
9. **R++ for every model call.** Built and validated by `rpp-parser`. No silent prose.
10. **Trace is mandatory.** Every cycle, every correction, every decision recorded.
11. **Modular and swappable.** Major parts behind small interfaces; default implementations.
12. **Admission rule for memory.** A thing is a memory ONLY if it can't be reconstructed from the live world.
13. **Job completion is a layer with deferral.** Completion checks + iteration + valid deferral.
14. **No shared memory between lattices.** Each owns its own SQLite. Collaboration through three permitted channels.

Full text: [`.specify/memory/constitution.md`](.specify/memory/constitution.md).

---

## Built with

- **TypeScript 5.x** on **Node ≥ 22**
- **pnpm workspaces** + **turborepo** for the monorepo
- **better-sqlite3** for the entity store (WAL, lockfile, snapshot module)
- **fastify** for the bridge HTTP API
- **Vue 3 + Vite + Pinia + Vue Router** for the bridge UI
- **zod** for runtime validation everywhere
- **@modelcontextprotocol/sdk** for MCP self-exposure + capability discovery
- **vitest** for tests
- **pino** for operational logs (distinct from the cognitive trace)
- The **Anthropic SDK** for the direct-API model backend (still
  shipping a stub by default; see `docs/extending.md` to wire your key)

---

## Attribution

This build reuses logic with attribution from the **runcor-ai**
reference repositories — substrate, identity, memory, goals,
drives, temporal, dialectic, watchdog, skills, R++ language and
parser.

---

## Build process

This project was built using [Spec Kit](https://github.com/github/spec-kit) —
every feature progressed through constitution → specify → clarify →
plan → tasks → analyze → implement. The full audit trail lives in
`specs/001-lattice-core/`.

---

## License

[MIT](./LICENSE). Copyright © 2026 Runcor Lattice contributors.

---

## Contributing

Open an issue or PR. Two things to keep in mind:

1. **Every fix should improve any lattice on any task with the same failure mode.** Task-specific patches don't land here — they're worked at the operator-of-a-specific-lattice level. The build records (`docs/ai-garage-run/_run-1-5-analysis.md`) show this discipline in practice.
2. **Constitution is non-negotiable scope.** A change that violates one of the 14 principles needs an explicit constitution amendment (a separate PR before the implementation PR).
