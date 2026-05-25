import type { StandingDecision } from './types.js';

/**
 * Standing (constitution Law 11; intent §15.1).
 *
 * Discovering a peer is NOT licence to engage. Whether THIS lattice
 * may initiate to THAT peer is governed by Law 11 — act within your
 * place in the structure.
 *
 * Slice 13 ships a deterministic check based on role keywords in
 * each side's essence. Slice 14+ can wire a Decider-driven check.
 *
 * Default rule: a lattice may initiate to a peer iff:
 *   - it has explicit "may engage <role>" / "may delegate to <role>"
 *     phrasing in its own identity, OR
 *   - the peer's essence indicates a "service" role (sales, support,
 *     intake) that everyone may engage, OR
 *   - the peer's lattice_id is in this lattice's `pre-authorized`
 *     list (set at company-bundle instantiation).
 *
 * The default rule is purposely conservative — it refuses by default,
 * matching the spirit of "structure enforced by knowing your place".
 */

const SERVICE_ROLE_HINTS: readonly RegExp[] = [
  /\b(sales|support|intake|reception|help-?desk)\b/i,
];

export interface StandingPolicy {
  /** This lattice's identity composed_body. */
  readonly ownIdentity: string;
  /** The target peer's one-sentence essence. */
  readonly peerEssence: string;
  /** Optional pre-authorised peer IDs (from company bundle config). */
  readonly preAuthorized?: readonly string[];
  /** The target peer's lattice_id. */
  readonly peerLatticeId: string;
}

export function decideStanding(policy: StandingPolicy): StandingDecision {
  if (policy.preAuthorized?.includes(policy.peerLatticeId)) {
    return { can_initiate: true };
  }

  if (SERVICE_ROLE_HINTS.some((re) => re.test(policy.peerEssence))) {
    return { can_initiate: true };
  }

  // Look for explicit licence in own identity.
  const license = /(may engage|may delegate to)\s+([\w\-]+)/i.exec(policy.ownIdentity);
  if (license && policy.peerEssence.toLowerCase().includes(license[2]!.toLowerCase())) {
    return { can_initiate: true };
  }

  return {
    can_initiate: false,
    reason:
      "Law 11 (Standing): no licence in this lattice's identity to initiate with this peer.",
  };
}
