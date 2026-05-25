import { randomUUID } from 'node:crypto';

import { type JobsService } from '@runcor/jobs';

import type { SelfExposure } from './mcp-self-exposure.js';
import { decideStanding } from './standing.js';
import type { ConverseAck, RegistryEntry, StandingDecision } from './types.js';

/**
 * Conversation initiator (intent §15.1).
 *
 * A conversation is a JOB on the CALLER's plan. The loop is never
 * blocked — each cycle says the next thing, perception sees the
 * reply, repeat. If the peer goes silent past the configured
 * window, the conversation job DEFERS with unblock condition
 * "peer responds".
 *
 * Slice 13 ships the initiator API + a simple "peer transport"
 * abstraction so tests can route calls in-process without real MCP.
 */

export interface PeerTransport {
  /** Call the peer's MCP `converse` tool. */
  converse(args: {
    target_lattice_id: string;
    from_lattice_id: string;
    conversation_id: string | null;
    message_rpp: string;
  }): Promise<ConverseAck>;
}

/** In-process transport — routes converse to a target SelfExposure directly. */
export class InProcessTransport implements PeerTransport {
  private readonly peers = new Map<string, SelfExposure>();

  attach(peer: SelfExposure): void {
    this.peers.set(peer.lattice_id, peer);
  }

  async converse(args: {
    target_lattice_id: string;
    from_lattice_id: string;
    conversation_id: string | null;
    message_rpp: string;
  }): Promise<ConverseAck> {
    const peer = this.peers.get(args.target_lattice_id);
    if (!peer) throw new Error(`InProcessTransport: unknown peer ${args.target_lattice_id}`);
    return peer.converse(
      {
        from_lattice_id: args.from_lattice_id,
        conversation_id: args.conversation_id,
        message_rpp: args.message_rpp,
      },
      { cycle: 0, at_ms: Date.now() },
    );
  }
}

export interface OpenConversationArgs {
  readonly peerEntry: RegistryEntry;
  readonly fromLatticeId: string;
  readonly fromIdentity: string;
  readonly transport: PeerTransport;
  readonly jobs: JobsService;
  readonly cycle: number;
  /** Optional pre-authorised peer IDs from a company bundle. */
  readonly preAuthorized?: readonly string[];
  /** Cycles before the conversation job defers on peer silence. Default 5. */
  readonly silenceCyclesUntilDefer?: number;
}

export interface ConversationHandle {
  readonly conversation_id: string;
  readonly job_id: string;
  readonly peer_lattice_id: string;
}

export type OpenResult =
  | { result: 'opened'; handle: ConversationHandle; standing: StandingDecision }
  | { result: 'blocked_by_standing'; standing: StandingDecision };

/**
 * Open a conversation. Performs the standing check first — Law 11.
 * On block, returns a `blocked_by_standing` result; the trace should
 * record this and the peer is left alone.
 */
export async function openConversation(args: OpenConversationArgs): Promise<OpenResult> {
  const standing = decideStanding({
    ownIdentity: args.fromIdentity,
    peerEssence: args.peerEntry.essence,
    peerLatticeId: args.peerEntry.lattice_id,
    ...(args.preAuthorized ? { preAuthorized: args.preAuthorized } : {}),
  });
  if (!standing.can_initiate) {
    return { result: 'blocked_by_standing', standing };
  }

  // Open the conversation as a JOB on our own plan.
  const job = args.jobs.openJob({
    title: `conversation with ${args.peerEntry.name}`,
    source: `conversation:initiated`,
    why: `initiated by ${args.fromLatticeId}; target ${args.peerEntry.lattice_id}`,
    cycle: args.cycle,
    at_ms: Date.now(),
  });
  const conversation_id = randomUUID();
  return {
    result: 'opened',
    handle: {
      conversation_id,
      job_id: job.id,
      peer_lattice_id: args.peerEntry.lattice_id,
    },
    standing,
  };
}

export interface SayArgs {
  readonly handle: ConversationHandle;
  readonly fromLatticeId: string;
  readonly message_rpp: string;
  readonly transport: PeerTransport;
  readonly jobs: JobsService;
  readonly cycle: number;
  readonly silenceCyclesUntilDefer?: number;
}

export type SayResult =
  | { result: 'acked'; ack: ConverseAck }
  | { result: 'peer_silent'; reason: string };

/**
 * Send the next message on a conversation. On transport failure,
 * defers the conversation job with unblock condition
 * `cycle_after: cycle + silenceCyclesUntilDefer`.
 */
export async function say(args: SayArgs): Promise<SayResult> {
  try {
    const ack = await args.transport.converse({
      target_lattice_id: args.handle.peer_lattice_id,
      from_lattice_id: args.fromLatticeId,
      conversation_id: args.handle.conversation_id,
      message_rpp: args.message_rpp,
    });
    return { result: 'acked', ack };
  } catch (err) {
    const silence = args.silenceCyclesUntilDefer ?? 5;
    // Find the latest open item on the conversation job and defer it.
    const items = args.jobs.checklist.items(args.handle.job_id);
    const targetItem = [...items].reverse().find((i) => i.state === 'open');
    if (!targetItem) {
      return {
        result: 'peer_silent',
        reason: `transport failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    args.jobs.defer(
      {
        itemId: targetItem.id,
        reason: `waiting on peer ${args.handle.peer_lattice_id} to respond after silence`,
        unblockCondition: 'peer responds',
        unblockTest: JSON.stringify({ kind: 'cycle_after', cycle: args.cycle + silence }),
      },
      { cycle: args.cycle },
    );
    return {
      result: 'peer_silent',
      reason: `transport failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
