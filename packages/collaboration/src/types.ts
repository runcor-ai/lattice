/**
 * Collaboration types (intent §15.1; spec FR-044..048; constitution
 * Principle XIV — NO SHARED MEMORY).
 *
 * Three permitted forms:
 *   - Conversation: a back-and-forth, modelled as a JOB on the
 *     calling lattice's plan. Each cycle says the next thing; if
 *     the peer goes quiet, the job DEFERS with unblock condition
 *     "peer responds" — the loop is never blocked.
 *   - Delegation: one lattice owns a plan, hands pieces out as
 *     jobs to other lattices. The plan always has exactly one
 *     owner.
 *   - Read-only shared source of truth: external service all
 *     members READ but never write.
 *
 * Peer discovery: a registry. Lattices post their one-sentence
 * essence on startup; peers read on the slow cycle. Discovering a
 * peer is NOT licence to engage — Law 11 (Standing) governs that.
 */

export interface RegistryEntry {
  readonly lattice_id: string;
  readonly name: string;
  readonly essence: string;
  readonly mcp_uri: string;
  readonly posted_at_ms: number;
}

export interface SelfRegistration {
  readonly lattice_id: string;
  readonly name: string;
  readonly essence: string;
  readonly mcp_uri: string;
}

export interface PeerRegistry {
  /** Post our essence + endpoint on startup. */
  register(self: SelfRegistration): Promise<void>;
  /** Read peers on the slow cycle. */
  list(): Promise<readonly RegistryEntry[]>;
  /** Refresh our entry. */
  heartbeat(self: { lattice_id: string }): Promise<void>;
  /** Optional withdrawal at shutdown. */
  withdraw?(lattice_id: string): Promise<void>;
}

/* ----- The MCP-exposed surface (intent §15.1 "what is exposed") ----- */

export interface EssenceResponse {
  readonly lattice_id: string;
  readonly name: string;
  readonly essence: string;
}

export interface ConverseRequest {
  readonly from_lattice_id: string;
  readonly conversation_id: string | null;
  readonly message_rpp: string;
}

export interface ConverseAck {
  readonly ack: true;
  readonly conversation_id: string;
  readonly received_at_cycle: number;
}

export interface DelegateRequest {
  readonly from_lattice_id: string;
  readonly job: {
    readonly title: string;
    readonly body: string;
    readonly why: string;
    readonly items: readonly {
      readonly description: string;
      readonly completion_check: string;
    }[];
  };
}

export type DelegateResponse =
  | { readonly accepted: true; readonly job_id: string }
  | { readonly accepted: false; readonly reason: string };

export interface SkillListItem {
  readonly name: string;
  readonly description: string;
  readonly abstraction: 'specific' | 'generic';
  readonly minted_at_cycle: number;
}

/* ----- Standing (Law 11) ----- */

export interface StandingDecision {
  readonly can_initiate: boolean;
  readonly reason?: string;
}

export interface PeerKnown {
  readonly id: string;
  readonly essence: string;
  readonly registry_url: string;
  readonly first_seen_cycle: number;
  readonly last_seen_cycle: number;
  readonly last_seen_ms: number;
}
