# Feature Specification: Lattice Core

**Feature Branch**: `001-lattice-core`

**Created**: 2026-05-24

**Status**: Draft

**Input**: User description: "Build the Runcor Lattice — one autonomous cognitive entity that operates continuously over long horizons, driving an LLM, with a Vue Bridge for instantiation/observation/control. Source: runcor-lattice-intent-spec.md"

> **Scope note.** This single feature spec covers the entire system. The intent
> spec §23 build order (15 vertical slices) is a *sequencing discipline*, not a
> scoping one — every user story below is in scope. Subsequent `/speckit-plan`
> and `/speckit-tasks` invocations may decompose this spec into vertical
> slices, but they all derive from this baseline.

## Clarifications

### Session 2026-05-24

- Q: How should the Bridge authenticate operators? → A: Single-tenant
  local-only (binds to loopback; OS access is the auth boundary).
- Q: What window does the `budget` dial enforce against? → A:
  Per-lattice-lifetime ceiling.
- Q: What's the Bridge's licensing/distribution model? → A: MIT License.
- Q: If a sense connector is unreachable when `observe` fires, what should
  the lattice do? → A: Skip that sense, log the failure, mark its
  last-known state stale in the trace, and continue the cycle. The loop
  MUST keep turning; one bad connector MUST NOT pause the entity.
- Q: Can one lattice hold multiple open jobs simultaneously? → A: Yes —
  many jobs may be open in plan memory at once; each cycle's `decide`
  phase chooses which job's next item to advance.
- Q: What does "byte-identical state" mean for resume parity? → A:
  Logical state equality — all persistent rows (memory, plan, identity,
  skills, cycle counter, dial positions, deferred items) are query-equal
  pre- and post-restart. SQLite file-bytes MAY differ (WAL checkpoint,
  vacuum); tests assert equality via queries, not file hashes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Operator instantiates a lattice (Priority: P1)

An operator opens the Bridge, fills in a form (identity seed, goals, dial
positions, memory source, model backend, tool manifest) and launches a new
lattice. The lattice begins cycling immediately and writes its first trace
entry within seconds.

**Why this priority**: Without instantiation there is no lattice. This is the
single most fundamental operator interaction; everything else assumes it.

**Independent Test**: Open the Bridge, submit a valid instantiation form,
observe the new lattice appearing on the roster with cycle count > 0 and a
non-empty trace within 10 seconds.

**Acceptance Scenarios**:

1. **Given** a clean Bridge with no lattices, **When** the operator submits a
   valid instantiation form, **Then** a new lattice is created with a fresh
   SQLite entity store, the operator's chosen dials are applied, and the
   lattice begins cycling.
2. **Given** an invalid or incomplete instantiation form (missing identity
   seed, missing model backend credentials), **When** the operator submits,
   **Then** the form rejects with field-level errors and no lattice is
   created.
3. **Given** an instantiation form whose tool manifest references an MCP
   server the substrate disallows, **When** the operator submits, **Then**
   the lattice is created with the disallowed entries omitted, and the
   operator is shown which entries were rejected and why.

---

### User Story 2 — A lattice lives, one cycle end-to-end (Priority: P1)

A lattice steps through the eight cycle phases in their pinned order
(`observe → ground → recall → decide → act → judge → write → pulse`),
producing exactly one trace entry per phase and at least one memory write per
cycle. The loop has no internal exit condition; cycles repeat indefinitely
until an operator stops the lattice.

**Why this priority**: This *is* the lattice. Without a turning loop, nothing
else has a substrate to run on. This is the smallest demonstrably-living
artefact and the gate on every subsequent slice.

**Independent Test**: Launch a lattice with a minimal manifest (one perception
source, one action capability) and observe N consecutive cycles each
recording 8 trace entries in the correct phase order, with the cycle counter
monotonically incrementing.

**Acceptance Scenarios**:

1. **Given** a freshly-instantiated lattice, **When** the loop runs, **Then**
   the first cycle visits phases in the order observe → ground → recall →
   decide → act → judge → write → pulse, with one trace entry per phase.
2. **Given** a running lattice, **When** cycle N completes pulse, **Then**
   cycle N+1 begins at observe with no other action required — there is no
   "engagement complete" exit.
3. **Given** a lattice in any phase, **When** that phase produces no useful
   work (e.g. perception finds nothing new, decide chooses to act on
   nothing), **Then** the cycle still completes all eight phases and the
   trace records the empty result rather than skipping the phase.
4. **Given** a lattice's perception of an unblocked deferred-item condition,
   **When** decide runs next, **Then** the unblocked item is available in
   the choice set; the lattice is not forced to interrupt mid-cycle.

---

### User Story 3 — An entity survives a restart (Priority: P1)

A lattice is stopped mid-run; the next start resumes on the very next cycle
with state byte-identical to the moment before stop. The cycle counter is
continuous; identity, plan, episodic, and semantic memory all survive; the
trace is contiguous across the restart boundary.

**Why this priority**: This is the spine of the entity model. The intent spec
calls it "the most important test in the suite". Without resume parity, the
"continuous entity" abstraction is a lie.

