import type {
  InspectResponse,
  InstantiateRequest,
  InstantiateResponse,
  JobsHand,
  RosterRow,
  TraceQuery,
  TraceRow,
} from '@runcor/bridge-shared';

/**
 * Bridge API client — thin fetch wrapper. Lives next to the UI so
 * Pinia stores can stay focused on state + UX.
 */

const BASE = '';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const msg =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

/* ---- Forecast / predictions (analyst view) ---- */
export type CallStatus = 'HELD' | 'HELD-CAVEAT' | 'REVISED';
export interface ForecastCall {
  layer: string;
  status: CallStatus;
  confidence: string | null;
  claim: string | null;
  prior: string | null;
  signal: string | null;
  watching: string | null;
  whyNotYet: string | null;
  wouldFlip: string | null;
  killConditionMet: string | null;
  why: string | null;
  forecastBy: string | null; // the predictive date — when this call is forecast to resolve
  basis: string | null; // the current signal/evidence the forward prediction rests on
}
export interface CurrentCall extends ForecastCall {
  headline: string | null;
  prediction: string | null;
  killCondition: string | null;
  baselineConfidence: string | null;
}
export interface ForecastCycle {
  file: string;
  ts: number;
  iso: string;
  summary: string;
  calls: ForecastCall[];
}
export interface ForecastReport {
  generatedAt: string;
  available: boolean;
  thesis: { central: string | null; bet: string | null; horizon: string | null };
  baseline: Array<{ layer: string; headline: string; prediction: string; confidence: string | null; killCondition: string | null }>;
  current: CurrentCall[];
  currentAsOf: string | null;
  watchlist: Array<{ layer: string; wouldFlip: string | null; watching: string | null; whyNotYet: string | null; confidence: string | null }>;
  revisions: Array<ForecastCall & { iso: string }>;
  timeline: Record<string, Array<{ iso: string; ts: number; status: CallStatus; confidence: string | null }>>;
  cycles: ForecastCycle[];
  counts: { cycles: number; held: number; caveat: number; revised: number };
}

export const Api = {
  health: () => http<{ ok: boolean }>(`/api/health`),
  roster: () => http<RosterRow[]>(`/api/lattices`),
  inspect: (id: string) => http<InspectResponse>(`/api/lattices/${id}`),
  instantiate: (body: InstantiateRequest) =>
    http<InstantiateResponse>(`/api/lattices`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  trace: (id: string, q: Partial<TraceQuery> = {}) => {
    const sp = new URLSearchParams();
    if (q.limit !== undefined) sp.set('limit', String(q.limit));
    if (q.kind !== undefined) sp.set('kind', q.kind);
    if (q.phase !== undefined) sp.set('phase', q.phase);
    if (q.after_cycle !== undefined) sp.set('after_cycle', String(q.after_cycle));
    return http<Record<string, unknown>[]>(`/api/lattices/${id}/trace?${sp.toString()}`);
  },
  /**
   * Windowed trace read for the visualizer — fetches a bounded cycle range
   * [after_cycle, before_cycle) so scrubbing across thousands of cycles never
   * loads the whole run. Returns flat rows with a stable `id`.
   */
  traceRange: (
    id: string,
    q: { after_cycle?: number; before_cycle?: number; limit?: number } = {},
  ) => {
    const sp = new URLSearchParams();
    if (q.after_cycle !== undefined) sp.set('after_cycle', String(q.after_cycle));
    if (q.before_cycle !== undefined) sp.set('before_cycle', String(q.before_cycle));
    sp.set('limit', String(q.limit ?? 1000));
    return http<TraceRow[]>(`/api/lattices/${id}/trace?${sp.toString()}`);
  },
  /** The lattice's mind: situation summary, episodic/semantic/identity memories (each with why), plan, goals. */
  memory: (id: string, limit = 30) =>
    http<{
      situation: string | null;
      situation_cycle: number | null;
      episodic: Array<{ cycle: number; body: string; why: string }>;
      semantic: Array<{ cycle: number; body: string; why: string }>;
      identity: Array<{ cycle: number; body: string; why: string }>;
      goals: Array<{ body: string; state: string; why: string }>;
      plan: Array<{ ordinal: number; description: string; state: string }>;
      jobs: Array<{
        id: string;
        title: string;
        body: string;
        why: string;
        status: string;
        items: Array<{ ordinal: number; description: string; state: string }>;
      }>;
    }>(`/api/lattices/${id}/memory?limit=${limit}`),
  /** A Claude pass that summarizes the lattice's overall job + progress. */
  jobSummary: (id: string) =>
    http<{ summary: string | null }>(`/api/lattices/${id}/job-summary`),
  /** A Claude pass that summarizes a cycle's chain of thought (cached server-side). */
  cycleSummary: (id: string, cycle: number, cachedOnly = false) =>
    http<{ cycle: number; summary: string | null; cached: boolean }>(
      `/api/lattices/${id}/cycles/${cycle}/summary${cachedOnly ? '?cached_only=1' : ''}`,
    ),
  patchDials: (id: string, dials: Record<string, unknown>, why: string) =>
    http<{ applied_at_cycle: number }>(`/api/lattices/${id}/dials`, {
      method: 'PATCH',
      body: JSON.stringify({ dials, why }),
    }),
  action: (id: string, action: 'pause' | 'resume' | 'stop' | 'swap-backend', payload?: unknown) =>
    http<{ applied_at_cycle: number }>(
      `/api/lattices/${id}/actions/${action}`,
      payload === undefined
        ? { method: 'POST', body: '{}' }
        : { method: 'POST', body: JSON.stringify(payload) },
    ),
  handJob: (id: string, body: JobsHand) =>
    http<{ job_id: string }>(`/api/lattices/${id}/jobs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  secrets: {
    summary: () => http<{ hasAnthropicKey: boolean; hasOpenaiKey: boolean }>(`/api/secrets`),
    save: (body: { anthropicApiKey?: string; openaiApiKey?: string }) =>
      http<void>(`/api/secrets`, { method: 'POST', body: JSON.stringify(body) }),
  },
  forecasts: (id: string) => http<ForecastReport>(`/api/lattices/${id}/forecasts`),
  streamUrl: (id: string) => `/api/lattices/${id}/trace/stream`,
};
