# Lattice-changes — follow-up items

Items spun out of `lattice-changes-spec.md` during implementation. Each is
grounded in the as-built code, not a placeholder.

---

## F1 — Deliverable content-review pass (resolves Item 12)

**Status:** filed (not yet built). Spawned by Item 12, now closed.

### Item 12's question, answered from the code

Does the watchdog do **content-quality review** of worker output, or only
**process-health monitoring**?

**Answer: process-health only — narrow.** The watchdog's sole export
`findGaps()` (`packages/watchdog/src/index.ts:38-90`) detects exactly one
pattern: a capability whose name appears in a stated need (`goal` /
`plan_item` text) but was **not invoked** in the last N cycles (default
100) → a `tool_unused` finding. It reads the `capability`, `goal`,
`plan_item`, and `trace(phase=act)` tables. It does **not** read
deliverables, evaluate output quality, or check plan adherence. The
second declared finding kind `stated_need_unmet` is not even implemented.
It "rides the slow clock," outside the cycle loop.

**Therefore Item 12 does not close on the watchdog** — content-quality
review is unaddressed and needs its own work, filed here.

### What F1 is

A content-review pass that reads a job's completed deliverables and flags
shallow / off-plan output, at the watchdog's cheap (observation, not
execution) altitude — it "rides the slow clock," it does not run a full
cycle loop.

- Input: a job's `plan_item`s that have passed, plus the deliverable files
  their gates point at (the Item 7 `file_exists` / `content_contains`
  paths) and the plan file (Item 4/5).
- Output: findings of a new kind (e.g. `shallow_deliverable`,
  `plan_adherence_gap`) surfaced through the same `WatchdogFinding`
  channel `findGaps()` already uses.
- It is LLM-backed (quality is a judgement), unlike today's deterministic
  matchers — so it adds the watchdog's first model call. Gate it on the
  slow-clock cadence and on jobs that have just closed, to bound cost.

### Hard constraint (do not revisit)

**Do NOT re-introduce the reviewer-lattice pattern** (a second lattice
running a full cycle loop to critique the worker). It was considered and
rejected on cost — doubling LLM spend for critique. The watchdog altitude
(observation, slow-clock cadence) is the home for this precisely because
it is cheaper. If F1 proves the gate vocabulary (Item 7) already catches
most quality problems deterministically, F1 may shrink to "extend the
gate vocabulary" rather than "add an LLM reviewer" — prefer that.

### Verify

- Unit: the review pass reads a passed item's deliverable and returns a
  finding when the content is trivially short / empty; none when it is
  substantive.
- Unit: a deliverable that does not match its plan step's intent yields a
  `plan_adherence_gap` finding.
- Cost: confirm the pass runs only on the slow clock / on job close, not
  every cycle.
