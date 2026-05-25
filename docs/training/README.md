# Runcor Lattice — Session Walkthrough

> A training walkthrough for delivering a session on autonomous AI
> agents. Documents how the Runcor Lattice was built, instantiated, and
> handed a real migration task that it completed end-to-end without
> human intervention over ~11 hours.
>
> **Audience:** AI practitioners, engineering leads, training-session
> attendees. **Format:** narrative + concrete artefacts + screenshots,
> ready to be worked into a slide deck or live walkthrough.

---

## What this is

This folder is the **durable record of a single working session** in
which:

1. A complete TypeScript monorepo implementing the Runcor Lattice
   (an autonomous cognitive entity around SQLite) was specified,
   planned, built, and shipped behind the operator console called
   the **Bridge**.
2. The lattice was then instantiated as its very first test — given a
   real migration task and left running unattended.
3. Over **7 runs and 10 hours 48 minutes of wall-clock time**, the
   lattice autonomously analysed a third-party React + Supabase
   codebase, planned the migration, and produced a working Vue 3 +
   Fastify + SQLite port plus five queryable analysis tables.
4. Four **systemic runtime bugs** were diagnosed and fixed during
   the run — each one as a fix to the lattice, not the task, so the
   improvements compounded.

The point of the session was never "port one app." It was to **prove
that a substrate-governed, SQLite-as-entity autonomous agent could be
trusted with a long-running engineering task** and to harden the
runtime against real-world failure modes the lab tests didn't catch.

---

## At a glance

| Metric | Value |
|---|---|
| Total wall-clock | **10 h 48 m** across 7 runs |
| Total cycles | ~74 (run 7 alone reached 33+ before completion) |
| Deliverables completed | **16 / 16** |
| Features inventoried from the source | **93** |
| Vulnerabilities found | 25 |
| Migration steps planned | 22 |
| Build-phase items in the plan | 53 |
| Privacy controls catalogued | 39 |
| Total rows across 5 analysis tables | **232** |
| Systemic runtime bugs fixed mid-run | **4** |
| Source files in the final Vue port | ~190 |
| Deterministic completion check used | `file_exists` hook |
| Iteration-budget consumption per auto-sweep | **0** (`mode='auto'`) |
| Lattice → operator interruptions during the autonomous portion | **0** |

---

## The screenshots

The two screenshots in `screenshots/` are the working artefacts the
lattice produced. They are referenced throughout the rest of this
document.

### `screenshots/01-abc-port-home.png`

The **Vue 3 workflow canvas** the lattice built. The lattice
re-implemented the original React + Supabase agent-builder-console
locally — with:

- Workflow / Free Agent tabs and Stacked / Canvas / Simple view modes
- A model picker (defaulting to `gemini-2.5-flash`)
- Drag-add palette of **Agents** (Researcher / Summarizer / Analyst)
  and **Functions** (Concat, String Contains, Is JSON, Logic Gate,
  Memory, Pronghorn)
- A right-hand properties panel and a bottom output log
- Served from a Fastify backend on `127.0.0.1:3000` + a Vite dev
  server on `127.0.0.1:5173`
- **No** cloud calls, no Supabase, no auth — entirely local SQLite,
  per the operator's hard constraint

### `screenshots/02-abc-port-bridge.png`

The **Runcor Bridge operator console**. The dark-themed Vue UI that
sits in front of every running lattice. Roster / Instantiate /
New-company tabs across the top, an empty Lattices roster (this
screenshot is from a fresh boot — the run-7 lattice had already
shipped and been terminated). Footer reads "Single-tenant
local-only. 127.0.0.1." which is FR-055 in the spec, enforced at the
HTTP listen call.

This is the surface the operator drives. Everything else — cycles,
phases, memory, dial adjustments — happens inside the Bridge.

---

## The approach to AI on display in this session

This is the section that matters for the training. The session was
not "let Claude generate code and hope." It was a small number of
explicit operating rules, applied consistently:

### 1. Pin the architecture before you start typing

