import type { InspectResponse, RosterRow } from '@runcor/bridge-shared';
import { defineStore } from 'pinia';

import { Api } from '../api.js';

export const useLatticesStore = defineStore('lattices', {
  state: () => ({
    rows: [] as RosterRow[],
    selected: null as RosterRow | null,
    inspect: null as InspectResponse | null,
    loading: false,
    error: null as string | null,
    lastRefreshAtMs: 0,
  }),
  actions: {
    async refresh() {
      this.loading = true;
      try {
        this.rows = await Api.roster();
        this.lastRefreshAtMs = Date.now();
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },
    async select(id: string | null) {
      if (id === null) {
        this.selected = null;
        this.inspect = null;
        return;
      }
      const row = this.rows.find((r) => r.lattice_id === id);
      this.selected = row ?? null;
      try {
        this.inspect = await Api.inspect(id);
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    },
  },
});
