# Lattice Changes — Grounding Map (spec → real code)

**Purpose:** Resolve every placeholder path in `lattice-changes-spec.md` to a real `file:line` in this repo, with a PRESENT / PARTIAL / ABSENT verdict and the precise *delta* (the work that actually remains). No code changed yet — this is the review artefact before implementation.

**Source spec:** the operator-local `lattice-changes-spec.md` (kept outside this repo).
**Target codebase:** this repository — a pnpm/turbo monorepo (`packages/*` + `apps/*`).

---

## 0. Critical correction — the spec targets THIS tree, not the sibling-repo tree

The spec uses placeholder paths (`packages/jobs/src/sign-off.ts`, `packages/runtime/src/phases/write.ts`). Those resolve **here**, in this pnpm/turbo monorepo (20 packages, 4 apps). They do **not** resolve in the older sibling-repo layout (`src/loop/cycle.ts`, separate `runcor-*` repos) where none of the jobs/sign-off/bridge-jobs infrastructure exists. The spec's source debugging session (`2026-05-26-job-auto-close-missing`, lattice `software-engineer-jlxt3h`, `plan_job.status`) was run against this monorepo. All "already defined / already tested" claims in the spec refer to this tree and are substantially accurate.

**Implication:** Most items are *deltas on existing infrastructure*, not greenfield builds. The jobs subsystem, completion-check registry, supervisor pause/resume, slow clock, and trace plumbing already exist.

---

## 1. Per-item grounding

Legend — **PRESENT**: exists as the spec assumes · **PARTIAL**: infra exists, the specific thing is incomplete · **ABSENT**: must be built.

### Item 2 — Auto-close wire fix · **PARTIAL (small add, not a one-line wire)**

| Spec claim | Reality | Where |
|---|---|---|
| `JobsService.close()` exists | ✅ `close()` wraps `attemptClose()` | `packages/jobs/src/service.ts:168`; logic in `packages/jobs/src/sign-off.ts:42` (`attemptClose`) |
| Re-exported from index | ✅ | `packages/jobs/src/index.ts:20` |
| Returns ClosureResult (closed/pending_operator/not_ready) | ✅ exactly; job status set to `closed_full`/`closed_partial`; `mode: full|partial` | `sign-off.ts:31-34`, `:60-74` |
| Autonomy gates the close | ⚠️ **PARTIAL** — only `low` is branched (`:64`). `medium` falls through and closes silently like `high`. The docstring (`:11-12`) says medium should escalate a confirmation; **the code does not.** | `sign-off.ts:64-74` |
| Subconscious sweep calls `close()` per job | ❌ **the bug.** Sweep loops jobs→items and calls `attemptCheck()` on each *item* (`write.ts:100`); it **never calls `attemptClose()` on the job.** | `packages/runtime/src/phases/write.ts:96-116` |