Before any code was written, the entire system was nailed down in
**plain English** — the intent spec — and then formalised through
GitHub's Spec Kit pipeline:

- **Constitution** → 14 non-negotiable principles (the lattice's
  physics). Entity is the container, database IS the entity, two
  tools for two problems, etc.
- **Spec** → 57 functional requirements, 13 user stories, 12
  measurable success criteria.
- **Plan** → monorepo layout, technology stack pinned, every
  constitution principle mapped to a code location.
- **Tasks** → ~314 ordered, dependency-aware tasks across 15
  vertical slices, each slice leaving the system runnable with
  tests passing.

By the time the first `pnpm install` ran, every architectural
decision had been argued through, recorded, and was reviewable.
**There were no architecture questions left to debate during the
build.** Decisions that did surface (e.g., "should the slow clock
share a lock with the fast clock?") had already been resolved in
`research.md`.

The training takeaway: **specs are the speedup, not the slowdown.**
A `runcor-lattice-intent-spec.md` of ~1300 lines + the Spec Kit
outputs paid for itself many times over by eliminating mid-build
re-architecture.

### 2. "Two tools for two problems" (Principle V) was load-bearing

This is the single most consequential design rule in the lattice and
the rule the session demonstrated most concretely:

> Flat, mechanical problems → **deterministic code** (the
> subconscious). Genuine judgement → **LLM**. Using an LLM for a
> flat problem, or code for a judgement problem, is forbidden.

In the run itself, this manifested as the **`file_exists` completion
hook**. Every job item the lattice took on declared which file(s)
on disk would prove it complete. A deterministic check fired every
write phase, looked for those files, and marked the item passed if
they existed — **no LLM call required**. The judgement-layer
completion check (an LLM-graded "is this actually good?" pass) only
fired for items whose deliverable was *irreducible* — e.g. "the
feature inventory is comprehensive" — where a file's existence is
necessary but not sufficient.

The training takeaway: **before reaching for an LLM call, ask
whether the problem is genuinely a judgement call.** The vast
majority of "is this done?" questions are not. The cost discipline
this brings is enormous.

### 3. Local-only, no shortcuts

The operator stated up front, and held the line on, three hard
constraints:

- **Source repo is read-only.** The lattice could read the original
  agent-builder-console source but never write to it.
- **Local SQLite for everything.** No cloud database, no Supabase
  even though the original used it, no remote calls.
- **Loopback only.** Bridge HTTP listener bound to `127.0.0.1`.

These weren't suggestions — the substrate enforced them. A
capability that tried to write outside its allowed `workdir` was
rejected at the substrate gate. A discovered MCP server that needed
network egress was filtered out at the tool-discovery gate.

The training takeaway: **environmental constraints belong in the
substrate, not in prompts.** A prompt-level rule is a hope. A
substrate-level rule is a guarantee.

### 4. Every fix had to be systemic, not task-specific

This is the rule that produced the most durable engineering output
of the session. When the lattice got stuck, the temptation was
always to add a task-specific patch ("add this exception for this
file"). The operator refused that pattern every time:

> "every fix you do cannot be specific to this task, it has to be
> fundamental to the lattice."

That rule turned every blocker into a runtime improvement. The four
mid-run fixes that landed in the lattice itself:

1. **Iteration-cap exhaustion bug.** The subconscious auto-sweep
   called `attemptCheck` every cycle, which incremented
   `iteration_count` and exhausted the cap before deliverables
   existed. **Fix:** added a `mode: 'auto' | 'lattice'` parameter
   to `attemptCheck`; auto mode does not consume budget. Then a SQL
   heal pass to reset existing iteration counters on the running
   entity.
2. **Bridge prebuilt-bundle resolution.** After a fresh install,
   `process.cwd()` was the spawning subprocess's directory, so the
   prebuilt-role folder couldn't be found and `/api/bundles`
   returned `[]`. **Fix:** resolve the prebuilt directory via
   `fileURLToPath(import.meta.url)` and add an
   `RUNCOR_BRIDGE_PREBUILT` env override.
3. **pnpm 11 native-build silence.** `better-sqlite3`, `esbuild`,
   and `vue-demi` no longer ran their build scripts on a cold
   clone because pnpm 11 dropped the old `onlyBuiltDependencies`
   key. **Fix:** the new `allowBuilds: { ... }` map in
   `pnpm-workspace.yaml`.
4. **Auto-paired fs-read sense for fs-write outDir.** A capability
   that wrote files into a workdir needed a corresponding
   read-back sense or it couldn't verify its own outputs.
   **Fix:** the runtime now auto-mints the paired sense at
   instantiation.

Plus one entity-level heal applied to the running lattice:

5. **Resume-from-path entity continuity** so the lattice could be
   stopped, the runtime patched, and the lattice resumed without
   losing identity, plan, or cycle counter.

Every one of these is now in the public `main` branch and is
covered by tests. **The lattice that ships today is harder than the
lattice we started the session with.**

The training takeaway: **a real run is the fastest way to find the
bugs that lab tests don't reach.** Treat every blocker as a
fundamental-fix opportunity.

### 5. Decisive operator instructions, no negotiation theatre

The operator's messages during the run were short, direct, and
non-negotiable:

> "i dont want to fork i need to work locally"
> "i dont want it to use the database specified in the task either
> everything locally"
> "the author is hello@runcor.ai, not my personal name"
> "stop the lattice and record the results"

There was no "what do you think about…" or "could we consider…"
The decisions had already been made; the AI was being given crisp
direction. This is the operating rhythm that produces results: the
operator decides; the AI builds.

The training takeaway: **clarity of instruction is a multiplier.**
A vague prompt produces vague code. A decisive prompt produces
code you can ship.

### 6. Memory is for what you can't re-perceive

The lattice's four memory systems — identity, plan, episodic, semantic
— each have a different survival rule. Identity is permanent.
Episodic decays per `M = R × ln(f + 1) × e^(-t / (τ × D))`. Plan
persists and is rewritable. Semantic is correctable.

But the *admission rule* (constitution Principle XII) is the one
that mattered most in the run: **a thing becomes a memory ONLY if
it cannot be reconstructed from the live world.** Files on disk?
Re-perceive them every observe phase. Source-tree structure?
Re-perceive it. Test results? Re-perceive them. The lattice
remembered the *why* — why a decision was made, what the operator
constraint was, what hadn't worked — not the *what*.

The training takeaway: **a working memory of facts that exist on
disk is a bug, not a feature.** Re-perception is cheaper, fresher,
and impossible to drift from reality.

---

## The 16-item job, as the lattice received it

The task was a real internal exercise: clone the open-source
`agent-builder-console` (React + Supabase) and produce a working
local port. The lattice was given:

| # | Item | Deliverable |
|---|---|---|
| 1 | Feature inventory | `docs/ai-garage-run/01-features.md` |
| 2 | Vulnerability scan | `docs/ai-garage-run/02-vulnerabilities.md` |
| 3 | Migration analysis | `docs/ai-garage-run/03-migration.md` |
| 4 | Build plan | `docs/ai-garage-run/04-plan.md` |
| 5 | Privacy controls audit | `docs/ai-garage-run/05-privacy_controls.md` |
| 6 | SQLite analysis tables | 5 tables, 232 rows, queryable |
| 7–16 | Build phases | Working Vue 3 + Fastify + SQLite port |

All five analysis markdowns (`01-features.md` through
`05-privacy_controls.md`) are in **this folder's sibling**
`docs/ai-garage-run/` — they are the lattice's own output, verbatim,
nothing has been hand-edited. Browse them to see what the
deliverables look like.

The `abc-port` runtime artefact (the ~190 source files of the
actual Vue + Fastify code) lives on the operator's machine and is
gitignored — it's a per-task working tree, not source. The
screenshots in `screenshots/` are the proof it works.

---

## What this session demonstrates

For your training audience, this session is a working case study in:

- **Spec Kit as a force multiplier.** A 1.5-day spec phase made a
  ~5-week build phase possible in days, not months, by eliminating
  re-architecture cost.
- **Substrate-level enforcement beats prompt-level rules.** Local-
  only stayed local-only because the substrate gate vetoed
  network capabilities, not because we asked nicely in the prompt.
- **Deterministic completion checks beat LLM grading.** A
  `file_exists` hook running every cycle is essentially free,
  cannot drift, and is the right tool for "did the file get
  written?". Save LLM judgement for "is what's in the file any
  good?"
- **Real runs find real bugs.** The four systemic fixes that
  shipped during this run could not have been surfaced by unit
  tests in a lab.
- **Autonomy + auditability.** The lattice ran for ~11 hours
  unattended, but every cycle, every decision, every correction is
  in the JSONL trace and the indexed `trace` table. Nothing the
  lattice did is unreviewable.
- **Memory discipline.** The lattice did not "remember the codebase";
  it re-read the codebase every observe phase. What it remembered
  was: the operator's constraints, what hadn't worked last cycle,
  and the in-progress plan.

---

## How to drive this yourself

If you want to recreate this on your own machine:

```bash
# 1. Clone
git clone https://github.com/runcor-ai/lattice ~/runcor-lattice
cd ~/runcor-lattice

# 2. Install (pnpm 11+)
pnpm install
pnpm build

# 3. Start the Bridge (loopback only)
pnpm bridge:start
# → http://127.0.0.1:7100

# 4. In the Bridge UI, pick a prebuilt role (e.g. software-engineer),
#    give it a budget, point its workdir at a writable folder, launch.
```

For the **operator skill** that teaches Claude (or any operator
coding agent) how to drive the lattice, see
`skills/runcor-lattice/SKILL.md` in the repo root.

For the **architectural reasoning** behind every choice, see
`runcor-lattice-intent-spec.md`, `.specify/memory/constitution.md`,
and the `specs/001-lattice-core/` tree.

---

## Working it into your walkthrough

A suggested narrative arc for a 45-minute training session:

1. **(5 min)** Open with the Bridge screenshot — "this is an
   operator's view of an autonomous engineering agent that's been
   running for 11 hours."
2. **(10 min)** Walk through the *intent spec → constitution → spec
   → plan → tasks* funnel. Stress that every architectural decision
   was settled *before* code existed.
3. **(10 min)** The eight cycle phases and the substrate. The
   "two tools for two problems" rule. Live-trace the `file_exists`
   hook firing.
4. **(10 min)** Show the ABC port — open the Vue canvas screenshot.
   "The lattice wrote ~190 source files to produce this; here are
   the five SQL tables it populated as it went."
5. **(10 min)** The four systemic fixes — the iteration-cap bug, the
   prebuilt resolution, the pnpm-11 native-builds, the auto-paired
   sense. Each as "real runs find real bugs."

End on the deliverables in `../ai-garage-run/` — let the
audience scroll through 200+ rows of substantive analysis the
lattice produced unattended.

---

## Related artefacts in the repo

| Location | What it is |
|---|---|
| `screenshots/01-abc-port-home.png` | Vue 3 ABC port canvas (above) |
| `screenshots/02-abc-port-bridge.png` | Bridge operator console (above) |
| `../ai-garage-run/01-features.md` | 93-feature inventory the lattice produced |
| `../ai-garage-run/02-vulnerabilities.md` | 25 vulnerabilities found |
| `../ai-garage-run/03-migration.md` | 22-step migration analysis |
| `../ai-garage-run/04-plan.md` | 53 build-plan items |
| `../ai-garage-run/05-privacy_controls.md` | 39 privacy controls |
| `../../runcor-lattice-intent-spec.md` | The source of truth (the original "what is this") |
| `../../.specify/memory/constitution.md` | The 14 non-negotiable principles |
| `../../specs/001-lattice-core/` | Spec Kit outputs: spec, plan, tasks, contracts |
| `../../skills/runcor-lattice/SKILL.md` | The operator skill that teaches a coding agent to drive the lattice |
| `../../README.md` | Repo-level 60-second pitch |

---

*Maintained by Runcor AI. License: MIT.*
