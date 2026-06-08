# Contract: Trace Read API (bridge-api)

Read-only. Extends the existing endpoints. No new write path; no runtime change.

## 1. `GET /api/lattices/:id/trace` — full envelope + cycle range (EDIT)

**Change from today**: the handler returns `rows.map(r => safeJson(r.body))`. Because `body` already contains the full flat entry (`kind/cycle/at_ms/phase` included — the store writes `JSON.stringify(entry)`), the only missing piece is the DB row `id` (needed for stable hover + ordering across windowed fetches). The edit MUST attach `id`: `rows.map(r => ({ ...safeJson(r.body), id: r.id }))`. It MUST also honor `before_cycle`.

### Query (TraceQuerySchema — `packages/bridge-shared`)

| param | type | default | notes |
|---|---|---|---|
| `after_cycle` | int ≥ 0 | — | existing; returns `cycle > after_cycle` |
| `before_cycle` | int ≥ 0 | — | **NEW**; returns `cycle < before_cycle` (windowed scrub) |
| `kind` | enum | — | existing |
| `phase` | string | — | existing |
| `limit` | int 1..1000 | 200 | existing |

`after_cycle` + `before_cycle` together select a bounded window. Rows ordered `id ASC`.

### Response (200)

Flat entries (body fields hoisted) with `id` attached:

```json
[
  { "id": 1421, "cycle": 23, "at_ms": 1733500000000,
    "kind": "substrate", "phase": "act",
    "law": "no-progress", "outcome": "block", "reason": "…" }
]
```

`phase` is absent for kinds without a phase. Shape matches what the SSE stream emits per event (flat), so both paths fold through the same reducer. The one addition over today is the `id` field.

### Errors

- `404 lattice_not_found` — unchanged.
- `400 invalid_query` — unchanged (zod).

### Backward compatibility

The existing InspectView reads `recent_decisions`/`drift_history` via the inspect endpoint, not this one; and the trace store SSE already carries the envelope. Returning the envelope here is additive (callers that only read `body` fields still find them under `.body`). The one in-repo consumer (`api.ts` `Api.trace`) is updated in lockstep.

## 2. `GET /api/lattices/:id/trace/stream` — live SSE (REUSE, unchanged)

Existing endpoint. Emits one `trace` event per appended row, full envelope. The visualizer subscribes via the existing `stores/trace.ts` EventSource. No change required; if the event payload is found to omit the envelope during implementation, align it to the row shape in §1 (still a bridge-side change, no runtime touch).

## 3. (Optional, NOT built in v1) `GET /api/lattices/:id/frames`

Reserved contract for a future server-side per-cycle summary (dominant action, item-state set, substrate firings, delegate?, gate results) to make the coarse timeline cheap without shipping raw rows. v1 derives this client-side from §1; this endpoint is documented so the timeline's data dependency is named, not so it is implemented now.
