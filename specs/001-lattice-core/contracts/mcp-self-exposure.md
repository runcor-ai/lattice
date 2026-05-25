# Contract: MCP Self-Exposure

A lattice exposes itself over MCP so peer lattices can reach it (intent
§15.1). The lattice already speaks MCP outward for its own tool use;
exposing itself as an MCP **server** uses the same SDK.

## Exposed surface

The lattice serves these MCP tools to authenticated peers (per the
registry's peer-key model — see §15.1):

### `essence`  (read-only)

```jsonc
// MCP tool call
{ "name": "essence" }

// Returns:
{
  "lattice_id": "uuid",
  "name": "string",
  "essence": "string"          // the one-sentence essence registered to the registry
}
```

### `converse`  (action)

Initiates or continues a conversation. The receiver opens (or finds) a
conversation job on its own plan and routes the message into it.

```jsonc
{
  "name": "converse",
  "arguments": {
    "from_lattice_id": "uuid",
    "conversation_id": "uuid",        // null for new conversation
    "message_rpp": "string"            // R++ block
  }
}

// Returns immediately with acknowledgment; the actual response comes back
// asynchronously via the caller polling or via the caller's own MCP
// endpoint:
{
  "ack": true,
  "conversation_id": "uuid",
  "received_at_cycle": number
}
```

### `delegate`  (action)

Hand a job to the receiver. The receiver decides (per its own identity,
Law 11 Standing, and autonomy dial) whether to accept.

```jsonc
{
  "name": "delegate",
  "arguments": {
    "from_lattice_id": "uuid",
    "job": {
      "title": "string",
      "body": "string",
      "why": "string",
      "items": [{
        "description": "string",
        "completion_check": "string"
      }]
    }
  }
}

// Returns:
{
  "accepted": boolean,
  "reason"?: "string",          // when accepted=false (e.g. "no standing")
  "job_id"?: "uuid"             // when accepted=true
}
```

### `skills_list`  (read-only, opt-in)

If the lattice has opted into skill sharing, peers may list and read its
skills (intent §13 — exposure pattern).

```jsonc
{ "name": "skills_list" }

// Returns:
[{
  "name": "string",
  "description": "string",
  "abstraction": "specific" | "generic",
  "minted_at_cycle": number
}]

{ "name": "skills_get", "arguments": { "name": "string" } }

// Returns the SKILL.md content (frontmatter + R++ body).
```

Default: opt-out. Operator enables via a non-dial config setting per
lattice.

## What is NOT exposed

- Memory of any kind (Principle XIV — no shared memory).
- The trace.
- The SQLite file.
- The dials.
- The substrate.

A peer can converse, delegate, or read skills (if opted in). Nothing else.

## Standing enforcement

Receiving `converse` or `delegate` does NOT mean accepting. The receiver
routes the request into its own decide phase with the substrate-wrapped
Law 11 (Standing) in effect. The receiver may:

- Acknowledge but ignore (substrate rejects).
- Accept and create a job (substrate passes).
- Defer (substrate passes, but the receiver is busy).

The receiver's autonomy dial governs whether human confirmation is needed
before accepting.

## Transport

The lattice runs an MCP server on a per-lattice TCP port (auto-allocated
on instantiation; persisted in `entity`). The Bridge exposes the port to
the operator. Peer lattices connect via the registry's published URI.

## Registry interaction

```ts
// packages/collaboration/src/registry.ts

export interface PeerRegistry {
  /** Post our essence + endpoint URI on startup. */
  register(self: { lattice_id: string; name: string; essence: string; mcp_uri: string }): Promise<void>;

  /** Read peers on the slow cycle. */
  list(): Promise<RegistryEntry[]>;

  /** Heartbeat — refresh our entry so the registry can prune dead lattices. */
  heartbeat(self: { lattice_id: string }): Promise<void>;
}

export interface RegistryEntry {
  lattice_id: string;
  name: string;
  essence: string;
  mcp_uri: string;
  posted_at_ms: number;
}
```

The registry is dumb infrastructure (intent §15.1). A reference HTTP
implementation lives in `apps/registry/` (slice 13); a lattice may be
pointed at any registry URL.
