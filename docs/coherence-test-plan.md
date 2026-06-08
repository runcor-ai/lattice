# Lattice coherence / robustness test plan

Driver: `scripts/coherence-test.mjs`. Goal: stress a **single** lattice with
three concurrent, heterogeneous, **evolving** jobs and verify it stays
**coherent** — keeps the threads separate, applies each requirement change to
the right job, and honors superseding changes rather than getting confused.

## The three jobs

| Job | Kind | Output | Requirement changes |
|---|---|---|---|
| **A — stopwatch** | build a web app | `coherence-run/app-a/index.html` | +lap times (c10), dark theme + keyboard shortcuts (c20), **supersede → light theme** (c40) |
| **B — converter** | build a web app | `coherence-run/app-b/index.html` | +temperature C↔F (c16), +swap button + localStorage (c24) |
| **C — repo rebuild** | analyze a GitHub repo, port to Python | `coherence-run/rebuild/queue.py` + `test_queue.py` | +CLI `__main__` entry point (c34) |

Repo for Job C: `sindresorhus/yocto-queue` (zero-dep, single-file JS library →
Python port). Override with `COHERENCE_REPO=<url>`.

## Timeline (cycle-triggered)

```
c2   hand A                          ← 1 job
c6   hand B                          ← 2 concurrent
c10  change A  (+lap)
c14  hand C                          ← 3 heterogeneous concurrent
c16  change B  (+temperature)
c20  change A  (dark + shortcuts)    ← concurrent with B churn (load spike)
c24  change B  (+swap/localStorage)  ← rapid successive change to B
c28  CHECKPOINT (mid-run probe)
c34  change C  (+__main__ CLI)
c40  change A  (supersede: dark → LIGHT)  ← contradicts c20 on purpose
c48  CHECKPOINT (final probe)
```

## Coverage / edge cases exercised

- **Concurrency** — up to three open jobs at once (c14–onward).
- **Heterogeneity** — two web-app builds + one code-comprehension-and-port job running together.
- **Staggered arrival** — jobs enter at c2/c6/c14, not all at once.
- **Mid-flight requirement change** — features added to apps whose deliverable already exists (must extend, not ignore or restart).
- **Rapid successive changes** — Job B changed at c16 and c24.
- **Concurrent change load** — A and B both change around c20–c24.
- **Superseding / contradictory change** — A's theme goes dark (c20) then is explicitly reversed to light (c40); coherence = apply the latest, not blend or revert to the wrong one.
- **Change to the heterogeneous job** — C gains a CLI entry point at c34.

## What "coherent" means here (the scored signal)

At each checkpoint and at the end, the driver scans the deliverables for
**cross-contamination** — each job owns a domain vocabulary; a deliverable that
contains *another* job's vocabulary is a violation:

- `app-a/index.html` must read as a **stopwatch** (start/reset/lap) and MUST NOT contain converter terms (fahrenheit/kilometre/convert) or Python (`def`, `import unittest`).
- `app-b/index.html` must read as a **converter** (convert/mile/fahrenheit) and MUST NOT contain stopwatch terms (stopwatch/lap) or Python.
- `rebuild/queue.py` must be **Python** (def/class/return) and MUST NOT contain HTML (`<div`), `localStorage`, or app vocabulary.

`verdict.json` reports `coherentJobs: N/3`. A perfect run is **3/3 coherent**
with every requirement-change keyword landing only in its own deliverable.

These automated checks are necessary but not sufficient — the captured
`state-*.json` (situation summary, per-job plan items + states, recent
decisions, deliverable byte sizes) is kept for human/LLM review of *how* it
kept the threads apart, and whether the superseding theme change at c40 was
applied correctly.

## Running it

```bash
node scripts/coherence-test.mjs --dry-run     # validate plan + dirs, no run, no network
node scripts/coherence-test.mjs               # full run (real claude backend; ~50+ cycles)
node scripts/coherence-test.mjs --cap=70      # cap cycles
node scripts/coherence-test.mjs --lattice=<id> # attach to an existing lattice
```

Results land in `coherence-results/<timestamp>/`:
`instantiate.json`, `timeline.json`, `state-c0NN-*.json` (checkpoints),
`verdict.json`. The run is NOT destructive to the lattice — stop it from the
bridge (or the visualizer) when done; it stays viewable for replay.

> Cost note: this is the real `claude` backend on the operator's subscription,
> running many cycles with delegation. It is a deliberate, supervised stress
> test — run it when you want the coverage, not casually.
