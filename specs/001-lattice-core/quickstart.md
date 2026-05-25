# Quickstart — Instantiate a Lattice in 60 Seconds

> Audience: the operator. Prereq: `node 22+`, `pnpm`, an Anthropic API key
> (or a coding-agent CLI installed if you want the host backend).

## 1. Install (one time, ~30s)

```pwsh
git clone <repo-url> runcor-lattice
cd runcor-lattice
pnpm install
pnpm build
```

This installs all packages and compiles TypeScript. No external services
needed — the lattice runs entirely off SQLite.

## 2. Start the Bridge

```pwsh
pnpm bridge:start
```

The Bridge HTTP server starts on `http://127.0.0.1:7100` (localhost only
— constitution Principle / spec FR-055).

Open `http://127.0.0.1:7100` in a browser. You see an empty roster.

## 3. Instantiate your first lattice

Click **Instantiate**. Fill the form:

| Field | Example |
|---|---|
| Name | `my-first-lattice` |
| Identity seed (R++) | (the form pre-loads a template you can edit) |
| Goals | `Help me track my reading queue` |
| Model backend | `direct-api` (Anthropic) |
| API key | (paste yours; stored locally, never logged) |
| Snapshot destination | `local-folder` |
| Snapshot path | `~/lattices/my-first-lattice/snapshots` |
| Tool manifest | (one sense: filesystem read on `~/Reading/`) |
| Dials | leave at defaults |

Click **Launch**.

Within ~10 seconds (success criterion SC-005), the lattice appears on the
roster with `cycle: 1+` and a non-empty trace.

## 4. Watch it live

Click into your lattice. You see:

- **Roster summary**: status, cycle count, plan summary, goals, budget.
- **Live trace stream**: phase entries appearing as new cycles run.
- **Memory view**: identity, plan (empty initially), episodic count growing.
- **Dial view**: current settings.

The trace stream updates within 2 seconds of each new cycle (success
criterion from US5).

## 5. Adjust mid-flight

- Slide `autonomy` from `medium` to `high`. Next cycle, substrate flags
  self-correct without operator input.
- Raise `budget.ceiling`. Lattice continues cycling without restart.
- Click **Pause** → cycles stop at the next phase boundary. Click
  **Resume** → continues from the cycle counter at pause.

## 6. Hand it a job

Click **New job**. Title: `Catalogue my reading queue`. Body: free text
describing what you want.

The lattice writes a checklist into its plan memory, defines completion
checks, and starts working items in subsequent cycles. As items pass,
they appear in the plan view. If anything blocks, it defers with a
recorded reason and an unblock condition.

## 7. Stop and resume

Kill the lattice process:

```pwsh
# From the Bridge: click Stop
# Or from the terminal where you ran pnpm bridge:start, Ctrl+C
```

Then restart:

```pwsh
pnpm bridge:start
```

The roster shows your lattice. Open it. **Cycle counter is exactly N+1**
where N was the last committed cycle (success criterion SC-002, resume
parity test). The plan, episodic memory, semantic memory, identity, and
skill library are unchanged.

## 8. (Optional) Stand up a company

Once you have multiple lattices running, you can stand up a *company* —
a bundle of pre-built role lattices (CEO, CFO, marketing, sales, …)
that work together via MCP.

Bridge → **New Company** → pick roles → assign budgets → launch.

Within ~5 minutes (success criterion SC-006), all role lattices are
cycling.

## What just happened

You instantiated an **autonomous cognitive entity**. It is now:

- Running its eight-phase cycle continuously (`observe → ground → recall
  → decide → act → judge → write → pulse`).
- Persisting everything to one SQLite file (it IS that file).
- Wrapping every model call in the substrate (eleven laws at the top of
  every prompt) and validating the structure with R++.
- Writing every cycle, every correction, every decision to an auditable
  trace.
- Sweeping for flat contradictions in semantic memory each cycle.
- Running a slow-clock worker every ~100 cycles that consolidates memory
  and looks for drift.

The lattice will keep running until you stop it. Restarts don't break
its continuity — the entity is the file, not the process.

## Where to go next

- **Constitution** (`.specify/memory/constitution.md`) — the rules the
  lattice's design is bound by.
- **Spec** (`specs/001-lattice-core/spec.md`) — what the lattice does,
  in plain English, with success criteria.
- **Plan** (`specs/001-lattice-core/plan.md`) — how the build is
  structured (packages, apps, build order).
- **Data model** (`specs/001-lattice-core/data-model.md`) — the SQLite
  schema, the trace shape, the SKILL.md format.
- **Contracts** (`specs/001-lattice-core/contracts/`) — the swappable
  interfaces: decider, model backend, snapshot destination, capability,
  perception, Bridge HTTP API, MCP self-exposure.
