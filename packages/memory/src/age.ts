/**
 * Human-term age + freshness caveat (spec FR-017).
 *
 * Models reason about staleness better when ages are framed as
 * "47 days ago" than as raw timestamps.
 *
 * Caveat policy: a memory older than `STALE_THRESHOLD_MS` (default
 * 30 days) carries a caveat. Fresh memories carry an empty caveat
 * (noise reduction).
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY; // approximate
const YEAR = 365 * DAY;

export const STALE_THRESHOLD_MS = 30 * DAY;

export function humanAge(writtenAtMs: number, nowMs: number): string {
  const dt = Math.max(0, nowMs - writtenAtMs);
  if (dt < MINUTE) return 'just now';
  if (dt < HOUR) return `${Math.floor(dt / MINUTE)} minutes ago`;
  if (dt < DAY) return `${Math.floor(dt / HOUR)} hours ago`;
  if (dt < WEEK) return `${Math.floor(dt / DAY)} days ago`;
  if (dt < MONTH) return `${Math.floor(dt / WEEK)} weeks ago`;
  if (dt < YEAR) return `${Math.floor(dt / MONTH)} months ago`;
  return `${Math.floor(dt / YEAR)} years ago`;
}

export function freshnessCaveat(writtenAtMs: number, nowMs: number): string {
  const dt = Math.max(0, nowMs - writtenAtMs);
  if (dt < STALE_THRESHOLD_MS) return '';
  const age = humanAge(writtenAtMs, nowMs);
  return `(this memory is ${age}; verify before relying on it)`;
}
