import type {
  InspectResponse,
  InstantiateRequest,
  InstantiateResponse,
  JobsHand,
  RosterRow,
  TraceQuery,
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
  streamUrl: (id: string) => `/api/lattices/${id}/trace/stream`,
};
