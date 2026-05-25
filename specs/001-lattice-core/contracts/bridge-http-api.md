# Contract: Bridge HTTP API

The Bridge API is a Fastify server that supports **only the four pinned
operations** (constitution Principle in §19 + spec FR-051):

1. **instantiate** — create and launch a lattice
2. **roster** — list all lattices
3. **inspect** — read into one lattice's state and trace
4. **adjust** — change dials, pause/resume/stop, force replan, raise
   budget, swap model backend

The Bridge does **not** run lattices, route work between them, hold shared
state, execute tool calls, or make model calls (spec FR-052).

**Binding**: `127.0.0.1:<port>`. Single-tenant local-only (spec FR-055).

All request and response bodies are validated by `zod` schemas defined in
`packages/bridge-shared` and shared between the Fastify routes and the Vue
UI.

## Endpoints

### `POST /api/lattices`  — Instantiate

```
POST /api/lattices
Content-Type: application/json

{
  "name": "string",
  "identity_seed": "string",                      // R++ identity block
  "goals": ["string"],
  "dials": Record<DialName, DialValue>,           // partial; missing dials default
  "tool_manifest": [{
    "name": "string",
    "kind": "mcp" | "api",
    "uri": "string",
    "role": { "sense": boolean, "action": boolean }
  }],
  "model_backend": {
    "kind": "direct-api" | "host-cli",
    "config": { ... }                              // backend-specific
  },
  "snapshot": {
    "kind": "local-folder" | "aws-s3",
    "config": { ... }
  },
  "bundle_id"?: "ceo" | "cfo" | "marketing" | "sales" | ...  // when from prebuilt
}

→ 201 Created
{
  "lattice_id": "uuid",
  "sqlite_path": "string",
  "pids": { "fast": number, "slow": number },
  "trace_stream_url": "/api/lattices/<id>/trace/stream"
}
```

### `GET /api/lattices`  — Roster

```
GET /api/lattices

→ 200 OK
[
  {
    "lattice_id": "uuid",
    "name": "string",
    "status": "running" | "paused" | "stopped" | "crashed",
    "cycle": number,
    "open_jobs": number,
    "current_plan_summary": "string",
    "goals_summary": ["string"],
    "budget": { "unit": "...", "ceiling": number, "spent": number },
    "model_backend": "direct-api" | "host-cli",
    "pids": { "fast": number?, "slow": number? }
  }
]
```

### `GET /api/lattices/:id`  — Inspect (snapshot)

```
GET /api/lattices/:id

→ 200 OK
{
  ...roster fields...,
  "identity": { "composed_body": "string", "at_cycle": number },
  "memory_summary": {
    "identity_count": number,
    "plan_jobs_open": number,
    "plan_jobs_closed": number,
    "episodic_count": number,
    "semantic_count": number
  },
  "dials": Record<DialName, DialValue>,
  "recent_decisions": [TraceEntry],     // last 10 phase=decide entries
  "drift_history": [TraceEntry]         // last 5 slow-clock drift writes
}
```

### `GET /api/lattices/:id/trace`  — Trace (paginated)

```
GET /api/lattices/:id/trace?after_cycle=N&limit=200&kind=phase&phase=decide

→ 200 OK
[TraceEntry]
```

### `GET /api/lattices/:id/trace/stream`  — Trace (live)

Server-Sent Events stream. Each event is one `TraceEntry`. The Bridge
catches up from `last_event_id` (the SSE `Last-Event-Id` header) on
reconnect (spec US5 §3).

```
GET /api/lattices/:id/trace/stream
Accept: text/event-stream

→ 200 OK (event-stream)
event: trace
id: 12345
data: { ...TraceEntry... }

event: trace
id: 12346
data: { ...TraceEntry... }
```

### `PATCH /api/lattices/:id/dials`  — Adjust dials

```
PATCH /api/lattices/:id/dials
Content-Type: application/json

{
  "dials": Record<DialName, DialValue>,
  "why": "string"
}

→ 200 OK
{ "applied_at_cycle": number }
```

### `POST /api/lattices/:id/actions/:action`  — Adjust lifecycle

```
POST /api/lattices/:id/actions/pause
POST /api/lattices/:id/actions/resume
POST /api/lattices/:id/actions/stop
POST /api/lattices/:id/actions/replan
POST /api/lattices/:id/actions/swap-backend
   body: { "model_backend": { "kind": ..., "config": ... } }

→ 200 OK
{ "applied_at_cycle": number }
```

### `POST /api/lattices/:id/jobs`  — Hand a job to the lattice

```
POST /api/lattices/:id/jobs
Content-Type: application/json

{
  "title": "string",
  "body": "string",          // free text the lattice will turn into a checklist
  "why": "string",
  "items"?: [{               // optional pre-defined checklist
    "description": "string",
    "completion_check": "string"   // R++ block
  }]
}

→ 201 Created
{ "job_id": "uuid" }
```

### `POST /api/companies`  — Instantiate a bundle (US13)

```
POST /api/companies
Content-Type: application/json

{
  "members": [{
    "bundle_id": "ceo" | "cfo" | ...,
    "name_override"?: "string",
    "seed_prompt_override"?: "string",
    "budget": { "unit": "...", "ceiling": number }
  }],
  "shared_source_of_truth"?: { "uri": "string", "auth"?: { ... } },
  "registry"?: { "url": "string" }
}

→ 201 Created
[{ "lattice_id": "uuid", "bundle_id": "ceo", "pids": { ... } }]
```

### `POST /api/lattices/:id/escalations/:escalation_id/decide`  — Resolve a substrate escalation

```
POST /api/lattices/:id/escalations/:escalation_id/decide
Content-Type: application/json

{
  "decision": "approve" | "reject",
  "operator_note"?: "string"
}

→ 200 OK
{ "applied_at_cycle": number }
```

(Used when `autonomy = low` and the gate escalates per FR-023.)

## Invariants

- The API MUST bind to `127.0.0.1`. Binding to a non-loopback interface
  REQUIRES an explicit operator config override (`bind: "0.0.0.0"`); if
  set, the API logs a prominent operational warning every minute.
- The API MUST validate every body against its zod schema before
  dispatching.
- The API MUST NOT import the lattice runtime in-process. It spawns
  `apps/lattice` and `apps/slowclock` as child processes per the plan.
- The API MUST authenticate operators via the OS boundary only (FR-055).
  No login screen, no token model in v1.
- The trace SSE stream MUST support `Last-Event-Id` for catch-up
  (spec US5 acceptance scenario 3).

## Error model

All errors return:

```json
{
  "error": {
    "code": "string",        // e.g. "lattice_not_found", "invalid_dial_value"
    "message": "string",
    "details"?: { ... }
  }
}
```

with appropriate HTTP status (4xx for caller errors, 5xx for server).
