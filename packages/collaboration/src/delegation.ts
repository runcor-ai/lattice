import type { JobsService } from '@runcor/jobs';

import type { SelfExposure } from './mcp-self-exposure.js';
import { decideStanding } from './standing.js';
import type {
  DelegateRequest,
  DelegateResponse,
  RegistryEntry,
  StandingDecision,
} from './types.js';

/**
 * Delegation initiator (intent §15.1).
 *
 * One lattice OWNS a plan; it hands pieces out as jobs to other
 * lattices. The receiver does the work in its own memory and reports
 * back. The plan always has EXACTLY ONE owner — no co-editing.
 *
 * Slice 13 ships the initiator API + an in-process delegate
 * transport (calls peer.delegate directly) so tests don't need real
 * MCP transport. Production uses a peer transport that invokes the
 * peer's MCP `delegate` tool.
 */

export interface DelegateTransport {
  delegate(args: {
    target_lattice_id: string;
    from_lattice_id: string;
    job: DelegateRequest['job'];
  }): Promise<DelegateResponse>;
}

/** In-process transport — routes delegate to a target SelfExposure directly. */
export class InProcessDelegateTransport implements DelegateTransport {
  private readonly peers = new Map<string, SelfExposure>();

  attach(peer: SelfExposure): void {
    this.peers.set(peer.lattice_id, peer);
  }

  async delegate(args: {
    target_lattice_id: string;
    from_lattice_id: string;
    job: DelegateRequest['job'];
  }): Promise<DelegateResponse> {
    const peer = this.peers.get(args.target_lattice_id);
    if (!peer) {
      return { accepted: false, reason: `unknown peer ${args.target_lattice_id}` };
    }
    return peer.delegate(
      { from_lattice_id: args.from_lattice_id, job: args.job },
      { cycle: 0, at_ms: Date.now() },
    );
  }
}

export interface DelegateArgs {
  readonly peerEntry: RegistryEntry;
  readonly fromLatticeId: string;
  readonly fromIdentity: string;
  readonly job: DelegateRequest['job'];
  readonly transport: DelegateTransport;
  readonly jobs: JobsService;
  readonly cycle: number;
  readonly preAuthorized?: readonly string[];
}

export type DelegateInitiatorResult =
  | {
      result: 'delegated';
      remote_job_id: string;
      local_tracking_job_id: string;
      standing: StandingDecision;
    }
  | { result: 'rejected_by_peer'; reason: string; standing: StandingDecision }
  | { result: 'blocked_by_standing'; standing: StandingDecision };

/**
 * Send a delegation. Standing check first. On accept, opens a small
 * local "tracking" job on OUR plan so we know the remote work is in
 * flight (the actual checklist lives on the peer, not us).
 */
export async function delegateTo(args: DelegateArgs): Promise<DelegateInitiatorResult> {
  const standing = decideStanding({
    ownIdentity: args.fromIdentity,
    peerEssence: args.peerEntry.essence,
    peerLatticeId: args.peerEntry.lattice_id,
    ...(args.preAuthorized ? { preAuthorized: args.preAuthorized } : {}),
  });
  if (!standing.can_initiate) {
    return { result: 'blocked_by_standing', standing };
  }

  const response = await args.transport.delegate({
    target_lattice_id: args.peerEntry.lattice_id,
    from_lattice_id: args.fromLatticeId,
    job: args.job,
  });
  if (!response.accepted) {
    return { result: 'rejected_by_peer', reason: response.reason, standing };
  }

  // Open a tracking job locally — single item, deferred awaiting the peer's report.
  const tracking = args.jobs.openJob({
    title: `delegated: ${args.job.title} → ${args.peerEntry.name}`,
    source: `delegation:tracking:${args.peerEntry.lattice_id}`,
    why: `tracking remote job ${response.job_id} on peer ${args.peerEntry.lattice_id}`,
    cycle: args.cycle,
    at_ms: Date.now(),
  });
  const item = args.jobs.addItem(tracking.id, {
    description: `awaiting completion report for remote job ${response.job_id}`,
    spec: { hooks: [{ name: 'always_fail' }] },
  });
  args.jobs.defer(
    {
      itemId: item.id,
      reason: `awaiting completion report from peer ${args.peerEntry.lattice_id}`,
      unblockCondition: `peer reports remote job ${response.job_id} complete`,
      unblockTest: JSON.stringify({
        kind: 'sense_data_contains',
        sense: 'peer-reports',
        needle: response.job_id,
      }),
    },
    { cycle: args.cycle },
  );

  return {
    result: 'delegated',
    remote_job_id: response.job_id,
    local_tracking_job_id: tracking.id,
    standing,
  };
}
