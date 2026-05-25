import type { AdmissionTag, MemorySystem } from './types.js';

/**
 * The admission rule (constitution Principle XII; spec FR-014).
 *
 *   A thing becomes a memory ONLY if it cannot be reconstructed from
 *   the live world.
 *
 * Implementation: tag-based. The caller declares what KIND of write
 * this is via `admissionTag`. Tags marked re-perceivable are
 * REJECTED. Tags that genuinely represent decisions, reasons,
 * guidance, attribution, commitments, or cycle outcomes are admitted.
 *
 * The `why` field is also required for every memory (FR-015) — empty
 * `why` is rejected regardless of tag.
 */

export class AdmissionRejection extends Error {
  constructor(
    message: string,
    readonly reason: 'empty_why' | 'reperceivable' | 'unknown_tag_not_overridden',
    readonly tag?: AdmissionTag,
    readonly system?: MemorySystem,
  ) {
    super(message);
    this.name = 'AdmissionRejection';
  }
}

export interface AdmissionRequest {
  readonly system: MemorySystem;
  readonly body: string;
  readonly why: string;
  readonly admissionTag: AdmissionTag;
  /**
   * If true, allows an `unknown` tag through. Operator-confirmed
   * writes set this; auto-writes must use a specific tag.
   */
  readonly operatorOverride?: boolean;
}

const ADMITTED: ReadonlySet<AdmissionTag> = new Set([
  'decision',
  'guidance',
  'attribution',
  'cycle-outcome',
  'commitment',
]);

const REPERCEIVABLE: ReadonlySet<AdmissionTag> = new Set([
  'file-content',
  'tracker-state',
  'code-structure',
]);

export function check(req: AdmissionRequest): void {
  if (!req.why || req.why.trim() === '') {
    throw new AdmissionRejection(
      `admission rejected: empty "why" for ${req.system} (FR-015)`,
      'empty_why',
      req.admissionTag,
      req.system,
    );
  }
  if (REPERCEIVABLE.has(req.admissionTag)) {
    throw new AdmissionRejection(
      `admission rejected: tag="${req.admissionTag}" is re-perceivable; ` +
        `re-perceive it next cycle instead of storing (constitution Principle XII)`,
      'reperceivable',
      req.admissionTag,
      req.system,
    );
  }
  if (!ADMITTED.has(req.admissionTag) && req.admissionTag === 'unknown' && !req.operatorOverride) {
    throw new AdmissionRejection(
      `admission rejected: tag="unknown" requires an operator override`,
      'unknown_tag_not_overridden',
      req.admissionTag,
      req.system,
    );
  }
}

/** Convenience predicate for tests and tooling. */
export function isAdmissible(req: AdmissionRequest): boolean {
  try {
    check(req);
    return true;
  } catch {
    return false;
  }
}
