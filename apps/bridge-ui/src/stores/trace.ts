import { defineStore } from 'pinia';

import { Api } from '../api.js';

export interface UiTraceEntry {
  readonly kind: string;
  readonly cycle: number;
  readonly at_ms: number;
  readonly phase?: string;
  /** Stable per-entry id used as the v-for :key. NEVER shifts on prepend. */
  readonly _id: string;
  readonly [k: string]: unknown;
}

export const useTraceStore = defineStore('trace', {
  state: () => ({
    entries: [] as UiTraceEntry[],
    /**
     * Cap the in-memory ring so DOM stays cheap. Stub-backed lattices
     * fire thousands of trace events/sec; 300 rows in the v-for is
     * plenty for human readability, and the full trace is still
     * queryable via GET /api/lattices/:id/trace.
     */
    capacity: 300,
    streaming: false,
    /** Filter — null = all. */
    kindFilter: null as string | null,
    phaseFilter: null as string | null,
    eventSource: null as EventSource | null,
    _seq: 0,
  }),
  actions: {
    async loadInitial(latticeId: string) {
      const initial = (await Api.trace(latticeId, { limit: this.capacity })) as Array<
        Record<string, unknown>
      >;
      this.entries = initial
        .slice(-this.capacity)
        .map((e, i) => ({ ...e, _id: `init-${i}` }) as UiTraceEntry);
      this._seq = this.entries.length;
    },
    startStream(latticeId: string) {
      this.stopStream();
      const es = new EventSource(Api.streamUrl(latticeId));
      es.addEventListener('trace', (e) => {
        const ev = e as MessageEvent;
        try {
          const entry = JSON.parse(ev.data) as Record<string, unknown>;
          this._seq += 1;
          const sseId = ev.lastEventId ? `sse-${ev.lastEventId}` : `live-${this._seq}`;
          this.entries.push({ ...entry, _id: sseId } as UiTraceEntry);
          if (this.entries.length > this.capacity) {
            this.entries.splice(0, this.entries.length - this.capacity);
          }
        } catch {
          /* malformed */
        }
      });
      this.eventSource = es;
      this.streaming = true;
    },
    stopStream() {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      this.streaming = false;
    },
    clear() {
      this.entries = [];
    },
  },
  getters: {
    filtered: (state): UiTraceEntry[] => {
      return state.entries.filter((e) => {
        if (state.kindFilter && e.kind !== state.kindFilter) return false;
        if (state.phaseFilter && e.phase !== state.phaseFilter) return false;
        return true;
      });
    },
  },
});
