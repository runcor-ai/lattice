/**
 * Drives — the motivational pulse (intent §10; constitution Principle III).
 *
 * Four drives, named per the intent spec:
 *   - resource_pressure: how tight resources (budget, time) feel
 *   - curiosity:         pull toward unfamiliar/under-explored regions
 *   - reactivity:        urgency-bias toward fresh perception
 *   - coherence:         pull toward staying on the current line
 *
 * Slice 2 ships the *minimum* pulse: a deterministic combination
 * function and the four-drive state. Slice 11 calibrates numeric
 * defaults against a reference workload.
 *
 * Note (constitution Principle I + FR-003): the pulse does NOT decide
 * whether to continue — the loop has no internal exit. The pulse
 * shapes *future* behaviour by feeding into the decide phase's
 * priority weighting.
 */

export const DRIVE_NAMES = [
  'resource_pressure',
  'curiosity',
  'reactivity',
  'coherence',
] as const;

export type DriveName = (typeof DRIVE_NAMES)[number];

export type DriveState = Readonly<Record<DriveName, number>>;

export const DEFAULT_DRIVE_STATE: DriveState = Object.freeze({
  resource_pressure: 0.1,
  curiosity: 0.5,
  reactivity: 0.3,
  coherence: 0.7,
});