**Delta:** After the inner items loop (`write.ts:115`), add a per-job `attemptClose()` call with proper `ClosureResult` handling + the `auto-attempt-job-close` traces the spec names. **Decide whether to also implement medium-autonomy escalation** (spec assumes it exists; it doesn't) — this is a real, in-scope sub-decision, not a separate item. Four regression tests as specified, against `index.test.ts` conventions (existing autonomy test at `packages/jobs/src/index.test.ts:294`).
**Effort:** S. **Foundational — do first.**

### Item 3 — Observability for swallowed close failures · **ABSENT (rides on Item 2)**

The per-job close call doesn't exist yet, so there's nothing to wrap. The *trace convention* is PRESENT: `ctx.trace.write({ kind: 'subconscious', cycle, at_ms, rule, memory_id?, was?, now? })` (`write.ts:103-110`). Note the existing schema has no `job_id`/`lattice_id` fields — the spec's suggested fields would extend it.
**Delta:** When Item 2's per-job `try/catch` catches, emit `rule: 'auto-close-error'` with job id, cycle, error. **Effort:** XS. **Pairs with Item 2.**

### Item 4 — Auto-append checklist plan-item on job creation · **PARTIAL**

| Piece | Reality | Where |
|---|---|---|
| plan_item / checklist concept | ✅ PRESENT | `packages/jobs/src/types.ts:29-42`; schema `packages/runtime/src/migrations.ts:85-97` |
| completion-check evaluator | ✅ PRESENT, registry-based | `packages/jobs/src/completion-check.ts` |
| `file_exists` check | ✅ supports `{ path, minBytes? }` | `completion-check.ts:59-77` |
| `file_exists` content-pattern (checkbox line) | ❌ only `stat()` for size; never reads content | same |
| auto-insert first item on job POST | ❌ `openJob()` creates only the job row | `packages/jobs/src/checklist.ts:108` |
| "no later item closes first" ordering | ❌ no dependency field (see Item 5) | — |

**Delta:** (a) extend `file_exists` (or sibling hook) to require a checkbox-pattern line, not just bytes; (b) job-creation handler auto-inserts the gated plan item; (c) ordering enforcement depends on Item 5. (d) Seed persona line — authoring (see Item 10). **Effort:** M. **Depends on Item 7 (gate vocab) + Item 5 (ordering).**

### Item 5 — Item-dependency chaining from the plan · **ABSENT (adjacent machinery exists)**

No `blocked_by`/`depends_on` column on `plan_item` (`migrations.ts:85-97`). No plan-file parser, no `onPlanFileReady` hook, no state-change event emitter (`checklist.markPassed()` is an internal mutation, no pub/sub). **However** an adjacent unblock mechanism exists: `unblock_condition`/`unblock_test` columns + `packages/jobs/src/unblock-watcher.ts` (`checkUnblocked()`, `UnblockTestSpec`: `sense_data_contains`, `sense_present`, `cycle_after`) — this is reusable scaffolding for ordering.
**Delta:** dependency column + closure gate honoring it; the `onPlanFileReady` trigger fired from item→passed transition; the parse-and-append step. **Effort:** L. **Plan-cluster.**

### Item 6 — Persistence substrate law · **ABSENT**

Substrate laws are **prompt-text constraints only** — `Law = { id, statement }` injected into the prompt (`packages/substrate/src/laws.ts:25-89`); there is no runtime pre-dispatch hook registry. The action dispatch path is `packages/runtime/src/phases/act.ts:14-42` (`actOne()`), with **no pre-dispatch dedup check**. The `recent_actions` shown in the prompt (`ground.ts`, 24-item limit) is **display-only** — no `(name, input hash)` ring buffer exists for enforcement.
**Delta:** a per-lattice recent-actions ring (name + input hash + cycle), a pre-dispatch check in `act.ts`, a `persistence-violation` trace, and the law registered as enforcement (a new *kind* of law — runtime-enforced, not prompt-text). **Effort:** M. **Independent — can land any time after Item 2.**

### Item 7 — Lattice-authored completion-check hooks · **PARTIAL (good extension point)**

Registry architecture PRESENT: `CheckRegistry` + `builtinRegistry()` (`completion-check.ts:29-40`), dispatched by `runDeterministicHooks()` (`:105-125`), custom registry injectable via `JobsService` ctor (`service.ts:47`). Existing hooks: `always_pass`, `always_fail`, `description_contains`, `file_exists`. Missing the spec's `command_exits_zero`, `http_status_is`, `content_contains`. A sandbox exists — `packages/capabilities/src/shell-exec-action.ts` (allowlist + timeout) — but it's an **async capability**, while hooks run **sync**; wiring `command_exits_zero` must bridge that (or make hooks async).
**Delta:** register the new hook types; reuse shell-exec sandbox for `command_exits_zero`; add the plan-syntax gate declaration consumed by Item 5's parser; seed vocabulary line. **Effort:** M. **Provides the gate types Items 4/5 declare — do before/with them.**

### Item 8 — Bridge endpoint for lattice-authored items · **PARTIAL**

`POST /api/lattices/:id/jobs` exists and adds items *at creation* (`apps/bridge-api/src/server.ts:378-408`, body `JobsHandSchema`); `JobsService.addItem(jobId, { description, spec })` exists (`service.ts:54`, `checklist.ts:135`). Missing per the spec's must-haves: (a) dedicated `POST …/jobs/:job_id/items` append route; (b) `source` field on `plan_item` — **only `plan_job` has `source`** (`migrations.ts:79`); (c) autonomy/substrate/audit validation on the item-add path (none today); (d) reject append to closed/pending job (`addItem` currently succeeds on closed jobs).
**Delta:** new append route + the four guards above + `source` column. **Effort:** M. **Mechanism Items 5/7 use.**

### Item 9 — Pause-on-all-jobs-closed dial · **PARTIAL (mechanism exists, auto-trigger doesn't)**

Supervisor `pause()`/`resume()` **work** (abort-signal pattern) with bridge routes `/actions/pause` + `/actions/resume` (`apps/bridge-api/src/supervisor.ts:198-222`, `server.ts:346`). Status field is `running|paused|stopped|crashed`. `entity.paused` column exists but is **unused** (`packages/runtime/src/entity-store.ts:20`, `setPaused()` `:66`). `runOnce` already computes `hasOpenJobs` (`lattice.ts:170`). Missing: `pauseOnNoOpenJobs` config/dial (dials schema at `packages/bridge-shared/src/index.ts:10-22` has no such field; only `autonomy` is live-applied), the end-of-cycle auto-pause check in `runUntilAborted` (`lattice.ts:265-271` — no condition), a `paused_no_jobs` status variant, and the directional traces.
**Delta:** config flag + end-of-cycle check that calls the existing pause path + status variant + resume-on-new-job. **Effort:** M. **Completes the noop-forever fix Item 2 starts.**

### Item 10 — Seed reshape into Layer 1/2/3 · **ABSENT**

Identity is a **monolithic** `composed_body TEXT` (`migrations.ts:53-68`; `LatticeIdentity = { composed_body }` `runtime/types.ts:24`), injected as one block every cycle via `packages/substrate/src/wrap.ts:39-55` from `ground.ts:51`. No layer split, no run-once init path (`lattice.ts:146-200` gives every cycle the same identity).
**Delta:** split storage into 3 cadenced slots; prompt builder injects L1 every cycle, runs L2 once at startup, binds L3 per job; backward-compatible single-layer fallback for migration. **Effort:** L (much of it authoring). **Foundational for seed-side items.**

### Item 11 — Bundle layering for personas · **ABSENT**

`packages/identity/src/index.ts` is an empty skeleton (`export {}`). Persona composition is entirely caller-side as a pre-composed string (`lattice.ts:72`). No bundle/fragment concept anywhere.
**Delta:** named bundle storage + ordered composition into Layer 1 + inspector. **Effort:** L. **Depends on Item 10.**

### Item 12 — Watchdog scope · **RESOLVED → PROCESS-HEALTH (narrow). Follow-up F1 filed in `followups.md`.**

Definitive from the code: the watchdog's sole export `findGaps()` (`packages/watchdog/src/index.ts:38-90`) detects exactly **one** pattern — a capability whose name appears in a stated need (goal/plan_item text) but was **not invoked** in the last N cycles (default 100) → `tool_unused` finding. It reads the `capability`, `goal`, `plan_item`, and `trace(phase=act)` tables; it does **not** read deliverables, evaluate output quality, or check plan adherence. It "rides the slow clock," outside the cycle loop. The second declared finding kind `stated_need_unmet` is **not even implemented**.

**Resolution per the spec's own instruction:** the watchdog does NOT do content review → Item 12 does **not** close. Content-quality review is unaddressed and needs its own follow-up item (a watchdog extension or sibling). **Do not re-open the reviewer-lattice pattern** — the cost objection stands.

### Item 13 — Phase hooks · **DROPPED** (unchanged; subsumed by Item 7).

---

## 2. Corrected status vs. the spec's table

| # | Item | Spec status | Grounded verdict | Real anchor |
|---|---|---|---|---|
| 2 | Auto-close wire | "one-line wire, already tested" | **PARTIAL** — small *add* (per-job close not present) + medium-autonomy gap | `write.ts:96`, `sign-off.ts:42` |
| 3 | Close-error observability | Specified | **ABSENT** — rides Item 2; trace convention present | `write.ts:103` |
| 4 | Auto-append plan item | Specified | **PARTIAL** — items+`file_exists` present; no content-pattern, no auto-insert | `completion-check.ts:59`, `checklist.ts:108` |
| 5 | Item chaining | Specified | **ABSENT** — no dep field/hook; unblock-watcher reusable | `unblock-watcher.ts`, `migrations.ts:85` |
| 6 | Persistence law | Specified | **ABSENT** — laws are prompt-text only; no ring/dispatch hook | `laws.ts:25`, `act.ts:14` |
| 7 | Hook vocabulary | Specified | **PARTIAL** — registry + sandbox exist; 3 hooks + plan syntax missing | `completion-check.ts:29`, `shell-exec-action.ts` |
| 8 | Lattice-authored items endpoint | Specified | **PARTIAL** — create+addItem exist; append route, `source`, guards missing | `server.ts:378`, `service.ts:54` |
| 9 | Pause-on-idle | Specified | **PARTIAL** — pause/resume work; auto-trigger + dial missing | `supervisor.ts:198`, `lattice.ts:265` |
| 10 | Layer 1/2/3 seed | Specified | **ABSENT** — monolithic `composed_body` | `migrations.ts:53`, `wrap.ts:39` |
| 11 | Persona bundles | Specified | **ABSENT** — empty identity pkg | `identity/src/index.ts` |
| 12 | Watchdog scope | Open question | **RESOLVED: process-health only → follow-up F1 filed (`followups.md`)** | `watchdog/src/index.ts:38` |
| 13 | Phase hooks | Dropped | Dropped | — |

**Bonus finding (not in spec):** Item 1's *slow clock* is **already built** — `packages/slowclock/` + `apps/slowclock` run `consolidate()` + `driftReview()` on a load-aware cadence (default 100 cycles). The spec's Item 1 three-clock model is therefore **PARTIAL**, not greenfield: slow clock PRESENT, **fast clock ABSENT** (write phase records raw outcomes, no per-cycle situation report), **medium clock ABSENT**. Real anchors: `packages/slowclock/src/worker.ts:101`, `consolidate.ts:32`; write phase `phases/write.ts:27`; recent-episodic render `phases/ground.ts:161`.

---

## 3. Revised implementation order (grounded)

The spec's suggested order mostly holds, adjusted for what's already built:

1. **Item 2 → Item 3 → Item 9** (foundational, all small-to-medium, retire noop-forever). Item 2 includes the medium-autonomy escalation decision.
2. **Item 1 fast + medium clocks** (slow clock already done — smaller than the spec assumed) → **Item 10** (seed split).
3. **Plan-binds-behaviour cluster: Item 7 → Item 4 → Item 5 → Item 8** (build gate vocab first; Item 8 is the append mechanism the others need).
4. **Item 6** (independent, any time after Item 2) → **Item 11** (after Item 10).
5. **Item 12 follow-up** filed (content-review capability), reviewer-lattice stays closed.

---

## 4. Open decisions surfaced (need an answer before/within implementation)

- **Item 2:** implement medium-autonomy escalation now (spec assumes it exists, code lacks it), or scope it out and just wire the close?
- **Item 7:** make completion-check hooks async (clean `command_exits_zero` via existing shell-exec sandbox) vs keep them sync and bridge — affects the evaluator contract.
- **Item 1:** confirm N (medium) / M (slow) — slow clock already defaults to 100; medium starts at N=10 per spec.
- **Item 9:** do the slow/medium clocks keep running while paused? (spec leans no.)
- **Doc location:** this grounding lives at the repo root; move into `docs/` or `specs/` if you prefer it tracked with the spec-kit artefacts.
