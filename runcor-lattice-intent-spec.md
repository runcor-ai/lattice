# Runcor Lattice — Intent Specification

**For:** an AI engineering tool, building a fresh monorepo.
**Status:** Intent-level specification. Drafted 2026-05-24 from a working discussion.

---

## 0. How to read this document

This is an **intent document**, not an implementation plan. It says what the
lattice *is*, what it must *do*, and which decisions are already settled. It
deliberately does **not** prescribe file layouts, class designs, or library
choices beyond the few places where a wrong guess would be expensive.

Two kinds of statement appear here:

- **Pinned.** Things you must not reinvent — the memory formula, the cycle
  phases, the law count, the four memory systems, the core shape. These are
  marked **PINNED** and are reproduced exactly so you don't invent a variant.
- **Intent.** Everything else. The behaviour is described; the implementation
  is yours. Make the engineering calls. Where this document and the older
  reference material disagree, **this document wins** — it reflects later
  decisions.

The runcor family already exists as separate repositories (see §21). You are
**building fresh** — one clean monorepo — not cloning those repos. You may
study them to reuse logic, copy code with attribution, and avoid redesigning
things that already work. But the output is a new, consolidated codebase.

Stack: **TypeScript, Node, monorepo. Vue.js for the Bridge UI.**

---

## 1. What the lattice is

The lattice is **one autonomous cognitive entity**. It turns a large language
model into something that operates on its own, continuously, over long time
horizons — days, months, indefinitely.

It is not a framework, not a pipeline, not a way to orchestrate LLM calls. It
is a single running entity with a persistent mind.

The guiding analogy is a **human professional**. A doctor is just a doctor;
given whatever is in front of them, they make the best next move. They are not
handed a script. They have an identity, accumulated experience, judgement, and
tools — and they act. The lattice is built the same way. A "project-manager
lattice" and a "doctor lattice" share the exact same machinery; they differ
only in who they were instantiated to be and what tools they hold.

The lattice must be **model-agnostic**. It can drive Claude, GPT, or any other
model. The model is a consumable; the lattice is the asset.

---

## 2. Core principles (the settled decisions)

These came out of a working discussion and override anything that conflicts in
the older reference documents.

**The entity is the container, not the engagement.** The lattice does not
"run a job and exit." It runs continuously. Discrete jobs (write a charter,
produce a plan) are *nested inside* the entity's ongoing life — they have a
finish line; the entity does not. "Done" applies to jobs, never to the entity.
The entity stops only when a human deliberately stops it.

**The running program is disposable; the database is the entity.** No program
runs literally forever — machines reboot, software updates. So "runs forever"
means the *entity* is continuous even though the *program* is not. On restart,
the lattice loads its saved state and resumes on the very next cycle, as if no
gap occurred. Interruptions must not matter.

**The lattice steers itself.** It infers what to do next, every cycle, by
judgement — based on what kind of entity it is and what is currently in front
of it. A human handing it a job, or a plan list, are *inputs it weighs*, not
instructions it obeys. There is no scheduler of tasks baked into the lattice.

**Memory is drift control.** The lattice stays on course not because a checker
catches it wandering, but because the right context is always in front of it.
Memory, properly structured, *is* the mechanism that prevents drift. See §9.

**Two tools for two kinds of problem.** Flat, mechanical problems are solved by
deterministic code. Genuine judgement is done by an LLM reasoning pass. Using an
LLM for a flat problem, or code for a judgement problem, is the central mistake
to avoid. This is the lesson of the RUN 4 experiments: deterministic correction
was rock-solid; LLM-routed correction of the same flat problem was wildly
unstable.

**Everything is modular and swappable.** Each major part sits behind a small
interface with a default implementation, selected at instantiation. Pieces can
be replaced or upgraded without surgery elsewhere.

**Trace is mandatory.** Every cycle, every correction, every decision is
recorded to an auditable transcript. Trust is verifiable, not assumed.

---

## 3. Entity, job, cycle

Three nested units:

- **Entity** — the lattice itself. Continuous. No finish line. The project
  manager. The thing the database represents.
- **Job** — a discrete piece of work with a defined "done" (a charter, a
  plan, a conversation with another lattice). Picked up, completed, and left
  behind while the entity carries on. Multiple jobs over a lifetime; continuous
  work runs alongside them.
- **Cycle** — one tick of the entity's life. The unit of work for the loop.

**PINNED:** The loop has **no "engagement complete → exit" condition.** A job
finishing closes that job and the entity continues. The older
`EngagementResult` / `exitReason: 'goal-complete'` model is replaced by this
entity model.

### 3.1 How a job knows it is done

A job is **not** done because the lattice produced an artifact. It is done
because the artifact was produced **and the job's own completion checks
passed.** This is a distinct concern from drift (§5): drift is the *entity*
wandering; this is a single *job* meeting its bar before the lattice closes it.

The standard a job is judged against is specific to that job and cannot be a
built-in rule. A project plan is "done" when it holds up against *that
project's* functional spec and what stakeholders said about scope — facts that
live in the job's own context. So **taking on a job includes working out how
the lattice will know it is done** — writing that job's completion checks from
its own source material, the way a professional sets their own bar for the task
in front of them.

The completion check for a job is a **layer**:

- **Deterministic hooks, by default and as many as the job allows.** Flat,
  pass/fail checks — "every milestone in the spec has a plan section," "every
  scope item from the stakeholder meeting appears," "no placeholder text
  remains." These are trustworthy because code cannot fool itself (the RUN 4
  lesson again). The lattice should turn as much of "is this done" into
  deterministic hooks as it can.
- **A judgement pass for the irreducible remainder.** Some of "done right" —
  whether a plan is genuinely coherent and reflects what stakeholders *meant* —
  cannot be made flat. That part is an LLM reasoning pass. It covers only what
  no hook can.

**Iteration.** If a completion check fails, the lattice does not move on. It
keeps the item open, goes back, fixes what failed, and re-runs the check,
cycling until it passes.

**Deferral — the escape hatch.** If an item genuinely cannot be made to pass,
it may be **deferred** rather than trapping the lattice forever. Deferral is
guarded: it requires a **valid reason**, and a valid reason is grounded in
something real and external — a genuine blocker, a missing dependency, a
contradiction in the job's own source material — **never** "this was hard" or
"I judged it unnecessary." A deferred item records two things: the reason, and
its **unblock condition** — what must become true for the item to be
revisitable (the missing budget figure, the pending stakeholder decision).

