/**
 * assessCapability — substrate-policy gate for tool-discovery
 * candidates (intent §15; spec FR-043).
 *
 * Tool discovery is GOVERNED, not open. Before adding a candidate
 * MCP server to a lattice's manifest, the substrate evaluates it
 * against the policy stated below. Slice 5 ships the gate; the
 * tool-discovery layer wires it in slice 10 (capabilities).
 *
 * Default policy (configurable in slice 14 via the Bridge):
 *   - Reject candidates whose description claims to bypass laws
 *     or override the substrate.
 *   - Reject candidates with `destructive: true` AND `role.sense: false`
 *     when autonomy = low.
 *   - Reject MCP URIs outside the allowed scheme set.
 */

export interface CapabilityCandidate {
  readonly name: string;
  readonly description: string;
  readonly mcpServerUri?: string;
  readonly proposedRole: { sense: boolean; action: boolean };
  readonly destructive: boolean;
}

export interface PolicyContext {
  readonly autonomy: 'low' | 'medium' | 'high';
  readonly allowedSchemes?: readonly string[];
}

export type AssessResult = { admit: true } | { admit: false; reason: string };

const DEFAULT_ALLOWED_SCHEMES = Object.freeze(['mcp', 'mcps', 'stdio', 'http', 'https']);

const FORBIDDEN_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /\b(bypass|override|disable|suppress|ignore)\b.{0,40}\b(law|substrate|gate|discernment)\b/i,
  /\b(uncensored|jailbreak|prompt injection)\b/i,
];

export function assessCapability(
  candidate: CapabilityCandidate,
  ctx: PolicyContext,
): AssessResult {
  for (const re of FORBIDDEN_DESCRIPTION_PATTERNS) {
    if (re.test(candidate.description)) {
      return {
        admit: false,
        reason: `candidate "${candidate.name}" matched forbidden description pattern: ${re.source}`,
      };
    }
  }
  if (candidate.destructive && !candidate.proposedRole.sense && ctx.autonomy === 'low') {
    return {
      admit: false,
      reason: `candidate "${candidate.name}" is destructive-only; rejected at autonomy=low`,
    };
  }
  if (candidate.mcpServerUri) {
    const scheme = candidate.mcpServerUri.split(':', 1)[0]?.toLowerCase() ?? '';
    const allowed = ctx.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
    if (!allowed.includes(scheme)) {
      return {
        admit: false,
        reason: `candidate "${candidate.name}" uses disallowed scheme: ${scheme}`,
      };
    }
  }
  return { admit: true };
}
