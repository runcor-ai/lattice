# Lattice coherence / robustness run — report (2026-06-07)

> One lattice, on the real `claude` backend at full autonomy, was driven through
> **three concurrent, heterogeneous, evolving jobs** plus a fourth job that
> asked it to **reopen and modify already-shipped work**. Goal: does a single
> entity keep the threads coherent — no cross-contamination, each requirement
> change applied to the right job, edits-in-place on completed work?
>
> Harness: `scripts/coherence-test.mjs` (driver) + `scripts/noop-watcher.mjs`
> (idle-close) + `scripts/coherence-status.mjs` (probe). Plan:
> `docs/coherence-test-plan.md`.

## Verdict: 3/3 coherent — PASS

| | |
|---|---|
| Lattice | `software-engineer-kg4uql`, `claude-code-host`, autonomy=high |
| Cycles | 49, then auto-paused (`paused_no_jobs`) and stopped cleanly |
| Jobs | **4/4 `closed_full`** |
| Coherence | **3/3 deliverables coherent, zero cross-contamination** (every one of 7 probes) |
| Results | `coherence-results/2026-06-07T05-26-22-686Z/` (`verdict.json`, per-checkpoint state) |

Deliverables, all in `coherence-run/`:

| Job | File | Bytes | Coherent |
|---|---|---|---|
| A — stopwatch | `app-a/index.html` | 3,324 | ✓ (no converter/Python terms) |
| B — converter | `app-b/index.html` | 4,046 | ✓ (no stopwatch/Python terms) |
| C — JS→Python port | `rebuild/queue.py` + `test_queue.py` | 2,442 + 1,769 | ✓ (no HTML/app terms) |

## What was thrown at it (the plan that fired)

```
c2   hand A (stopwatch)
c6   hand B (converter)                         ← 2 concurrent
c10  change A: +lap                             ✓ landed
c14  hand C (read yocto-queue, port to Python)  ← 3 heterogeneous concurrent
c16  change B: +temperature C↔F                 ✓ landed
c20  change A: dark theme + keyboard            ✗ 409 (Job A already closed)
c24  change B: +swap + localStorage             ✓ landed
c28  CHECKPOINT — A coherent, B coherent, C not yet built
c34  change C: +__main__ CLI                    ✓ landed
c40  change A: supersede dark→light             ✗ 409 (Job A already closed)
c48  CHECKPOINT — 3/3 coherent
+   (operator) reopen job: "revise the shipped stopwatch in place"  ✓ landed
```

Four of six in-flight requirement changes landed on the correct job. The two
that failed (`409 job_not_open`) both targeted Job A *after* it had
`closed_full` — see Findings.

## The reopen / supersede test (the interesting part)

Because the one-file stopwatch finished fast, the c20/c40 theme changes arrived
after Job A closed and 409'd. To exercise the supersession case, a **new job**
was handed mid-run: *"the stopwatch at `app-a/index.html` is already built —
reopen that existing file and modify it in place: high-contrast light theme +
keyboard shortcuts; keep lap + start/stop/reset; touch nothing else."*

Result — verified by file diffing across polls:

- Before: `app-a/index.html` = 3,090 B, `keydown=false`, `lightTheme=false`, `lap=true`.
- After: `app-a/index.html` = 3,324 B, `keydown=true`, `lightTheme=true`, `lap=true`, `start/reset=true`.

It **edited the existing file in place** (modest +234 B, not a rewrite), reconciled
the new requirement against what already existed, preserved all prior behavior,
and left the converter and Python port untouched. That is the robustness claim,
demonstrated: it can go back into completed work and change it coherently.

## How it spent its cycles (action histogram, 49 cycles)

| Action | Count | |
|---|---:|---|
| `workspace` | 28 | plan-step `.done` marker bookkeeping |
| `repo-read` | 5 | analyzing the source repo for the port |
| `close-job-item` | 5 | explicit item closes |
| `delegate-cc` | 3 | delegated the heavier builds to a coding subagent |
| `app-b-write` | 3 | converter edits |
| `rebuild-write` | 3 | Python port + tests |
| `app-a-write` | 2 | stopwatch edits |

The dominant cost is **plan-step marker bookkeeping** (`workspace`, 28/49 ≈ 57%):
each gated plan step requires writing a `.done` marker, and with four jobs ×
several steps each, that is the bulk of the budget. The actual deliverable
production was a minority of cycles, much of it delegated. This is correct
behavior (completion is gated, not asserted) but it is a real efficiency
observation for multi-job runs on small deliverables.

## Memory created during the run

The entity finished with this memory state (constitution's four-system model +
the two clocks). It is itself evidence of coherence — the entity's *internal*
model kept the jobs separate, not just the output files.

| Tier | Count | What it held |
|---|---:|---|
| **Identity** (permanent) | 3 | who it is — *"I am a software engineer… I cite evidence before writing a finding… I do not mutate source repositories."* Seeded from the bundle + identity seed; immune to decay. |
| **Semantic** (settled rules) | 8 | 6 **seeded** at cycle 0 from the software-engineer bundle (e.g. *"prefer claude-delegate over decide for multi-file editing"* — which is exactly why it delegated the heavier builds) + **2 derived by the medium clock** at cycles 20 and 40. |
| **Episodic** (decaying) | 49 | one cycle-outcome record per cycle — `cycle=N; chosen_action=…; input={…, why=…}`. This is the action history `ground` feeds back each cycle to prevent looping. |
| **Plan** | 4 jobs (all closed) + their items | the four job structures with gated items. |
| **Situation** (fast clock) | 1 (1,046 chars) | a running self-summary, rewritten each cycle. |
| **Goals** | 0 | none proposed/persisted this run. |

### The medium clock actually fired (episodic → semantic)