**Partial completion.** A job may close as **partially done**: good enough to
move on, with some items deferred. Deferred items are not forgotten — they are
flagged, persist in the plan memory, and are carried forward by the entity.
When perception (§6, `observe`) later shows a deferred item's unblock condition
is met, that item becomes live work again and the lattice finishes it. This is
the entity behaving like a competent professional: ship the plan now, mark the
section waiting on a budget number, circle back when the number arrives.

**Sign-off follows the autonomy dial.** Who closes a job, and who certifies a
deferral, depends on `autonomy` (§18). High autonomy: the lattice closes its
own jobs and records its own deferrals. Lower autonomy: job completion and
deferred-item exceptions escalate to a human to confirm before they stand.

Every completion, deferral, and unblock is written to the trace (§16).

---

## 4. The two clocks

The lattice runs on two rhythms, implemented as **two separate programs**
sharing one database.

**The fast clock** — the main loop. One trip through the cycle phases (§6) is
one cycle; the loop repeats them continuously. This is the entity *living*.

**The slow clock** — a separate background worker. It sleeps most of the time,
wakes **every N cycles** (not on a wall-clock timer — see below), does its
work, sleeps again. This is the entity *reflecting*.

**PINNED:** The slow clock fires on **cycle count, not elapsed time** — a
lattice's pace is uneven, so counting cycles keeps reflection proportional to
activity. The cadence is **load-aware**: it adapts to how intense the lattice's
operations have been so far — heavier recent activity shortens the interval, a
quieter stretch lengthens it — rather than being a fixed number. A baseline of
roughly **every 100 cycles** is the starting point the load adjustment moves
around. The operator can override the cadence from the Bridge at any time
(`reviewCadence`).

The two programs share the single SQLite file. A simple lock ensures two slow
passes never overlap (the reference codebase uses a lock file for exactly
this; mirror that approach). Both programs get the resume-on-restart behaviour
from §2.

---

## 5. The three layers of self-maintenance

Keeping the entity coherent is done at three levels. Getting these levels and
their tools right is the most important part of the design.

**Work** — the entity doing its job. Pure judgement, every cycle, no schedule.
The lattice decides everything it *does* — when to check email, when to write,
when to send an update — by reasoning, the way a professional does.

**The subconscious** — deterministic code, every cycle, underneath the work,
cheap. It catches *flat, mechanical* problems: stored state that plainly
contradicts a current rule; stale values; simple inconsistencies. For this
narrow class, code can both detect and fix. When it acts it does three things
together:

1. **Fixes** the problem on the spot — quietly, deterministically.
2. **Flags** it — so the same cycle's judgement knows a correction occurred.
3. **Documents** it — writes the change to the trace (what was wrong, what
   changed, when), so every self-correction is auditable.

The subconscious only ever touches things that are *flatly certain*. Anything
requiring a judgement call is **not** its job — it is handed up to the work
layer instead. This narrowness is a safety requirement: a deterministic
mechanism that "fixes" things it shouldn't will do so confidently and forever.
The trace is the safeguard — a misbehaving subconscious shows itself in the
record (the same correction firing over and over).

**Sleep** — an LLM reasoning pass, on the slow clock, every N cycles (detailed
in §7). It does
the deep, expensive work that cannot run every cycle: consolidating memory, and
reviewing for *genuine drift* — whether the entity has slowly wandered from its
purpose or character. Detecting that kind of drift is a judgement, not a flat
fact, so it must be an LLM pass, not code.

**PINNED — the division of labour.** Flat mechanical problems → deterministic
code (the subconscious). Genuine judgement → LLM (sleep, and the work layer).
This is the RUN 4 lesson and it is non-negotiable.

When the sleep pass finds genuine drift, it does **not** reach into the running
loop. It **writes a correction into memory**, and the fast loop picks it up
naturally on its next cycle, the same way it reads everything else. Gentle,
no fast/slow collision. (This was an explicit decision; do not implement a
direct-interrupt mechanism.)

---

## 6. The cycle (fast clock)

**PINNED — the eight phases, in this order:**

`observe → ground → recall → decide → act → judge → write → pulse`

One pass through all eight is one cycle. Intent of each:

**observe** — refresh the entity's picture of the world. This is *perception*,
not action. The lattice automatically takes in what is new since last cycle:
new messages, and changes visible through its sense-connections (email, files,
calendar, trackers — reached via MCP or API). Perception is *automatic* — it is
not a capability the lattice must choose to invoke, because if it were, the
lattice could go head-down for many cycles and miss the world changing.
Critically, the entity does not re-read everything every cycle — it reads what
is *new*, plus a maintained summary of what came before (see §9). Perception is
also where the lattice notices that a **deferred plan item's unblock condition**
has been met (§3.1, §9.5) — the awaited information has arrived — which makes
that item live work again.

**ground** — the substrate wraps the call: the eleven laws, the identity prior
(drawn from identity memory, §9.2), the relevant slice of reality, and the
cycle's instruction. Laws sit at the **top** of the prompt (a buried-laws
placement failed in testing; top placement fixed it).

**recall** — pull in the relevant memory: identity, current plan, recent
episodes, and the few semantic memories that matter now — plus the few active
skills (§13) relevant to the work in front of it. Not everything — only what is
relevant.

**decide** — the entity reasons about the best next move, given what it is and
what is in front of it. Produces an intended action.

**act** — execute at most one capability (a tool call via MCP or API). Acting
changes the world; it is deliberate and singular per cycle.

**judge** — a cheap, per-cycle check (substrate discernment) on what was just
produced. Catches a bad single action immediately. This is the *fast* drift
check; it is not the deep one, and it is distinct from a job's completion
checks (§3.1) — those run when the lattice attempts to mark a plan item or a
job done, not every cycle.

**write** — record the cycle into memory with the appropriate survival rule
(§9). Apply the subconscious sweep here (§5).

**pulse** — update drives; decide whether to continue (it almost always does);
hand off to the next cycle. There is no "engagement complete" exit.

---

## 7. The slow-clock worker

A separate program, fired every N cycles, with two responsibilities.

**First — tidy memory (consolidation, "the dream").** Review what has
accumulated, merge new learning into durable memory, delete facts that turned
out wrong, prune the memory index back under its size cap. This is
self-contained: it reads memory and rewrites memory. Nothing else must react.