**Independent Test**: Take a state snapshot, send SIGTERM to the lattice
process, restart it, take a second snapshot, and assert byte-equality of all
persistent state (excluding the trace's restart-marker entry).

**Acceptance Scenarios**:

1. **Given** a running lattice at cycle N, **When** the operator stops the
   process and restarts it, **Then** the next cycle is N+1 (not 1, not N),
   and the lattice's identity, plan, episodic memory, semantic memory, and
   skill library are unchanged.
2. **Given** a lattice killed mid-cycle (e.g. between decide and act),
   **When** restarted, **Then** the cycle counter advances to the next
   cycle boundary (the partial cycle is discarded) and the trace records the
   interruption.
3. **Given** the lattice's local SQLite file is missing on startup but a
   snapshot exists at the configured durable location, **When** the lattice
   starts, **Then** state is restored from the snapshot first and the
   lattice resumes; the trace records the restore.
4. **Given** two lattice processes accidentally point at the same SQLite
   file, **When** the second starts, **Then** it refuses to start and emits
   an operational error referencing the existing process holder.

---

### User Story 4 — The substrate enforces the laws every cycle (Priority: P1)

Every model call the lattice makes is wrapped by the substrate. The eleven
declarative laws sit compiled at the top of every prompt. The discernment
gate evaluates the output against the laws with four possible outcomes
(pass, modify, block, escalate). Known-bad outputs are rejected, not merely
logged. The entity cannot read, configure, or bypass its own substrate.

**Why this priority**: The substrate is what makes the laws *enforced
physics* rather than ignorable prompt text. Without it, every other principle
is best-effort. P1 because every other model-using slice depends on it
working.

**Independent Test**: Submit a known-bad output (a Reality violation, e.g. a
proposed action referencing an entity not in the cycle's reality slice) and
assert the gate blocks it; submit a Constraint violation and assert the same;
verify the lattice has no API to read or disable the substrate.

**Acceptance Scenarios**:

1. **Given** a model call from any phase, **When** the substrate wraps it,
   **Then** the eleven laws appear at the top of the compiled prompt in the
   pinned order with no rewording.
2. **Given** a model output that violates the Reality law, **When** the
   discernment gate evaluates it, **Then** the outcome is `block`, the
   reason is logged to the trace, and the proposed action does not execute.
3. **Given** a model output that violates the Simplicity law only, **When**
   the gate evaluates it, **Then** the outcome is `pass` with the violation
   logged as advisory; the action proceeds.
4. **Given** a lattice running at the highest autonomy, **When** the gate
   `escalate`s, **Then** the lattice self-corrects without operator input;
   at the lowest autonomy the same flag pauses the cycle and waits.
5. **Given** any attempt by lattice code or skill to read, modify, or
   disable substrate state, **Then** the attempt fails with no possible
   bypass path.

---

### User Story 5 — An operator inspects a running lattice (Priority: P2)

The Bridge dashboard shows all instantiated lattices with status, cycle
count, current plan, goals, and budget. Clicking into a lattice opens a
detail view with the live trace stream, current memory state (identity,
plan, episodic, semantic summaries), current dial positions, recent
decisions, and the drift/correction history from the slow clock.

**Why this priority**: Operators need to *see* what their autonomous entities
are doing before they can trust them with real budget. P2 because instantiate
+ live + resume + substrate (P1) must all work first or there is nothing
meaningful to observe.

**Independent Test**: With at least one running lattice, open the Bridge
roster and assert all P1 lattices appear with current cycle count; click in
and confirm the live trace stream updates within 2 seconds of new cycles.

**Acceptance Scenarios**:

1. **Given** N running lattices, **When** the operator opens the roster,
   **Then** all N appear with their current status, cycle count, plan
   summary, goal summary, and remaining budget.
2. **Given** a selected lattice, **When** the operator opens its detail view,
   **Then** the live trace stream shows new entries within 2 seconds of
   their being written, and memory/dial views reflect the current state.
3. **Given** a lattice running with a Bridge connection that drops, **When**
   the Bridge reconnects, **Then** the trace stream catches up without
   missing entries and the operator sees a connection-state indicator.

---

### User Story 6 — An operator adjusts a running lattice mid-flight (Priority: P2)

The operator changes any dial (autonomy, exploration, memoryDurability,
promotionThreshold, memoryRecallBreadth, planStability, dialecticDepth,
reviewCadence, drivePressure, riskTolerance, budget) on a running lattice.
The operator can pause/resume/stop the lattice, force a replan, raise budget,
or swap model backend. Adjustments take effect on the next cycle and are
recorded in the trace.

**Why this priority**: A lattice the operator can only observe is a static
artefact. P2 because inspection (US5) is the prerequisite — there's no
point adjusting something you can't see.

**Independent Test**: Move each dial from its default to a new value while
the lattice is cycling; assert the new value is in effect on the next cycle
and the change is in the trace.

**Acceptance Scenarios**:

1. **Given** a lattice cycling at autonomy=high, **When** the operator
   lowers autonomy to medium and a substrate flag fires next cycle, **Then**
   the lattice escalates rather than self-correcting.
2. **Given** a lattice with budget approaching its ceiling, **When** the
   operator raises the budget, **Then** the lattice resumes cycling without
   restart and the trace records the budget change.
3. **Given** a running lattice, **When** the operator swaps the model
   backend from direct API to the host-CLI backend, **Then** subsequent
   model calls route to the new backend on the next cycle, and the lattice
   itself is unaware of the switch (no identity or memory disruption).
4. **Given** a paused lattice, **When** the operator resumes, **Then**
   cycling continues from the cycle counter at pause time, not from cycle 1.

---

### User Story 7 — A lattice takes on a job and works it to completion (Priority: P2)

A job is given to the lattice (by an operator or by another lattice via
delegation). The lattice writes the job's checklist into its plan memory,
defines per-item completion checks (deterministic hooks plus a judgement
pass), iterates on failing items, may defer items with a valid externally-
grounded reason and an unblock condition, and closes the job — fully or
partially. Sign-off follows the autonomy dial.

**Why this priority**: Jobs are how operators get value out of a lattice. P2
because the loop, the substrate, inspection, and adjustment (P1+US5+US6) must
work before jobs can be reliably driven.

**Independent Test**: Hand a small job with three deterministically-checkable
items to a lattice; observe one fail; observe the lattice iterate to fix it;
observe one item defer with a recorded reason; observe the job close as
partially-complete with the deferred item carried forward.

**Acceptance Scenarios**:

1. **Given** a job whose checklist contains only items with deterministic
   hooks, **When** the lattice executes it, **Then** the job closes only
   when every item's hook passes — never by lattice assertion.
2. **Given** a checklist item whose completion check fails, **When** the
   lattice runs decide next, **Then** the failed item is selected for
   another pass; the iteration count and what failed are recorded in the
   trace.
3. **Given** an item whose unblock condition is "stakeholder X provides
   budget figure", **When** perception detects the figure has arrived,
   **Then** the deferred item becomes available for the next decide choice;
   the lattice does not interrupt its current cycle to handle it.
4. **Given** a job closing with one deferred item at high autonomy, **When**
   the lattice marks the job as partially complete, **Then** the trace
   records the closure with the deferred item, its reason, and its unblock
   condition; the operator is not asked to confirm. At low autonomy the same
   close awaits operator confirmation.
5. **Given** any attempt to mark an item passed without its check actually
   passing, **Then** the attempt is rejected and the trace records the
   refusal.

---

### User Story 8 — The subconscious quietly corrects flat problems (Priority: P2)

On every cycle's write phase, a deterministic sweep examines stored state
for *flat* contradictions (stale values, stored state that plainly
contradicts a current semantic rule, simple inconsistencies). When the
sweep finds one, it fixes it, flags it so the same cycle's judgement knows
a correction occurred, and writes the change to the trace.

**Why this priority**: This is half of the self-maintenance model. P2 because
the loop, substrate, and trace (P1) are the prerequisites — there's nothing
to sweep without persistent state being written first.

**Independent Test**: Plant a known flat inconsistency in semantic memory
(e.g. a fact contradicted by a current rule); run one cycle; assert the
inconsistency is fixed, the cycle's judgement context shows the correction
flag, and the trace contains the correction record.

**Acceptance Scenarios**:

1. **Given** a flat inconsistency in semantic memory, **When** the write
   phase runs the sweep, **Then** the inconsistency is fixed and a
   correction record appears in the trace with what was wrong, what changed,
   and when.
2. **Given** an issue that requires judgement (e.g. competing reasonable
   interpretations of an observation), **When** the sweep encounters it,
   **Then** the sweep does NOT act and the issue is escalated to the work
   layer.
3. **Given** the same correction firing on consecutive cycles for the same
   record, **When** the operator inspects the trace, **Then** the pattern
   is visible (the safeguard against a misbehaving subconscious).

---

### User Story 9 — The slow clock dreams and checks for drift (Priority: P2)

A separate background worker, running as its own process and sharing the
SQLite file under a lock, wakes every N cycles (load-aware, baseline ~100)
and does two things: consolidates memory (merges new learning, prunes the
index, deletes facts that turned out wrong) and runs an LLM drift review
against the entity's recent life. If drift is found, the worker writes a
correction *into memory*; it does not reach into the running loop. Both
the worker and the main loop survive process restart.

**Why this priority**: Without the slow clock, memory grows unbounded and
no genuine drift is ever caught. P2 because resume (P1 US3) must work first;
the slow clock relies on the same persistence model.

**Independent Test**: Run a lattice for >100 cycles; assert the slow clock
wakes within the load-aware cadence window; assert memory consolidation
occurred (index reduced); assert drift review wrote at least one
correction-or-confirmation record; assert the main loop never stopped.

**Acceptance Scenarios**:

1. **Given** a lattice with ~100 cycles of episodic memory accumulated,
   **When** the slow clock wakes, **Then** consolidation runs, the memory
   index size after is bounded under the configured cap, and identity is
   untouched.
2. **Given** a slow-clock wake-up, **When** drift is found, **Then** a
   correction memory is written; the fast loop is not interrupted; the
   correction is picked up by the next cycle's recall naturally.
3. **Given** the operator changes `reviewCadence` from the default to a
   different value, **When** the next slow-clock cycle-count target is
   recalculated, **Then** the worker fires at the new cadence on the next
   eligible wake.
4. **Given** the lattice process is suspended and then resumes much later
   (e.g. laptop sleep), **When** wake-up eligibility is computed, **Then**
   only the most recent missed wake is fired (not all of them).

---

### User Story 10 — A lattice connects to the world (Priority: P2)

A lattice's tool manifest at instantiation is its starting set of
capabilities — each entry marked as a sense (read automatically in observe),
an action (invoked in act), or both. An empty manifest is legal. Over its
life, the lattice extends the manifest through *governed* tool discovery: it
queries the official MCP Registry, evaluates candidates against substrate
constraints, and adopts those that pass. At most one capability is invoked
per cycle.

**Why this priority**: A lattice that can't read the world or change it does
nothing useful. P2 because the loop and substrate (P1) must exist for tools
to plug into.

**Independent Test**: Instantiate a lattice with a manifest containing one
sense and one action; observe perception happens automatically every cycle;
observe at most one action per cycle; trigger tool discovery and observe a
new candidate is evaluated against substrate constraints before adoption.

**Acceptance Scenarios**:

1. **Given** a manifest with both a sense and an action connector, **When**
   each cycle runs, **Then** the sense is read automatically in observe and
   at most one action is invoked in act.
2. **Given** an empty manifest, **When** the lattice cycles, **Then** the
   loop still turns, the trace still records cycles, but act records "no
   action available" rather than failing.
3. **Given** tool discovery returns a candidate MCP server that conflicts
   with substrate constraints (e.g. requires capabilities the substrate
   disallows for this lattice), **When** the lattice evaluates it, **Then**
   the candidate is rejected, the rejection reason is logged, and the
   manifest is not updated.
4. **Given** a connector that has both a sense channel and an action
   channel, **When** wired with both, **Then** observe consumes only the
   sense channel and act uses only the action channel; the two never
   collide on the same cycle.

---

### User Story 11 — The lattice learns: skills are minted, offered, and chosen (Priority: P3)

When a job closes (fully OR partially), skills are extracted from its
*passed* items at two levels: a specific extraction (the concrete pattern
from the work just done) and a generic extraction (the same pattern
abstracted so it transfers to new domains). Skills are stored as Claude
`SKILL.md` files with frontmatter (name, description) and an R++ body. In
future cycles, the lattice is *shown* skill descriptions in recall; in
decide it judges which fit the work in front of it; only chosen skills have
their R++ body loaded into the decide prompt.

**Why this priority**: Skills are how the lattice gets sharper over its
whole life and how competence transfers between domains. P3 because the
loop, substrate, jobs, and recall must work first.

**Independent Test**: Have a lattice complete a small job with one item
passing and one item deferred; assert a skill is minted from the passed item
only (specific + generic extractions); on a later cycle in a different but
shape-matching context, assert the generic skill's description surfaces in
recall and the lattice chooses to apply it.

**Acceptance Scenarios**:

1. **Given** a job that closed fully, **When** skill minting runs, **Then**
   one specific and one generic skill are extracted for each passed item,
   stored as SKILL.md with parser-validated R++ bodies, and proposed (not
   auto-activated).
2. **Given** a job that closed partially with one deferred item, **When**
   minting runs, **Then** no skill is extracted from the deferred item; the
   passed items still mint skills.
3. **Given** a stored generic skill whose description matches the shape of
   the current work, **When** recall runs, **Then** the description appears
   in the candidate set; the lattice judges whether to apply it; only on
   choosing is the R++ body loaded.
4. **Given** a lattice that exposes its skills over MCP, **When** an
   external query reads them, **Then** the lattice's own skill store is
   served read-only; the no-shared-memory rule still holds.

---

### User Story 12 — Lattices work together (Priority: P3)

A lattice exposes itself over MCP. Peer discovery uses a registry: lattices
self-register their one-sentence essence on startup; peers are read on the
slow cycle. Three forms of collaboration are permitted: conversation
(modelled as a job — the loop keeps turning; if the peer is silent the
conversation job defers with unblock condition "peer responds"); delegation
(one lattice owns a plan and hands pieces out as jobs to other lattices);
read-only shared source of truth (an external service all participants
read). No shared memory under any circumstance.

**Why this priority**: Multi-lattice collaboration is what unlocks
"companies of lattices". P3 because the single-lattice substrate (P1) plus
jobs (US7) must work first — collaboration reuses both.

**Independent Test**: Run two lattices pointing at a shared registry; assert
each sees the other within one slow-cycle window; initiate a conversation
job from one to the other; kill the responder; assert the conversation
defers rather than blocks; restart the responder; assert the conversation
resumes.

**Acceptance Scenarios**:

1. **Given** two lattices and an empty registry at startup, **When** both
   start, **Then** both self-register their one-sentence essence; each sees
   the other's entry on the next slow-cycle peer read.
2. **Given** a CEO lattice opens a conversation job with a CFO lattice,
   **When** the CFO responds, **Then** the CEO's conversation job advances
   on the next cycle; if the CFO is silent for a configurable interval the
   conversation job defers with unblock condition "CFO responds".
3. **Given** a manager lattice owns a plan and delegates one item as a job
   to a worker lattice, **When** the worker reports back, **Then** the
   manager folds the report into its own plan memory — the worker never
   wrote to the manager's plan directly.
4. **Given** a lattice that has discovered a peer it has no standing to
   engage (per Law 11), **When** the lattice decides what to do, **Then**
   it does not initiate a conversation; the trace records the recognised
   peer and the standing-based non-engagement.
5. **Given** any attempt by one lattice to read or write another lattice's
   SQLite file, **Then** the attempt is rejected at the access layer.

---

### User Story 13 — The operator stands up a company of lattices (Priority: P3)

The Bridge instantiates a *bundle* of pre-built role lattices (CEO, CFO,
marketing, sales, …) packaged together. Each pre-built lattice is a bundle
of three pre-written things: a seed prompt (who this lattice is in this
role), starting knowledge (loaded into memory at instantiation), and
sensible dial defaults plus a starting tool manifest. The operator picks
roles, gives each a budget, optionally adjusts the seed prompt, optionally
points the bundle at a shared source of truth and a shared registry, and
launches. Each member is still an ordinary lattice — the bundle is only
pre-written configuration.

**Why this priority**: This is the end-goal — autonomous companies — but
it's pure Bridge-layer packaging on top of P1+US12. P3 because everything
under it must work first.

**Independent Test**: Pick three role bundles from the prebuilt library,
assign budgets, click instantiate; assert all three lattices appear on the
roster within the success-criteria window; assert each starts with its
seeded identity and starting knowledge in place.

**Acceptance Scenarios**:

1. **Given** a prebuilt library containing at least three role bundles,
   **When** the operator selects them and submits the company-instantiation
   form, **Then** N ordinary lattices are created, each with its pre-written
   seed prompt, starting knowledge, dial defaults, and tool manifest in
   place, and each begins cycling.
2. **Given** a bundle pointed at a shared registry and a shared source of
   truth, **When** members start, **Then** they self-register on the
   registry and can read the source of truth; they STILL do not share
   memory.
3. **Given** the operator adjusts one bundle's seed prompt before launch,
   **When** that lattice instantiates, **Then** its identity reflects the
   override and the other bundles use their defaults.
4. **Given** the prebuilt library wants a new role added, **When** the
   developer ships three new files (seed prompt, starting knowledge, dial
   defaults + manifest), **Then** the role appears in the Bridge picker
   with no runtime changes required.

---

### Edge Cases

- **Cold start with no prior state.** A first-ever start: Bridge
  instantiation provides the seed identity; cycle counter starts at 0; a
  fresh SQLite file is created; the snapshot module is told there is no
  prior state to restore.
- **Crash mid-cycle.** Snapshot writes are transactional at cycle
  boundaries; either the cycle's writes committed or they didn't. On
  restart the loop resumes from the next-cycle boundary. The interrupted
  cycle's partial work is discarded and the trace records the interruption.
- **Snapshot destination unreachable.** The lattice continues cycling; the
  snapshot module records the failure to operational logs and retries; the
  operator is alerted via the Bridge. State is never lost because the local
  SQLite file is the authority; the snapshot is a copy.
- **Slow clock delayed.** Only the most recent missed wake is fired (the
  worker computes "should I wake?" each tick based on cycles-since-last-
  wake, not on a wall-clock schedule). Consolidation and drift review are
  idempotent across single-wake firings.
- **Job's completion check fails repeatedly.** Per-job iteration is the
  default; deferral with a *valid externally-grounded reason* is the safety
  valve. A check that has failed beyond a configurable iteration count
  escalates per the autonomy dial (operator can confirm continued
  iteration, accept deferral, or close the job partially).
- **Deferred item unblocks mid-job.** No interruption. The unblocked item
  becomes available in the next decide phase's choice set.
- **Discernment escalates at low autonomy.** The cycle pauses at the judge
  phase; the trace records the escalation; the operator approves or rejects
  via the Bridge; on rejection the lattice retries decide; on approval the
  cycle continues to write and pulse.
- **MCP server conflicts with substrate constraints.** The candidate is
  evaluated by the substrate before manifest update. On conflict the
  candidate is rejected, the rejection reason is logged, and the manifest
  is unchanged.
- **Peer unreachable.** The conversation job defers with unblock condition
  "peer responds"; perception polls for the response; the lattice continues
  doing other work in the meantime.
- **Two processes target the same SQLite file.** A lock-file primitive at
  the entity level: the second process refuses to start and emits an
  operational error referencing the existing holder.
- **Model backend hits a usage limit mid-cycle.** The model call returns a
  recognisable failure; the lattice marks the current cycle's act as
  failed; if a job was in progress, the relevant item defers with unblock
  condition "model backend usage window resets at TIMESTAMP" (when known);
  the operator is alerted; subsequent cycles still run for non-model work
  (perception, trace writes).

## Requirements *(mandatory)*

### Functional Requirements

**The cycle and the loop**

- **FR-001**: The lattice MUST execute every cycle as one pass through the
  eight phases `observe → ground → recall → decide → act → judge → write →
  pulse`, in that exact order.
- **FR-002**: Each phase MUST produce exactly one trace entry per cycle,
  including phases that produced no work.
- **FR-003**: The loop MUST NOT contain a termination condition that fires
  from inside the loop. The only legitimate stop sources are an operator
  stop, a process kill, or an unrecoverable substrate-internal fault.
- **FR-004**: The `act` phase MUST execute at most one capability per cycle.
- **FR-005**: `observe` MUST be automatic — not a capability the lattice
  chooses to invoke. It reads what is new since the last cycle from every
  sense connector in the manifest, plus checks each deferred item's unblock
  condition. When a sense connector is unreachable, `observe` MUST skip that
  sense, log the failure to operational logs, mark the sense's last-known
  state stale in the trace, and let the cycle continue. A single failing
  connector MUST NOT pause the loop.

**Persistence and resume**

- **FR-006**: The lattice's persistent state (memory, identity, plan,
  skills, cycle counter, dial positions) MUST live in a single SQLite file
  per lattice — no other authoritative store.
- **FR-007**: On restart, the lattice MUST resume on the cycle immediately
  following the last-committed cycle, with persistent state **logically
  equal** (query-equal across all persistent rows: memory, plan, identity,
  skills, cycle counter, dial positions, deferred items) to the last-
  committed snapshot, excluding the new restart-marker trace entry. SQLite
  file-byte equality is NOT required (WAL checkpoint, vacuum, and other
  SQLite-internal operations MAY rewrite bytes); equality is asserted via
  queries, not file hashes.
- **FR-008**: Snapshot durability MUST be provided by a swappable module
  whose destination (local folder, cloud bucket, etc.) can be changed
  without code changes to the lattice itself.
- **FR-009**: When the local SQLite file is missing but a snapshot exists
  at the configured durable destination, the lattice MUST restore from
  snapshot before starting the loop.
- **FR-010**: Concurrent access to the same SQLite file by two lattice
  processes MUST be prevented; the second starter MUST fail with an
  operational error referencing the holder.

**Memory**

- **FR-011**: Memory MUST be organised into four distinct systems —
  identity, plan, episodic, semantic — each with its own survival rule.
  These MUST NOT be unified into a single decaying store.
- **FR-012**: Identity memory MUST be immune to the decay formula.
- **FR-013**: Episodic memory MUST decay per the formula `M = R × ln(f + 1)
  × e^(-t / (τ × D))`, with operator-controllable thresholds and
  parameters. Defaults: forget at `M < 0.05`; promote at `M > 0.6`.
- **FR-014**: The admission rule MUST be enforced at write: a thing
  becomes a memory only if it cannot be reconstructed from the live world.
  Re-perceivable facts (file contents, tracker state, code structure)
  MUST NEVER be stored as memory.
- **FR-015**: Every stored memory MUST record its "why" — the reason for
  storing — alongside its content. Relative dates MUST be converted to
  absolute dates on write.
- **FR-016**: Recall MUST use an index-plus-cheap-selector pattern by
  default; a vector-search backend MAY be plugged in later behind the same
  interface.
- **FR-017**: Old memories pulled into a cycle MUST carry an age expressed
  in human terms ("47 days ago") with a freshness caveat when stale.

**Substrate and discernment**

- **FR-018**: Every model call the lattice makes MUST be wrapped by the
  substrate. There MUST be no path that calls a model without the wrap.
- **FR-019**: The eleven declarative laws MUST sit compiled at the TOP of
  every wrapped prompt, in the pinned order, with no rewording.
- **FR-020**: The discernment gate MUST evaluate each model output against
  every law and MUST yield one of four outcomes per output: `pass`,
  `modify`, `block`, `escalate`.
- **FR-021**: Reality and Constraint violations MUST always produce
  `block`. Uncertainty violations MUST produce a logged warning. Simplicity
  violations MUST produce an advisory log only (never blocking).
- **FR-022**: The lattice — including any skill the lattice loads — MUST
  have no API surface that lets it read, modify, or disable substrate
  state.
- **FR-023**: The `autonomy` dial MUST control what happens to discernment
  flags: at the highest setting the lattice self-corrects (modify/block
  rerun decide internally); at the lowest setting the same flag pauses
  the cycle and waits for operator decision via the Bridge.

**R++ structured prompts**

- **FR-024**: Every model call across the system — decide, ground, skill
  synthesis, identity reflective update, goal proposal, slow-clock sleep
  pass, slow-clock drift review, and any future call — MUST be built and
  validated as R++ via the `rpp-parser`. A parse failure MUST prevent the
  call from going out.

**Two clocks**

- **FR-025**: The fast loop and the slow-clock worker MUST run as two
  separate OS processes sharing one SQLite file under a lock file.
- **FR-026**: The slow clock MUST fire on cycle count (load-aware,
  baseline ~100), not on a wall-clock timer. The cadence MUST be
  adjustable at runtime via the `reviewCadence` dial.
- **FR-027**: The slow-clock worker MUST perform two responsibilities per
  wake: memory consolidation and an LLM drift review. Both MUST be
  idempotent across a single-wake firing.
- **FR-028**: When the slow clock finds drift, it MUST write a correction
  into memory. It MUST NOT directly interrupt or signal the running loop.
- **FR-029**: After a long delay (e.g. machine sleep) the worker MUST fire
  only the single most recent missed wake, not every missed wake.

**Self-maintenance / subconscious**

- **FR-030**: The `write` phase of every cycle MUST run a deterministic
  sweep that examines stored state for flat (judgement-free) contradictions.
- **FR-031**: When the sweep acts it MUST do three things together: fix
  the issue, flag the correction so the same cycle's judgement knows
  (made visible on the next cycle's recall), and write the correction to
  the trace.
- **FR-032**: The sweep MUST NEVER act on anything that requires a
  judgement call. Such cases MUST be left for the work layer to handle.

**Jobs and completion**

- **FR-033**: A job MUST be represented in plan memory as a checklist
  whose items each carry a completion check (deterministic hooks where
  possible + a judgement pass for the remainder) and a state (open,
  passed, deferred). A lattice MAY hold **multiple open jobs**
  simultaneously in plan memory; each cycle's `decide` phase chooses
  which job's next item to advance, based on judgement (priority,
  deadlines from the temporal layer, drives, deferral status).
- **FR-034**: An item MUST NOT be marked `passed` except by its completion
  check actually passing. Any attempt to assert a pass MUST be rejected
  and recorded in the trace.
- **FR-035**: A failed completion check MUST iterate: the item stays open
  and the lattice attempts another pass on the next decide.
- **FR-036**: Deferral MUST be permitted only with both a valid
  externally-grounded reason (genuine blocker, missing dependency,
  contradiction in source material) AND an unblock condition (what must
  become true for the item to be revisitable). "This was hard" or "I
  judged it unnecessary" MUST be rejected as reasons.
- **FR-037**: A job MAY close as partially complete with deferred items
  carried forward in plan memory.
- **FR-038**: When perception detects an unblock condition met, the
  deferred item MUST become eligible for the next decide phase's choice
  set; the lattice MUST NOT interrupt its current cycle to handle it.
- **FR-039**: Job sign-off (close + deferral certification) MUST follow
  the `autonomy` dial: at high autonomy the lattice closes/certifies
  itself; at low autonomy the close awaits operator confirmation.
- **FR-040**: Every job completion, every deferral, every unblock-and-
  resume MUST be recorded in the trace.

**Capabilities and the world**

- **FR-041**: A lattice MUST be given a tool manifest at instantiation.
  An empty manifest MUST be legal.
- **FR-042**: Each manifest entry MUST be marked as a sense (read in
  observe), an action (invoked in act), or both. Sense and action channels
  on a dual-mode connector MUST never collide on the same cycle.
- **FR-043**: Tool discovery MUST query the official MCP Registry and
  evaluate candidates against substrate constraints before adding them to
  the manifest. Rejected candidates MUST be logged with a reason.

**Collaboration**

- **FR-044**: A lattice MUST NEVER read or write another lattice's SQLite
  file. Any attempt MUST be rejected at the access layer.
- **FR-045**: Collaboration between lattices MUST use only one of three
  permitted forms: conversation (modelled as a job on the calling
  lattice's plan), delegation (one owner, hands out items as jobs), or a
  read-only shared external source of truth.
- **FR-046**: Peer discovery MUST use a registry. Lattices MUST self-
  register their one-sentence essence on startup. Peer reads MUST happen
  on the slow cycle.
- **FR-047**: Discovering a peer MUST NOT, by itself, grant standing to
  engage it. Engagement decisions MUST be made by the lattice's own
  identity and Law 11 (Standing).
- **FR-048**: When a conversation peer goes silent past a configurable
  interval, the conversation job MUST defer with unblock condition "peer
  responds", not block the loop.

**Trace**

- **FR-049**: Every cycle, every subconscious correction, every job
  completion/deferral/unblock, and every substrate flag MUST be recorded
  in an auditable trace. The raw trace MUST be JSONL; the trace MUST also
  be readable via an indexed store the Bridge can query.
- **FR-050**: Operational logs (diagnostics) MUST be a separate stream
  from the cognitive trace; they MUST NOT be conflated.

**Bridge — operator surface**

- **FR-051**: The Bridge MUST support the four pinned operations and only
  those: instantiate, roster, inspect, adjust.
- **FR-052**: The Bridge MUST NOT run lattices, route work between them,
  hold shared state, execute tool calls on their behalf, or make model
  calls on their behalf.
- **FR-053**: The Bridge MUST be able to instantiate single lattices and
  *bundles* (companies) of pre-built role lattices.
- **FR-054**: The Bridge MUST present every dial named in FR-023, plus
  exploration, memoryDurability, promotionThreshold, memoryRecallBreadth,
  planStability, dialecticDepth, reviewCadence, drivePressure,
  riskTolerance, and budget — as live adjustments that take effect on the
  next cycle.
- **FR-055**: The Bridge MUST run **single-tenant, local-only**: it binds
  to localhost (127.0.0.1) by default and treats OS-level access to the
  host as the authentication boundary. No login screen, no account model,
  no remote access in v1. An operator who wants remote use is responsible
  for tunnelling (SSH, VPN, etc.). A future multi-user mode is OUT of
  scope for v1; the Bridge MUST NOT bind to a non-loopback interface
  without an explicit operator configuration override.
- **FR-056**: The `budget` dial MUST enforce a **per-lattice-lifetime**
  ceiling (dollars, tokens, or wall-time, per operator's chosen unit).
  When a lattice's cumulative spend reaches its budget, model-using
  phases MUST refuse further calls and the lattice MUST pause those
  phases until the operator raises the ceiling via the Bridge. Non-model
  work (perception, trace-write) MAY continue. The budget MUST be
  recorded in the trace each cycle so spend is auditable.

**Distribution / licensing**

- **FR-057**: The Runcor Lattice (including the Bridge) MUST be released
  under the **MIT License**. The full source MUST be published; anyone
  may self-host, fork, modify, and redistribute. The repository's root
  MUST contain a `LICENSE` file with the MIT text. This matches the
  Spec Kit ecosystem (also MIT) and the runcor reference repositories.

### Key Entities

- **Lattice** — one autonomous cognitive entity. Owns exactly one SQLite
  file containing all of its persistent state. Identified by a stable ID.
  Cycles continuously.
- **Cycle** — one pass through the eight phases. Numbered monotonically
  per lattice. Produces 8 trace entries minimum, 1+ memory writes, at
  most 1 action.
- **Job** — a discrete piece of work owned by exactly one lattice. Lives
  in plan memory as a checklist of items with completion checks and
  states. Closes when all items are passed or validly deferred. A lattice
  MAY hold multiple open jobs concurrently; `decide` chooses which one's
  next item to advance per cycle.
- **Checklist Item** — a unit of work within a job, with a completion
  check (deterministic hook + optional judgement pass), a state (open /
  passed / deferred), and, when deferred, a reason and unblock condition.
- **Memory Entry** — a unit of stored knowledge in one of the four
  memory systems. Carries its "why", absolute timestamps, and (for
  episodic) decay parameters R, f, t.
- **Skill** — a SKILL.md file with frontmatter (name, description) and
  an R++ body. Minted from passed items of completed/partially-completed
  jobs at two abstraction levels (specific + generic). Proposed, not
  auto-applied.
- **Tool / Capability** — a manifest entry referencing an MCP server or
  API connection, marked as sense, action, or both. At most one action
  invoked per cycle.
- **Trace Entry** — one JSONL record per phase per cycle, plus records
  for subconscious corrections, job closures, deferrals, unblocks, and
  substrate flags. Indexed for Bridge query.
- **Dial** — a runtime-adjustable operator parameter. Twelve named dials
  (autonomy, exploration, memoryDurability, promotionThreshold,
  memoryRecallBreadth, planStability, dialecticDepth, reviewCadence,
  drivePressure, riskTolerance, budget). Adjustments take effect on the
  next cycle.
- **Substrate** — the enforced physics layer: eleven laws, identity
  prior, reality slice, discernment gate. Wraps every model call.
  Invisible to and uneditable by the lattice itself.
- **Registry Entry** — a peer lattice's address + one-sentence essence,
  posted by that lattice on startup, read by other lattices on their
  slow cycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A lattice runs unattended for at least **1,000 consecutive
  cycles** without operator intervention, with the cycle counter advancing
  monotonically and no internal loop exit.
- **SC-002**: A lattice stopped mid-run resumes within **5 seconds** with
  persistent state **logically equal** to the pre-stop snapshot (query-
  equal across all persistent rows; SQLite file-bytes MAY differ),
  excluding the restart-marker trace entry, and the cycle counter at
  exactly N+1 where N was the last committed cycle.
- **SC-003**: The slow clock fires at the configured cadence (baseline
  ~100 cycles), within **±10%** of the target under steady load.
- **SC-004**: The discernment gate rejects **100%** of test outputs that
  violate Reality or Constraint laws, with no false-passes.
- **SC-005**: An operator instantiating a single lattice via the Bridge
  sees that lattice on the roster, with cycle count > 0 and a non-empty
  trace, in under **10 seconds**.
- **SC-006**: An operator instantiating a company of N pre-built lattices
  via the Bridge sees all N lattices cycling within **5 minutes** of
  clicking instantiate.
- **SC-007**: A deferred job item whose unblock condition is met becomes
  live work within **1 cycle** of perception confirming the condition.
- **SC-008**: A dial adjustment made via the Bridge takes effect on the
  lattice's very next cycle (within **2 cycles** of the operator action,
  to allow for the change to propagate via memory).
- **SC-009**: After 1,000 cycles, episodic memory's stored size remains
  bounded — the slow-clock consolidation keeps the index under its
  configured cap (operator-set; default validated in tests).
- **SC-010**: 100% of model calls across the system are parser-validated
  R++ — there is no path that emits a non-R++ prompt.
- **SC-011**: 100% of cycles, subconscious corrections, job
  closures/deferrals/unblocks, and substrate flags are present in the
  trace — auditable end-to-end.
- **SC-012**: A lattice attempting to read or write another lattice's
  SQLite file is rejected **100%** of the time at the access layer.

## Assumptions

- The R++ parser source is brought in whole from `runcor-ai/rpp-parser` (pure
  TypeScript, zero runtime dependencies) and is NOT redesigned.
- The runcor reference repositories (`runcor`, `runcor-substrate`,
  `runcor-identity`, `runcor-memory`, `runcor-goals`, `runcor-drives`,
  `runcor-temporal`, `runcor-dialectic`, `runcor-watchdog`, `runcor-skills`)
  are studied for logic and copied with attribution where they genuinely
  fit; the build is a fresh consolidated monorepo, not a clone of those
  repos.
- The operator supplies model API credentials at instantiation. Credential
  storage is handled by the Bridge; the lattice never sees raw keys, only
  a configured backend handle.
- The operator is responsible for confirming provider terms-of-service
  compliance when running on a subscription host-CLI backend over long
  horizons.
- **Trace retention**: indefinite retention in the indexed store; the raw
  JSONL file is rotated when it exceeds a configurable size, with oldest
  segments archived to the snapshot destination. (Intent spec did not
  specify; reasonable industry default.)
- **The "indexed store" for the trace** (intent §16): kept INSIDE the
  same SQLite file as the entity, preserving the §17 self-contained
  property. (Intent spec did not specify the kind or location; the SQLite
  default keeps the entity truly one-file.)
- **Behaviour on model-backend usage limit** (intent §14 operator note):
  the failing model call returns a recognisable error; the lattice marks
  the current `act` as failed; if a job is active, the relevant item
  defers with unblock condition "model backend usage window resets at
  TIMESTAMP" (when known); the operator is alerted; subsequent cycles
  still run for non-model work (perception, trace-writes). (Intent spec
  flagged operator responsibility but did not specify lattice behaviour.)
- Bridge UI is intended for desktop browsers used by an operator
  (or operations team); mobile-first or accessibility-AAA support is not
  in scope for v1.
- A single operator may run multiple lattices simultaneously on the same
  machine; resource constraints are an operator concern, not enforced by
  the lattice runtime in v1.
- "Self-contained" applies to the cognitive parts of the lattice (loop,
  substrate, memory logic). Well-maintained npm libraries handle plumbing
  per the constitution's Technology Stack section.