At cycles 20 and 40 the medium clock compacted episodic history into **new
settled facts** (`why: medium-clock compaction at cycle N`):

- **c20:** *"Two concurrent jobs run from coherence-run/. Job A 'stopwatch web app' is fully complete… passed all 8 gated steps…"*
- **c40:** *"Three concurrent software-engineering jobs were run in coherence-run; all reached their deliverables…"*

So the run exercised the memory consolidation path, not just raw episodic logging.

### The situation summary is a coherence artifact

The fast-clock self-narrative tracked all jobs **distinctly** and opened with the
entity's own coherence assertion:

> *"Three independent jobs run in parallel and stay strictly separate — no
> cross-contamination, no extra features."*
> app-a (stopwatch): light theme, Space toggles start/stop, r/R resets…
> app-b (km↔miles converter): bidirectional, 1 mi = 1.609344 km…
> Queue job (yocto-queue → Python): queue.py + test_queue.py, 8/8 pass, parity PASS…

It also **self-diagnosed the close stall** seen in the polls (the reopen job
sitting at 5/8–7/8):

> *"Blocked: all three job-item closes still pending; close attempts… failed on
> stale/guessed itemIds. Next: list the actual open job items to recover their
> real ids before closing anything else — stop guessing ids."*

That is the entity catching its own failure mode (guessing plan-item IDs),
writing the correction into memory, and the next cycles acting on it to close
the jobs — exactly the drift-control loop the four-system memory is for.

### Tacit knowledge captured (learned, not seeded)

The most interesting result: the medium-clock consolidations didn't only
summarize state — they distilled **experiential lessons learned from failure**,
explicitly tagged *"Lesson"* and *"Pattern that works"*. These are the kind of
hard-won, procedural know-how a human engineer only picks up by doing it wrong:

> *"Lesson (recurring): close-job-item failed at cycles 7 and 19 … because the
> step-done workspace marker must be written BEFORE closing the item, not after
> — write the marker first, then close."*

> *"Lesson: avoid repeating an action with identical inputs within 10 cycles —
> cycle 3's duplicate repo-read was rejected as a persistence violation."*

> *"Pattern that works: prefer verifying an existing deliverable read-only over
> rewriting it when gates already pass."*

> *"Keep the two jobs strictly separated — never edit app-b while verifying
> app-a, and vice versa."*

Why this is human-like:

- **Learned from doing it wrong.** "Write the marker before closing" was abstracted
  from *experiencing* the same failure twice (cycles 7 and 19), not seeded.
- **Generalized, not logged** — it stored the *rule* ("marker first, then close"),
  not "cycle 7 failed".
- **Reinforced through repetition** — the same lessons recur in both the c20 and
  c40 consolidations, raising their durability (the semantic tier persists, so
  they would carry into a future engagement).
- **Positive patterns + self-authored discipline**, not just error-avoidance
  ("verify read-only over rewrite"; "never edit app-b while verifying app-a").

**Limitation (the transfer gap).** The lessons are embedded inside run-specific
summaries — interleaved with this run's job IDs, byte counts, and file paths. A
human files "commit the marker before closing the gate" as a clean, context-free
habit; the lattice's version is the right insight wrapped in episodic clutter. So
the *capture* is real and durable, but the *abstraction for transfer* is
imperfect — a future engagement recalling it gets signal plus this-run noise.
(The seeded semantics, by contrast, are crisp general rules.) Concrete lever:
push the consolidation pass to separate "durable lesson" from "run state" so the
transferable rule can be recalled without the specifics.

### Admission-rule note

Per the constitution, memory holds only what cannot be re-perceived: the
decisions and their *why* (episodic), settled rules (semantic), and the running
situation. The deliverables themselves are NOT memorized — they are re-read from
disk via the read capabilities each cycle. The coherence scan reads the files;
the entity reasons from memory-of-decisions + fresh perception.

## Findings

1. **No "reopen on new requirement" path.** A requirement change appended to an
   already-`closed_full` job returns `409 job_not_open`. Simple jobs close fast,
   so late changes have nowhere to land. The working pattern is a **new job that
   references the existing file** — which the lattice handled perfectly (in-place
   edit). A first-class "reopen job / amend shipped item" affordance would close
   this gap.
2. **The entity parks, it does not spin.** When all jobs closed it went
   `paused_no_jobs` rather than noop-looping — so "close after N noops" is the
   wrong idle signal; `paused_no_jobs` is the real "done". The watcher was updated
   to treat that as the close trigger.
3. **Harness bugs found and fixed mid-run** (not lattice issues): the append
   payload used `completion_check` instead of `gate`; the watcher paged the
   *oldest* cycles (the trace API is `ORDER BY id ASC`, so it needs `after_cycle`
   to read the live edge); and the watcher needed a request timeout + per-iteration
   error tolerance so a stalled call can't wedge it.

## What this run demonstrates

- A single lattice held **three unlike jobs in flight at once** and never bled one
  into another — 7 consecutive clean coherence probes.
- **Evolving requirements** on live jobs were attributed to the correct job every
  time.
- It can **reopen and modify shipped work in place**, reconciling a superseding
  requirement without restarting or clobbering, and without contaminating peers.
- It **shuts down cleanly** (auto-pause → stop), leaving the run fully viewable for
  replay in the visualizer.

## Artifacts

- Driver / watcher / probe: `scripts/coherence-test.mjs`, `scripts/noop-watcher.mjs`, `scripts/coherence-status.mjs`
- Plan: `docs/coherence-test-plan.md`
- Results: `coherence-results/2026-06-07T05-26-22-686Z/`
- Deliverables: `coherence-run/{app-a,app-b,rebuild}/`
- Replay: Bridge → roster → **Visualize ▸**, or `#/lattice/software-engineer-kg4uql/visualize` (stopped, viewable)