**Second — check for drift.** An LLM reasoning pass that reads the entity's
recent life and judges whether it has wandered — off-purpose, off-character, or
blind to something it should have acted on (the watchdog's job: stated needs
versus tools available versus what it actually did). If it finds drift, it
writes a correction into memory (see §5) — it does not interrupt the loop.

---

## 8. Substrate — the physics

The substrate is the enforced physics of the lattice: laws, an identity prior
(drawn from the identity memory system, §9.2), a reality slice, and a
discernment gate. It wraps every model call. The entity cannot see it,
configure it, or bypass it — it is physics, not advice. Reuse
`runcor-substrate`.

### 8.1 The laws

**PINNED:** The substrate carries **eleven declarative laws**, compiled
compactly and placed at the **top** of every prompt. They are not principles —
each is a *failure mode*: something that broke when it was violated. Reproduce
them exactly; do not reword or re-derive them.

The ten original laws (from `runcor-substrate`):

1. **Reality** — only reference entities present in reality; never assume facts
   not provided.
2. **Translation** — state the source for external data; flag format
   conversions.
3. **Judgment** — state evidence before proposing actions; no unsupported
   pattern matching.
4. **Constraint** — follow the agent spec exactly; no deviations.
5. **Feedback** — state observable success/failure criteria for every proposed
   action.
6. **Memory** — reference relevant memories; state explicitly if none exist.
7. **Compounding** — prefer the current strategy; justify any direction change.
8. **Cost-Value** — state action cost; recommend lower-cost alternatives at
   80%+ outcome.
9. **Simplicity** — choose the fewest dependencies; justify added complexity.
10. **Uncertainty** — state confidence levels; flag data gaps; never assume.

The eleventh law, added for the collaboration layer (§15.1) — without it,
autonomous peer discovery has no rule of conduct underneath it:

11. **Standing** — engage other lattices only within your defined role;
    discovering a peer is not licence to direct, interrupt, or pull on it; act
    within your place in the structure.

### 8.2 The discernment gate

After the model responds, the discernment gate evaluates the output — one check
per law. Code-first for speed, an LLM check only where code is inconclusive.
Four outcomes: **pass** (executes as proposed), **modify** (rewritten to fix
issues), **block** (rejected, reason logged), **escalate** (held for human
review). Reality and Constraint violations are critical and always block;
Uncertainty is a warning; Simplicity is advisory — logged, never blocking. The
gate is what the `judge` phase (§6) runs every cycle.

**Discernment and the autonomy dial are one system, not two.** Discernment is
the *mechanism* — it is what makes the eleven laws enforced physics rather than
ignorable prompt text (RUN 1 showed laws-as-text get ignored). The autonomy
dial (§18) is the *control* on that mechanism: when discernment flags an
output, autonomy decides what happens next — at high autonomy the lattice
corrects it itself; at low autonomy the same flag escalates to a human.
Discernment is the detector; autonomy is the dial on the detector. Neither
replaces the other — a dial with no detector has nothing to act on, and a
detector with no dial has no way to vary its response.

---

## 9. Memory — four systems

Memory is the spine of the lattice and the mechanism of drift control. Design
it properly; everything downstream depends on it.

### 9.1 The admission rule

**PINNED:** A thing becomes a memory **only if it cannot be reconstructed from
the live world.** Anything the lattice can perceive again next cycle — a file's
contents, a tracker's state, code structure — is **never** stored as memory; it
is re-perceived, fresh, every time. Memory is reserved for what would genuinely
be *lost* otherwise: decisions, the reasons behind them, guidance received, who
is doing what and why.

This rule attacks the drowning problem at the source and eliminates a whole
class of staleness (memory going stale because the world moved). Apply it as a
gate in front of all four memory systems.

Every stored memory keeps its **"why"**, not just its "what" — the reason is
what lets a later cycle judge whether the memory is still valid. Convert
relative dates ("Thursday") to absolute dates on write.

### 9.2 The four memory systems

**PINNED — there are four, and they are genuinely different systems, each with
its own rule for what survives:**

1. **Identity** — what the entity *is*. Anchors against drifting from its
   nature. **Must not decay.** Permanent, immune to the decay formula. Reuse
   `runcor-identity` (the self-theory artifact). Identity *lives* here, in
   memory; the substrate's identity prior (§8) is how it is *placed into the
   prompt* each cycle, in the `ground` phase — one store, one injection point,
   not two.

2. **Plan** — where the entity is *going*. Anchors against drifting from
   intent. Evolves over time but never evaporates. The rolling, rewritable
   plan.

3. **Episodic** — what *happened*, in order. Anchors against losing the thread
   of recent action. **This is the one that should decay** — old episodes
   matter less than recent ones. The decay formula (§9.3) applies here.

4. **Semantic** — settled facts and rules; what is *true*. Anchors against
   acting on wrong information. Persists, but must be correctable when a fact
   goes stale. (This is where the subconscious sweep does its flat-correction
   work — §5.)

Do not collapse these into one decaying store. They are four systems.

### 9.3 The decay formula (episodic memory)

**PINNED — reproduce this exactly; do not invent a variant:**

```
M = R × ln(f + 1) × e^(-t / (τ × D))
```

- `M` — memory durability score; drives promotion and forgetting.
- `R` — reinforcement strength of the entry.
- `f` — access frequency.
- `t` — age.
- `τ` (tau) — durability time-constant.
- `D` — durability dial.

Default thresholds: `M < 0.05` → forget; `M > 0.6` → promote (with
compression). Thresholds and `τ`, `D` are operator dials. This formula governs
**episodic** memory's survival. It does **not** govern identity (permanent).

### 9.4 Recall

When pulling memory into a cycle, do **not** require a vector database. The
reference approach: keep a plain **index** — one short description line per
memory — and use a small, cheap model pass to select the few relevant items
from that index. This is lighter and suits the self-contained goal. A vector
search may be added later behind the same interface if needed.

