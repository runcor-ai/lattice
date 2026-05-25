# Security model

## The trust boundary

**The Bridge is single-tenant local-only** (spec FR-055,
clarification 2026-05-24). It binds to `127.0.0.1` by default;
**OS-level access to the host is the authentication boundary**.
There is no login screen, no account model, no remote access in v1.

Concretely: if you can ssh to the box, you have full Bridge
access. If you can't, you have none.

This is the lightest workable model that:

- Lets a single operator run the lattice locally without operating
  an auth system.
- Keeps credentials (model API keys) out of any network surface.
- Allows the constitution's "lattice as the asset, model as a
  consumable" framing to be true at the network layer too.

## What is reachable from the network

| Surface | Default bind | Notes |
|---|---|---|
| Bridge HTTP API | `127.0.0.1:7100` | All routes |
| Vue UI | served by the Bridge | Same origin as the API |
| Lattice's MCP self-exposure | per-lattice port (slice 13) | Disabled unless explicitly enabled for collaboration |
| Slow-clock worker | none | Pure subprocess; no network listen |
| Peer registry | none (uses outbound HTTP) | The lattice CALLS the registry; doesn't listen |

If you set `RUNCOR_BRIDGE_BIND=0.0.0.0` (non-loopback), the Bridge
**logs a prominent warning every minute** that it is exposed.
There is no auth wrapping; the v1 contract is local-only.

## What the substrate enforces

Per constitution Principle VIII (NON-NEGOTIABLE), the lattice
**cannot see, configure, or bypass its own substrate**. The
substrate package exposes EXACTLY four functions
(`wrap`, `discern`, `assessCapability`, `autonomyResolve`) and pure
data; structural tests assert no mutator can leak through.

Concretely:

- The eleven laws sit byte-equal at the **top** of every model
  prompt. A buried-laws placement failed in testing; top placement
  fixed it.
- Discernment evaluates every model output against all eleven
  laws, code-first.
- `Reality` and `Constraint` violations ALWAYS block. `Simplicity`
  is advisory only.
- Tool discovery is GOVERNED — `assessCapability()` filters
  candidates against substrate policy BEFORE the manifest is
  updated.

## Credentials

Model backend API keys live in a local file-backed store managed
by the Bridge:

| Path | Default `~/.runcor-lattice/secrets.json` |
| --- | --- |
| **Permissions** | `0700` directory, `0600` file (POSIX) |
| **Public surface** | `GET /api/secrets` returns redacted summary: `{ hasAnthropicKey: bool, hasOpenaiKey: bool }` |
| **What the lattice sees** | NEVER raw keys. The engine layer reads the key at backend construction; the lattice only sees the resolved `ModelBackend` handle. |
| **What the trace records** | The fact of a model call, never the key. |

## What the lattice CANNOT do (by construction)

1. **Read another lattice's memory.** Each owns its own SQLite file
   under its own lockfile. The collaboration layer (`@runcor/collaboration`)
   exposes ONLY `essence`, `converse`, `delegate`, and optionally
   `skills_list` / `skills_get`. No memory, no trace, no SQLite, no
   dials, no substrate are exposed (constitution Principle XIV —
   NON-NEGOTIABLE).

2. **Modify its substrate.** The package exports no mutator. The
   laws are frozen. A `validateCapability` smoke test asserts the
   no-mutator surface.

3. **Bypass R++.** The engine's `prompt` parameter is the
   `RppPrompt` branded string type. Only the substrate's `wrap()`
   produces an `RppPrompt`. Bare strings fail at compile time.

4. **Pass an item without running its check.** `Checklist.markPassed`
   requires an `assertedCheckRun: true` flag that only
   `JobsService.attemptCheck` and `JobsService.recordJudgement` set.
   Other callers get `PassByAssertionError`.

5. **Adopt a tool that bypasses the substrate.** Tool discovery's
   `assessCapability` rejects candidates whose description matches
   `/bypass.{0,40}(substrate|gate|discernment)/i` etc.

## Risk acceptance: `RUNCOR_BRIDGE_BIND=0.0.0.0`

The operator may set the bridge to bind on a non-loopback
interface. This is **not recommended for v1**. The Bridge:

- Logs a prominent warning every minute that it is exposed.
- Has no authentication. Anyone who can reach the port has full
  control.
- Does not negotiate TLS. There is no built-in path to add it.

If you need remote access, the operationally safest options are:

- SSH tunnel (`ssh -L 7100:127.0.0.1:7100 host`)
- VPN
- A reverse proxy on the same host that adds auth + TLS

These are the same options that apply to any local dev server.

## Audit trail

Every cycle, every subconscious correction, every job event, every
substrate flag, every operator action lands in the trace:

- Durable JSONL on disk (one row per event)
- SQLite indexed copy in the lattice's own file
- Live SSE stream to the Bridge

Concretely, after an incident the operator can answer:

| Question | Trace query |
|---|---|
| What did the lattice decide at cycle N? | `kind='phase' AND phase='decide' AND cycle=N` |
| Did the substrate block anything in the last hour? | `kind='substrate' AND outcome IN ('block','escalate') AND at_ms > ?` |
| Why was item X deferred? | `kind='job' AND event='item_deferred'` + the item's own `defer_reason` column |
| Which tool was used at cycle N? | `kind='phase' AND phase='act' AND cycle=N` (output_summary contains `action=NAME`) |

## Threat model (v1)

In scope:

- Local crash recovery (SQLite WAL + crash-mid-cycle rollback)
- Substrate enforcement (no bypass surface)
- Cross-lattice isolation (Principle XIV — no shared memory)
- Tool discovery vetting (Principle XI + `assessCapability`)
- Usage-limit handling (slice 12)

Out of scope (v1):

- Multi-user / multi-tenant
- Network-level access control (delegated to OS)
- TLS / authn / authz at the Bridge
- Encrypted at rest (the SQLite file itself; operator can layer disk
  encryption)
- Supply-chain hardening of npm dependencies (operator concern)

## If you find a vulnerability

Open an issue at the project repository. Mark it `security:` and
the maintainers will look at it before any public commit.
