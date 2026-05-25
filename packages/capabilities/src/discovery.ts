import { assessCapability, type CapabilityCandidate as SubstrateCandidate } from '@runcor/substrate';

import type { Capability } from './types.js';

/**
 * Tool discovery (intent §15; spec FR-043).
 *
 * The lattice queries the MCP Registry for candidates, then the
 * substrate's `assessCapability` gates each one. Rejected candidates
 * never reach the manifest; their reasons are returned so the
 * runtime can record them to the trace.
 *
 * Slice 10 ships the discovery flow + substrate-veto. The actual
 * registry HTTP client lives in `registry-client.ts`; the discovery
 * adapter `Discovery` takes a `RegistryClient` so tests can stub it.
 */

export interface DiscoveryCandidate {
  readonly candidateId: string;
  readonly name: string;
  readonly description: string;
  readonly mcpServerUri?: string;
  readonly proposedRole: { sense: boolean; action: boolean };
  readonly destructive: boolean;
}

export type AdoptionOutcome =
  | { result: 'admitted'; candidate: DiscoveryCandidate; capability: Capability<unknown, unknown> }
  | { result: 'rejected'; candidate: DiscoveryCandidate; reason: string };

export interface RegistryClient {
  search(query: string): Promise<readonly DiscoveryCandidate[]>;
}

export interface DiscoveryOptions {
  readonly autonomy: 'low' | 'medium' | 'high';
  readonly allowedSchemes?: readonly string[];
  /** How to materialise an admitted candidate into a Capability. */
  readonly factory: (candidate: DiscoveryCandidate) => Capability<unknown, unknown>;
}

export class Discovery {
  constructor(private readonly client: RegistryClient) {}

  /**
   * Search the registry and return per-candidate adoption outcomes.
   * The substrate's `assessCapability` rejects candidates that:
   *   - claim to bypass the substrate (description pattern match),
   *   - are destructive-only at autonomy=low,
   *   - use a disallowed URI scheme.
   */
  async search(
    query: string,
    opts: DiscoveryOptions,
  ): Promise<readonly AdoptionOutcome[]> {
    const candidates = await this.client.search(query);
    const out: AdoptionOutcome[] = [];

    for (const c of candidates) {
      const substrateCandidate: SubstrateCandidate = {
        name: c.name,
        description: c.description,
        proposedRole: c.proposedRole,
        destructive: c.destructive,
        ...(c.mcpServerUri ? { mcpServerUri: c.mcpServerUri } : {}),
      };
      const assess = assessCapability(substrateCandidate, {
        autonomy: opts.autonomy,
        ...(opts.allowedSchemes ? { allowedSchemes: opts.allowedSchemes } : {}),
      });
      if (!assess.admit) {
        out.push({ result: 'rejected', candidate: c, reason: assess.reason });
        continue;
      }
      let cap: Capability<unknown, unknown>;
      try {
        cap = opts.factory(c);
      } catch (err) {
        out.push({
          result: 'rejected',
          candidate: c,
          reason: `factory failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      out.push({ result: 'admitted', candidate: c, capability: cap });
    }
    return out;
  }
}