Old memories carry an **age** and, when stale, a freshness caveat ("this
memory is N days old; verify before relying on it"). Express age in human
terms ("47 days ago"), not raw timestamps — models reason about staleness
better that way. Do not warn on fresh memories (noise).

Reuse `runcor-memory` for the cube/decay/plan machinery; reorganise it into the
four-system shape above.

### 9.5 The plan's structure

The plan memory (§9.2, system 2) is not just a list of intentions — it carries
the working state of the entity's jobs. Its structure must support the job
completion model of §3.1. For each job, the plan holds:

- A **checklist** of items the job is broken into.
- For each item, a **completion check** — the deterministic hooks plus, where
  needed, the judgement pass described in §3.1.
- For each item, a **state**: open, passed, or deferred. An item may only be
  marked passed when its completion check actually passes — never by assertion.
- For each deferred item, its **reason** and its **unblock condition** (§3.1),
  so the entity can recognise when a deferred item becomes revisitable.

This gives the plan memory a real, working shape. It is also what lets the
entity carry unfinished business across long horizons: deferred items sit in
the plan with their unblock conditions, and the lattice reopens them when
perception shows the condition is met.

---

## 10. Direction — goals, drives, temporal

**Goals** — the discovered intention stack. What the entity is trying to
achieve. Reuse `runcor-goals`.

**Drives** — the motivational pulse that keeps the loop turning (resource
pressure, curiosity, reactivity, coherence). Reuse `runcor-drives`.

**Temporal** — deadlines and commitments, measured in **cycles** (the canonical
unit; the consumer maps cycles to wall-clock). Pressure bands escalate as a
deadline nears. All real work carries deadlines and commitments — not only
project work — so temporal is core. Reuse `runcor-temporal`.

---

## 11. The decider

**PINNED — settled decision:** The lattice has two deciders, both **built and
wired**: a **single-model decider** (the default) and the **multi-model
dialectic** (Player drafts / Coach challenges / Judge selects). They sit behind
one small interface and are interchangeable. Which one a given lattice uses is
an operator choice, set per lattice via a **Bridge dial** — "optional" means
the operator selects it, not that it is built later. Reuse `runcor-dialectic`
for the dialectic decider; build it as part of the core, not deferred.

The decider is also the reasoning pass that other components call when they
need deliberation — identity's reflective update, goal proposal, skill
extraction. Those components call *the decider*, whichever one is configured;
they do not depend on the dialectic specifically.

**PINNED — every model call uses R++.** Prompts are **structured, not loose
prose** — this is the R++ idea, and it is what made the laws-at-the-top fix
work. That discipline is not unique to the decide phase: an unstructured prompt
is exactly the soft spot drift creeps in through. So **every model call the
lattice makes is built and validated as R++** — no exceptions, no silent prose
anywhere. This includes the decide phase, the `ground` wrap, skill synthesis,
identity's reflective update, goal proposal, and the slow-clock sleep and
drift-review passes. Use the existing **R++ language and its parser** (`rpp`,
`rpp-parser`) to build and validate them all. The parser is pure TypeScript
with zero runtime dependencies — bring it in whole; do not redesign it.

---

## 12. Self-monitoring — watchdog

**Watchdog** rides the **slow clock**. It sharpens the sleep-pass drift review
(§5, §7): an outside-the-loop observer that catches the one blind-spot failure
nothing else in the design catches — a need the entity has stated, a capability
it holds, and a gap between them, the failure mode of *having a tool and never
using it*. It reads stated needs versus available tools versus what the entity
actually did. Read-only; it emits findings into the correction path of §5.
Reuse `runcor-watchdog`.

---

## 13. Skills — the learning layer

Skills are **core**, not an enhancement. They are how the entity gets sharper
over its whole life and — crucially — how it carries competence into new
domains. Reuse `runcor-skills`.

**The skill library.** Each entity accumulates a library of skills inside its
own SQLite file — part of the entity, the same one-file-one-owner model as
memory (§17). There is no shared skill store. A lattice may **expose** its
skills over MCP so a company can assemble a central library by reading across
lattices — the same exposure pattern as the collaboration layer (§15.1); the
no-shared-memory rule still holds.

**The skill format.** A skill is written as a **Claude `SKILL.md`** file — the
same proven template Claude's own skills use, rather than a bespoke runcor
format. It has two parts: a short **frontmatter** block (a `name` and a
`description`), and a **body** holding the procedure. Two things make this a
clean fit. The frontmatter `description` — by design a plain-language "what
this is and when to use it" line — *is* the handle the lattice reads and judges
(see below). And the body, the procedure itself, is populated in **R++**, the
lattice's structured prompt language (§11), so it is parser-validated rather
than loose prose. Like a Claude skill, a skill may also bundle supporting files
the procedure refers to.

**Two extractions per skill.** When a skill is minted it is extracted at two
levels: a **specific** extraction — the concrete pattern from the work just
done — and a **generic** extraction — the same pattern abstracted so it
transfers to new domains. The generic extraction is the load-bearing one: it is
what lets an entity apply what it learned on one kind of work somewhere else.

**When skills are minted.** A skill is minted when a job closes — whether fully
or partially complete (§3.1). It is extracted only from the checklist items
whose **completion checks passed**: verified success is the only valid source
of a skill; deferred items did not get done and yield nothing to learn. So a
job that closed at ~80% still mints skills, from its passed items.

Skills are **proposed, not auto-applied** — minting produces a validated,
parser-checked skill proposal; whether it enters active use is gated, following
the autonomy dial (§18). Skill synthesis uses the decider (§11).

**Using skills — offered, not imposed.** Minting and storing a skill is only
half of "trainable"; a skill that is never retrieved makes no future cycle
sharper. But a skill must not be silently digested into the decide prompt
either — that would fill the prompt with procedure every cycle and nudge the
lattice toward using a skill merely because it is there. Skills are **offered,
and the lattice chooses** — the same principle as the tool manifest (§15),
where the entity sees what a tool is and decides whether to invoke it. The
skill's two parts play the two roles: the `SKILL.md` **description** is the
*handle* the lattice is shown; the R++ **body** is the *payload* it loads only
on choosing.

- In `recall` (§6), the lattice surfaces the **descriptions** of the active
  skills relevant to the work in front of it — cheap, just the handles, found
  the same index-plus-selector way as memory recall (§9.4).
- In `decide`, the lattice reads those descriptions and **judges** which, if
  any, fit the work — exactly the deliberate choice it makes for a tool.
- Only for a skill it chooses is the **R++ body** loaded into the decide-phase
  prompt as validated, parser-checked procedure.

This is the full loop: a job closes → a skill is minted from its passed items →
it is stored, gated, and written as a `SKILL.md` with an R++ body → a later
cycle is *shown* the description, *chooses* the skill, and *applies* it. The
**generic** extraction is what makes this pay off across domains — its
description is written so the skill surfaces for a *different* kind of work
whose shape matches, and the lattice can recognise the fit.

---

## 14. The engine and model-access backends

The runcor **engine** (`runcor`) is built into the lattice monorepo — routing,
retries, MCP plumbing, cost tracking. It is the chassis the loop runs on.

**PINNED — settled decision:** The way the engine reaches a model is a
**swappable backend**. Provide at least two:

1. **Direct API** — ordinary API calls to a provider (Claude, GPT, etc.),
   per-token billing, API key.
2. **Host-CLI** — the lattice runs *on top of* a coding-agent CLI on the
   operator's machine, driving it as the host so a person on an ordinary
   subscription can run the lattice autonomously over long horizons without
   API billing.

The lattice itself stays unaware of which backend is active — it asks the
engine for a model turn; the engine routes it. Build the backend behind one
small interface so others can be added.

> Note for the operator (not a build instruction): running a subscription
> product fully autonomously over long horizons can run into usage limits and
> provider terms of service. This is the operator's responsibility to check;
> the architecture supports it regardless.

---

## 15. Capabilities and connecting to the world

A **capability** is a named tool the entity can choose to invoke (at most one
per cycle, in the `act` phase). Capabilities reach the world through **MCP or
API**.

Keep the distinction from §6 firm in the design:

- **Perception** — sense-connections, read automatically every cycle in
  `observe`. Always-on awareness.
- **Action** — capabilities, invoked deliberately in `act`.

Some connections may serve both. Build it so a connection can be wired as a
sense, a tool, or both.

**The tool manifest — what a lattice starts with.** A lattice cannot start
blind: at instantiation it is given a **tool manifest**, its starting set of
capabilities. The manifest is not a flat list of names — each entry is marked
as a **sense** (read automatically every cycle in `observe`), an **action** (a
capability invoked in `act`), or both, per the distinction above. The Bridge
sets the manifest at instantiation (§19); a prebuilt lattice ships one as part
of its bundle (§19.2). An **empty manifest is legal** — a lattice with no tools
simply cannot act until it acquires some. The manifest is a *starting point,
not a ceiling*: a lattice extends it over its life through tool discovery
below, governed by its substrate. The manifest seeds; discovery grows.

**Tool discovery.** The lattice does not bundle a fixed set of connectors. It
is pointed at the **official MCP Registry** (`modelcontextprotocol/registry`) —
a queryable directory of MCP servers — and discovers the tools it needs from
it, with `modelcontextprotocol/servers` (the official reference servers:
filesystem, fetch, git, and so on) as a baseline set. This is the same pattern
as the lattice peer-discovery registry (§15.1): the lattice has two registries,
one for discovering tools and one for discovering peers. And as with peer
discovery, tool discovery is **governed, not open** — pulling in a third-party
MCP server is a real attack surface, so which servers a lattice may adopt is
constrained by its substrate and configuration, not a free-for-all.

**Integration and Data Fabric stay outside the lattice.** `runcor-integration`
(learns external databases, serves them as tools) and `runcor-data` (turns
unstructured data into structured knowledge) are **external services**. The
lattice connects to them — preferably via **API** — the same way it connects to
any other outside system. Do not build them into the lattice repo.

### 15.1 The collaboration layer — lattices working together

Lattices must be able to work together: a CEO lattice pulling in a CFO lattice,
talking it through, then handing a decision to a sales lattice. This is what
makes the Bridge's end goal possible — spinning up whole autonomous companies
of cooperating lattices, not just single lattices.

**The firm rule: no shared memory.** Every lattice owns its own single SQLite
file, completely (§17). Lattices never reach into each other's memory and never
co-hold anything. Collaboration is something that *passes between* lattices —
never something they *jointly hold*. This keeps the one-file-one-owner
foundation, and therefore clean resume, fully intact.

**Discovery — how a lattice finds its peers.** A lattice does not magically
know other lattices exist. Discovery works through a **registry** — a single
shared location, dumb infrastructure, curated by no one. The registry is the
*place*; a lattice is told its address at instantiation (the same way it is
told its model backend), so a lattice always knows where to look and where to
announce itself. Membership is **autonomous**: on startup a lattice posts its
own **one-sentence essence** to the registry — who it is and what it does ("a
CFO lattice; owns the company's financial picture") — registering *itself*;
nothing and no one registers it for it. On its **slow cycle** (§4) a lattice
reads the registry to see which peers have announced themselves. The directory
therefore curates itself: it is simply the live set of lattices that have each
posted their essence.

Discovering a peer is **not** licence to engage it. The registry tells a
lattice who *exists*; whether it may open a conversation is a separate matter,
governed by the lattice's own identity and substrate — Law 11, Standing
(§8.1). The sales lattice can *see* the CEO on the registry, but its identity
and laws are what keep it from initiating uninvited. Structure is enforced by
each lattice knowing its place, not by gatekeeping the directory. For a company
bundle, the Bridge strengthens this by writing the org structure into each
lattice's seed prompt and substrate (§19.1). A lone lattice pointed at an empty
registry simply has no peers, which is correct.

Given the no-shared-memory rule, lattices work together three ways:

**1. Conversation.** A lattice exposes itself over **MCP** so other lattices
can reach it — a lattice already speaks MCP outward, so exposing itself as an
MCP endpoint means peers connect to it like any other connection. A real
back-and-forth (the CEO/CFO "phone call") is modelled as **a job** (§3, §3.1):
the conversation sits on the calling lattice's plan; its loop keeps turning;
each cycle it says the next thing to the peer and perceives the reply. The loop
is never frozen waiting — only *focused* on the conversation job. If the peer
goes quiet, the conversation job **defers** ("waiting on CFO") via the
deferral mechanism of §3.1, and the lattice moves on. The *memory* of the
conversation lives in each lattice's own store, each in its own words — like
two people remembering a call from their own side. There is no central
transcript.

**2. Delegation.** Lattices do **not** co-edit a plan. One lattice owns a plan;
it hands pieces out as jobs to other lattices. Each does the work in its own
memory and reports back. "Two lattices on one plan" is really "one owner
delegating jobs" — exactly how a manager and a team operate. The plan always
has exactly one owner.

**3. A shared source of truth.** A read-only reference that a set of lattices
must all see the *same* version of — a project's functional spec, a company
handbook, canonical numbers, or any body of knowledge a group of lattices
should share. It sits **outside** the lattices as an external service they
connect to and **read** (the same pattern as Integration and Data Fabric
above). They read it; they never write it. It is reference material, not shared
memory — so the no-shared-memory rule still holds.

Building the collaboration layer reuses machinery that already exists: MCP for
the transport, the job/plan/cycle model for conversations and delegation, the
deferral mechanism for unresponsive peers. It does not need a new blocking or
concurrency system, and it must not introduce one.

---

## 16. Trace

**PINNED:** Every cycle emits an auditable record — one entry per phase — to a
JSONL transcript, plus whatever indexed store the Bridge needs to read it.
Every subconscious correction (§5) is recorded here too. The trace is what
makes the entity's behaviour verifiable. It is also the operator's primary
debugging surface.

---

## 17. Persistence

**PINNED — settled decision:** The lattice's database is **SQLite**. The
SQLite file *is* the entity — its memory, identity, plan, skills, all of it.

The lattice code simply opens a SQLite file at a configured path; it does not
know or care where that path physically lives. Persistence is handled by a
small, **swappable snapshot module**:

- Periodically (e.g. at slow-clock wake, or every N cycles) the database is
  copied to a durable location the operator configures.
- On startup, if no local file exists but a backup does, restore from the
  backup first, then resume.
- "Where snapshots go" is itself pluggable — local folder, cloud bucket — so it
  can be swapped without touching the lattice.

This keeps the lattice self-contained (no external database service required
to run) while making the entity's memory genuinely survive a machine being
wiped or redeployed.

Use ordinary, well-maintained npm libraries for the SQLite driver and other
plumbing (see §25 for the recommended libraries). "Self-contained / no
dependencies" means **no dependency on the separate runcor repos and no heavy
agent frameworks** — it does not mean hand-copying infrastructure that others
maintain well.

---

## 18. The control surface (dials)

Runtime dials, settable at instantiation and adjustable mid-flight from the
Bridge:

- `autonomy` — the control on the discernment gate (§8.2): when discernment
  flags an output, this sets whether the lattice self-corrects or escalates to
  a human. The same dial governs who signs off on job completion and deferrals
  (§3.1)
- `exploration` — exploit vs explore
- `memoryDurability` — `τ` and `D` in the decay formula
- `promotionThreshold` — the M threshold for promotion
- `memoryRecallBreadth` — how many memories recall pulls
- `planStability` — how readily the plan is rewritten
- `dialecticDepth` — when the dialectic decider is in use
- `reviewCadence` — **slow-clock cadence, in cycles.** Load-aware by default
  (adapts to operational intensity, baseline ~100); operator can override
- `drivePressure` — drive function scaling
- `riskTolerance` — confidence threshold
- `budget` — dollars / tokens / time ceilings

---

## 19. The Bridge

The Bridge is the operator product — the human interface. It lives in the
**same monorepo** as the lattice. **Vue.js** front end.

**PINNED — what the Bridge does:** instantiate lattices, observe them, adjust
them.

- **Instantiate** — a form-driven UX to configure and launch a new lattice
  (identity, goals, dial positions, memory source, model backend, tool
  manifest).
- **Roster** — a dashboard of all lattices: status, cycle count, current plan,
  goals, budget.
- **Inspect** — click into a lattice: live trace stream, current memory state,
  dial positions, recent decisions, drift/correction history.
- **Adjust** — mid-flight: change dials (`agent.adjust()`), pause/resume/stop,
  force a replan, raise budget, swap model backend.

**PINNED — what the Bridge does NOT do:** it does not run lattices, route work
between them, hold shared state, execute tool calls, or make model calls. The
lattices run themselves; the Bridge observes and configures.

**The Bridge must be genuinely well-designed.** It is the one part of the
system a human looks at, and an operator overseeing autonomous entities needs
to trust what they see at a glance. Build it as a polished operator console —
calm, clear, and information-dense without clutter; the live trace, the roster,
and the dials should each read instantly. Use the **frontend-design skill** when
building it, and treat visual quality as part of the deliverable, not an
afterthought.

### 19.1 Companies — bundles of lattices

The Bridge can instantiate a single lattice, or a **company** — a *bundle* of
lattices packaged together (a CEO, a CFO, a sales lattice, and so on). A
company is purely a Bridge-layer packaging convenience; it is **not** a new
entity type. The lattice runtime never needs to know it is "in a company" — it
is always just a lattice.

A bundled lattice arrives pre-configured: a **seed prompt** so it knows what it
is (the CEO lattice knows it is a CEO), some **starting knowledge** for context,
and it can then be **fed jobs** like any other lattice. A company bundle may
also be pointed at a shared source of truth (§15.1) the member lattices read.

Because a company is just a set of single lattices, everything else in this
document applies unchanged — each member is an ordinary lattice with its own
file, its own loop, and its own memory.

### 19.2 Prebuilt lattices — ready-made role bundles

Standing up a company should not require writing every lattice from scratch.
The build ships a **library of prebuilt lattices** — ready-made role bundles,
each a complete starting point for a common role: a CEO, a CFO, a marketing
lattice, a sales lattice, and so on.

Each prebuilt lattice is a bundle of three things, all written ahead of time:

- A **seed prompt** — who this lattice is and the role it was instantiated to
  fill, written so the lattice's identity and goals form correctly around it.
- **Starting knowledge** — the context a competent holder of that role would
  already have, loaded into memory at instantiation.
- **Sensible defaults** — dial positions and a starting **tool manifest**
  (§15) fitting the role.

With the library in place, standing up an autonomous company is a short
operation in the Bridge: pick the role bundles, give each one a **budget** (the
`budget` dial, §18), optionally adjust the seed prompt, and launch. The operator
supplies intent and money; the prebuilt bundles supply the rest.

A prebuilt lattice is still an ordinary lattice — the bundle is only pre-written
configuration, and everything in this document applies to it unchanged. The
roster of roles in the starter library is open: adding a new prebuilt role must
be a matter of writing its three parts, never of changing the runtime.

---

## 20. Monorepo shape and what is pinned vs free

One monorepo. Internally organised as packages so each major part can be
swapped or upgraded independently — at minimum: the lattice runtime, the
cognitive modules, the engine, the Bridge API, the Bridge UI. The exact package
boundaries and file layout are **yours to decide**.

**Pinned (do not reinvent):** the entity/job/cycle shape (§3); the job
completion model — checklist, completion checks, deferral with reason and
unblock condition, partial completion (§3.1, §9.5); the eight cycle phases and
their order (§6); the two-clock model and cycle-count cadence (§4); the
three-layer self-maintenance model and the code-vs-LLM division (§5); the four
memory systems (§9.2); the decay formula (§9.3); the admission rule (§9.1); the
eleven substrate laws at prompt-top, including Law 11 Standing (§8); the two
deciders — single-model and dialectic, both built, the Bridge dial selecting
(§11); R++ for every model call, parser-validated (§11); the collaboration
model — no shared memory, peer discovery via a self-curating registry, and
sharing only by conversation, delegation, and a read-only shared source of
truth (§15.1); SQLite-as-entity with a snapshot module (§17); the Bridge's
do / do-not list (§19).

**Free (your engineering judgement):** all file and package layout; all class
and interface design; library choices for plumbing; how the snapshot module is
implemented; how perception connections are registered; how the trace store is
indexed; test structure. Build it well; do not ask permission for ordinary
engineering decisions.

**Everything in this document is required core.** The build has no optional or
enhancement tier. The engine, substrate, identity, memory, goals, drives,
temporal, R++ and its parser, both deciders, skills, watchdog, capabilities and
MCP — and all the lattice-original machinery (the two clocks, the three layers,
job completion, the collaboration layer, trace, persistence, the Bridge) — are
all part of the build. The build order (§23) sequences them, a working loop
first and the rest layered on after, but sequencing is not optionality:
nothing here is deferred or droppable.

---

## 21. Reference repositories

These already exist (GitHub org `runcor-ai`). You are building fresh, but you
may study them, reuse logic, and copy code with attribution rather than
redesigning what already works.

- Engine — https://github.com/runcor-ai/runcor
- Existing lattice — https://github.com/runcor-ai/runcor-lattice
- Substrate — https://github.com/runcor-ai/runcor-substrate
- Identity — https://github.com/runcor-ai/runcor-identity
- Memory — https://github.com/runcor-ai/runcor-memory
- Goals — https://github.com/runcor-ai/runcor-goals
- Drives — https://github.com/runcor-ai/runcor-drives
- Temporal — https://github.com/runcor-ai/runcor-temporal
- Dialectic — https://github.com/runcor-ai/runcor-dialectic
- Watchdog — https://github.com/runcor-ai/runcor-watchdog
- Skills — https://github.com/runcor-ai/runcor-skills
- R++ language — https://github.com/runcor-ai/rpp
- R++ parser — https://github.com/runcor-ai/rpp-parser

External services the lattice connects to but does not contain:

- Integration — https://github.com/runcor-ai/runcor-integration
- Data Fabric — https://github.com/runcor-ai/runcor-data

---

## 22. Building with Spec Kit

This project must be built using **Spec Kit** — GitHub's open-source toolkit
for Spec-Driven Development (https://github.com/github/spec-kit, MIT licensed).

Spec Kit is a **development-time process tool, not a runtime dependency.** It
governs *how* the build is carried out; it adds nothing to the shipped lattice
and does not affect the self-contained goal of §17. It installs a `specify`
CLI and gives an AI coding agent a set of slash commands that turn a
specification into working software through ordered phases instead of one-
shot generation.

Use it as follows:

1. **Install and initialise.** Install the Specify CLI and run `specify init`
   with your coding-agent integration of choice, inside the new monorepo.

2. **Constitution** (`/speckit.constitution`). Seed the project's governing
   principles from the **pinned** decisions in this document — §2 and the
   consolidated pinned list in §20. These are the rules the build must not
   violate.

3. **Specify** (`/speckit.specify`). Use this intent document as the source
   material for the functional specification — what the lattice is and must do
   (§1, §3–§19). Behaviour, not implementation.

4. **Clarify** (`/speckit.clarify`). Resolve anything underspecified before
   planning. The item flagged to the operator — Bridge licensing (§19) — is a
   natural clarify target.

5. **Plan** (`/speckit.plan`). The technical decisions are already made and
   pinned here: TypeScript/Node monorepo, Vue.js Bridge UI, SQLite as the
   entity store, the swappable-backend engine. Feed these in directly rather
   than letting the plan step re-derive them.

6. **Tasks** (`/speckit.tasks`). Generate the task breakdown. The build order
   in §23 is the intended phasing — each vertical slice maps to a task group.

7. **Analyze** (`/speckit.analyze`). Run the cross-artifact consistency check
   before implementing.

8. **Implement** (`/speckit.implement`). Execute the tasks, vertical slice by
   vertical slice, per §23.

In short: this document is the *intent*; Spec Kit is the *process* that turns
it into the codebase.

---

## 23. Build order

Build a vertical slice first — one thin path working end-to-end — then widen.
This is a sequencing discipline, not a scoping one: the whole system below is in
scope. The order exists so the work stays coherent instead of tangled. Each
step should leave the system runnable; stop and harden whatever a step exposes
before moving on.

1. **One cycle, end-to-end.** The runcor engine skeleton, one model backend
   (direct API is simplest), a minimal capability and minimal perception, and
   the eight phases running once — producing a trace entry and a memory write.
   Stub generously.

2. **The continuous loop.** Cycles repeating; a minimal drive pulse driving
   them; no exit condition; the entity simply runs.

3. **Persistence and resume.** SQLite as the entity; the snapshot module;
   graceful shutdown. Kill the program and confirm it resumes from saved state
   on the next cycle.

4. **The four memory systems.** Identity, plan, episodic, semantic — each with
   its own survival rule. The admission rule as a gate. The decay formula on
   episodic. Index-plus-selector recall.

5. **Substrate.** The eleven laws compiled at prompt-top; the discernment gate
   with its four outcomes; the fast per-cycle `judge` check.

6. **The subconscious layer.** The deterministic, every-cycle sweep that fixes
   flat contradictions, flags them, and writes them to the trace.

7. **The two clocks.** The slow-clock worker as a separate process, fired every
   N cycles (load-aware), sharing the database under a lock, doing its two
   jobs — memory consolidation, and the LLM drift review that writes
   corrections into memory.

8. **The decider.** Both deciders, built and wired behind one interface — the
   single-model decider and the multi-model dialectic — with the Bridge dial
   selecting which a lattice uses. R++ structured prompts validated by the R++
   parser.

9. **Job completion and self-checks.** The plan's checklist structure;
   per-item completion checks (deterministic hooks plus a judgement pass);
   iteration on failure; deferral with a valid reason and an unblock condition;
   partial completion; autonomy-gated sign-off.

10. **The full capabilities surface.** The rich tool contract — read-only
    versus destructive, concurrency-safe, interrupt behaviour (§15); the
    perception-versus-action wiring; MCP and API connections.

11. **The remaining core components.** The full goals stack; the full drives
    model; temporal — deadlines and commitments in cycles; skills — the
    per-entity skill library, the specific-plus-generic extraction, minting
    from the passed items of completed and partially-completed jobs, and
    recall-and-apply of active skills into the decide phase; and watchdog on
    the slow clock.

12. **Model backends.** Add the host-CLI backend alongside the direct-API
    backend, behind one swappable interface.

13. **The collaboration layer.** Expose a lattice over MCP; the discovery
    registry (self-registration, slow-cycle polling for peers' one-sentence
    essence); conversation modelled as a job; delegation; the read-only shared
    source of truth.

14. **The Bridge.** The Bridge API, then the Vue UI — instantiate, roster,
    inspect, adjust — for single lattices.

15. **Company bundling and the prebuilt library.** The Bridge instantiates
    bundles of lattices, each with a seed prompt and starting knowledge,
    optionally pointed at a shared source of truth and a shared discovery
    registry; and the starter library of prebuilt role lattices (§19.2), so a
    company stands up from role bundles plus budgets plus seed prompts.

---

## 24. Testing — proving a lattice works

A lattice is meant to run unattended for long stretches. "It compiled" is not
evidence that it works. The build must include a **test suite the coding
agent can run** — written with `vitest` (§25), runnable with a single
command — that proves a lattice is genuinely functional.

The suite must cover, at minimum:

- **The loop turns.** A lattice steps through all eight cycle phases (§6) in
  order, repeatedly, with no exit condition.
- **Resume is real.** A lattice stopped mid-run and restarted restores its
  exact state from its SQLite file (§17) and continues on the next cycle —
  state before and after the restart is identical. This is the most important
  test in the suite: resume is the spine of the entity model.
- **The substrate enforces.** The discernment gate (§8.2) blocks outputs that
  violate the laws — a known-bad output is rejected, not merely logged — and
  the entity cannot read, reconfigure, or disable its own substrate.
- **Memory behaves.** The decay formula (§9.3) forgets and promotes at the
  right thresholds; identity never decays; the admission rule (§9.1) keeps
  re-perceivable facts out of memory.
- **Jobs complete and defer correctly.** A job closes only when its completion
  checks pass (§3.1); a genuinely blocked item defers with a reason and an
  unblock condition; a partially-completed job still mints skills from its
  passed items.
- **The slow clock fires.** The slow-clock worker (§7) wakes on cadence, runs
  consolidation and the drift review, and writes corrections into memory
  without interrupting the loop.

These tests are how an operator — and the coding agent — can trust a lattice before
budget and autonomy are handed to it. Tests land alongside the build, not
after: each build-order step (§23) is done when its tests pass.

---

## 25. Open-source plumbing libraries

"Self-contained" (§17) applies to the *cognitive* parts of the lattice — the
loop, the substrate, the memory logic — which are original work. It does **not**
mean hand-writing infrastructure. For ordinary plumbing, use well-maintained
open-source libraries.

The libraries below are **strong recommendations**, current as of this
writing. The build may substitute a different library where there is a
clear, stated reason — a better fit, a maintenance concern, a licensing
issue — but should not swap them on a whim, and should record any
substitution it makes.

- **SQLite driver — `better-sqlite3`.** The fastest and simplest SQLite
  library for Node; synchronous API, prebuilt binaries, very widely used. This
  is the entity store of §17.

- **Runtime validation — `zod`.** Validates configuration, MCP messages, and
  external input against typed schemas. The lattice takes untrusted input from
  many directions; validate it at the edges.

- **Bridge HTTP API — `fastify`.** Node-native, fast, with built-in
  schema-based validation. (`hono` is a reasonable alternative if multi-runtime
  deployment ever becomes a goal.)

- **Bridge UI — Vue 3, with `vite` (build and dev server) and `pinia`
  (state).** Vue is already pinned (§19); these are its standard companions.

- **MCP connectivity — the official Model Context Protocol SDK
  (`@modelcontextprotocol/sdk`).** For the perception and action connections of
  §15. Use the official SDK rather than a hand-rolled MCP client. For
  discovering available tools, point the lattice at the official **MCP
  Registry** (`modelcontextprotocol/registry`, self-hostable) and use
  `modelcontextprotocol/servers` for a baseline set of reference servers.

- **Model provider access — the official provider SDKs** (Anthropic, OpenAI,
  and so on), each behind the engine's swappable backend interface (§14). The
  host-CLI backend instead drives a coding-agent CLI on the operator's
  machine directly.

- **Semantic search (optional) — `sqlite-vec`.** Recall is index-plus-selector
  by default (§9.4) and needs no vector engine. If vector search is wanted
  later, `sqlite-vec` keeps it *inside* the SQLite file — no separate service,
  consistent with §17.

- **Embeddings (only if vector search is used) — a local embedding model via
  `transformers.js`, or a provider embedding API.** Needed to turn text into
  vectors for `sqlite-vec`. A local model keeps the lattice self-contained; a
  provider API is simpler but adds a network call. Not needed at all while
  recall stays index-plus-selector (§9.4). Do **not** adopt a full third-party
  "agent memory" framework — the memory design in §9 is original work and a
  framework's built-in memory model would conflict with it.

- **Testing — `vitest`.** Fast and TypeScript-native; also matches the
  existing `runcor-lattice` test suite, so reused tests carry over cleanly.

- **Monorepo management — `pnpm` workspaces**, optionally with `turborepo` for
  task orchestration across packages.

- **Logging — `pino`.** Low-overhead structured logging; pairs naturally with
  Fastify. This is distinct from the trace (§16) — the trace is the auditable
  cognitive record; logs are operational diagnostics.

Two notes. The R++ parser (§11) is already pure TypeScript with zero runtime
dependencies — bring it in from the runcor repo; it is not plumbing to source
elsewhere. And the two clocks (§4) are simply two Node processes — Node's own
process and timing primitives are enough; no orchestration library is needed.

---

*End of intent specification.*
