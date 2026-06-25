<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Api } from '../api.js';
import { useLatticesStore } from '../stores/lattices.js';

const lattices = useLatticesStore();
const router = useRouter();

// Per-lattice health enrichment beyond the roster row: standing calls, last wake,
// status breakdown (from /forecasts) and closed-job count (from /inspect). Fetched
// alongside the roster so the board shows everything's running without drilling in.
type Health = { calls: number; asOf: string | null; held: number; caveat: number; revised: number; cycles: number; available: boolean; closed: number | null };
const health = ref<Record<string, Health>>({});

async function refreshHealth() {
  await Promise.all(
    lattices.rows.map(async (row) => {
      const [fc, ins] = await Promise.all([
        Api.forecasts(row.lattice_id).catch(() => null),
        Api.inspect(row.lattice_id).catch(() => null),
      ]);
      health.value[row.lattice_id] = {
        calls: fc?.current?.length ?? 0,
        asOf: fc?.currentAsOf ?? null,
        held: fc?.counts?.held ?? 0,
        caveat: fc?.counts?.caveat ?? 0,
        revised: fc?.counts?.revised ?? 0,
        cycles: fc?.counts?.cycles ?? 0,
        available: fc?.available ?? false,
        closed: ins?.memory_summary?.plan_jobs_closed ?? null,
      };
    }),
  );
}

let rosterTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  await lattices.refresh();
  await refreshHealth();
  rosterTimer = setInterval(() => lattices.refresh(), 2_000);
  healthTimer = setInterval(refreshHealth, 5_000);
});
onBeforeUnmount(() => {
  if (rosterTimer) clearInterval(rosterTimer);
  if (healthTimer) clearInterval(healthTimer);
});

function open(id: string) { router.push(`/lattice/${id}`); }
function forecast(id: string) { router.push(`/lattice/${id}/forecast`); }
function visualize(id: string) { router.push(`/lattice/${id}/visualize`); }
function instantiate() { router.push('/instantiate'); }

const h = (id: string): Health => health.value[id] ?? { calls: 0, asOf: null, held: 0, caveat: 0, revised: 0, cycles: 0, available: false, closed: null };
function statusLabel(s: string) { return s === 'paused_no_jobs' ? 'resting' : s; }
function fmtDay(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}
</script>

<template>
  <section class="roster">
    <div class="roster-header">
      <div>
        <div class="eyebrow">Field Intelligence · all entities</div>
        <h2>Lattices</h2>
      </div>
      <div class="actions">
        <span class="muted last-refresh num" v-if="lattices.lastRefreshAtMs">
          refreshed {{ new Date(lattices.lastRefreshAtMs).toLocaleTimeString() }}
        </span>
        <button class="primary" @click="instantiate">New lattice</button>
      </div>
    </div>

    <div v-if="lattices.error" class="error panel">
      <div class="panel-body">{{ lattices.error }}</div>
    </div>

    <div v-if="lattices.rows.length > 0" class="board">
      <article v-for="row in lattices.rows" :key="row.lattice_id" class="lat" :class="row.status" @click="open(row.lattice_id)">
        <div class="lat-band" :class="row.status">
          <span class="lat-status"><span class="dot" :class="row.status" aria-hidden="true"></span>{{ statusLabel(row.status) }}</span>
          <span class="lat-cyc num">cycle {{ row.cycle }}</span>
        </div>

        <div class="lat-body">
          <div class="lat-name">{{ row.name }}</div>
          <div class="lat-id num faint">{{ row.lattice_id }}</div>

          <div class="readouts">
            <div class="ro"><span class="ro-k eyebrow">Open</span><span class="ro-v num">{{ row.open_jobs }}</span></div>
            <div class="ro"><span class="ro-k eyebrow">Closed</span><span class="ro-v num">{{ h(row.lattice_id).closed ?? '—' }}</span></div>
            <div class="ro"><span class="ro-k eyebrow">Calls</span><span class="ro-v num">{{ h(row.lattice_id).calls }}</span></div>
            <div class="ro"><span class="ro-k eyebrow">Last wake</span><span class="ro-v num">{{ fmtDay(h(row.lattice_id).asOf) }}</span></div>
          </div>

          <div class="breakdown" v-if="h(row.lattice_id).available">
            <span class="bd held" title="on track"><span class="bd-g" aria-hidden="true">●</span>{{ h(row.lattice_id).held }} on track</span>
            <span class="bd caveat" title="pressure building"><span class="bd-g" aria-hidden="true">◆</span>{{ h(row.lattice_id).caveat }} pressure</span>
            <span class="bd revised" title="revised"><span class="bd-g" aria-hidden="true">★</span>{{ h(row.lattice_id).revised }} revised</span>
          </div>

          <div class="lat-meta">
            <span class="chip">{{ row.model_backend }}</span>
            <span class="chip">{{ row.autonomy }} autonomy</span>
          </div>
        </div>

        <div class="lat-links">
          <button @click.stop="open(row.lattice_id)">Inspect</button>
          <button @click.stop="forecast(row.lattice_id)">Forecast</button>
          <button @click.stop="visualize(row.lattice_id)">Visualize</button>
        </div>
      </article>
    </div>

    <div v-else class="panel empty">
      <p class="empty-title">No lattices yet.</p>
      <p class="muted">
        Instantiate one to begin. The entity will start cycling immediately and write its
        first trace entry within seconds.
      </p>
      <button class="primary" @click="instantiate">Instantiate a lattice</button>
    </div>
  </section>
</template>

<style scoped>
.roster-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: var(--s-5); }
.roster-header h2 { margin: 2px 0 0; font-size: var(--t-2xl); font-weight: 700; letter-spacing: -0.01em; }
.actions { display: flex; gap: var(--s-3); align-items: center; }
.last-refresh { font-size: var(--t-xs); }
.error { border-color: var(--red); color: var(--red); margin-bottom: var(--s-4); }

.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: var(--s-4); }

.lat {
  display: flex; flex-direction: column; min-width: 0;
  background: var(--bg-1); border: var(--bw) solid var(--line);
  border-radius: var(--r-3); overflow: hidden; cursor: pointer;
  transition: border-color var(--motion-fast) var(--easing), transform var(--motion-fast) var(--easing);
}
.lat:hover { border-color: var(--line-strong); }

/* status band */
.lat-band {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s-2) var(--s-4);
  border-bottom: var(--bw) solid var(--line);
  font-family: var(--font-mono); font-size: var(--t-xs); letter-spacing: 0.08em; text-transform: uppercase;
}
.lat-status { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; }
.lat-cyc { color: var(--text-2); letter-spacing: 0.02em; text-transform: none; }
.lat-band.running { background: color-mix(in srgb, var(--green) 12%, var(--bg-1)); color: var(--green); border-bottom-color: color-mix(in srgb, var(--green) 30%, var(--line)); }
.lat-band.paused, .lat-band.paused_no_jobs { background: color-mix(in srgb, var(--yellow) 11%, var(--bg-1)); color: var(--yellow); border-bottom-color: color-mix(in srgb, var(--yellow) 28%, var(--line)); }
.lat-band.crashed { background: color-mix(in srgb, var(--red) 12%, var(--bg-1)); color: var(--red); border-bottom-color: color-mix(in srgb, var(--red) 30%, var(--line)); }
.lat-band.stopped { color: var(--text-2); }

.lat-body { padding: var(--s-3) var(--s-4); display: flex; flex-direction: column; gap: var(--s-3); flex: 1; }
.lat-name { font-weight: 700; font-size: var(--t-lg); letter-spacing: -0.01em; overflow-wrap: anywhere; }
.lat-id { font-size: var(--t-xs); margin-top: -6px; }

.readouts { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-2); padding: var(--s-2) 0; border-top: var(--bw) solid var(--line); border-bottom: var(--bw) solid var(--line); }
.ro { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ro-k { font-size: 9px; }
.ro-v { font-size: var(--t-lg); font-weight: 600; }

.breakdown { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); font-family: var(--font-mono); font-size: var(--t-xs); }
.bd { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
.bd-g { font-size: 8px; }
.bd.held { color: var(--green); }
.bd.caveat { color: var(--orange); }
.bd.revised { color: var(--accent); }

.lat-meta { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-top: auto; }

.lat-links { display: grid; grid-template-columns: repeat(3, 1fr); border-top: var(--bw) solid var(--line); }
.lat-links button { border: none; border-radius: 0; font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-2); padding: var(--s-2); }
.lat-links button + button { border-left: var(--bw) solid var(--line); }
.lat-links button:hover { background: var(--bg-2); color: var(--accent); }

.empty { text-align: center; padding: var(--s-7) var(--s-4); }
.empty-title { font-size: var(--t-lg); margin-bottom: var(--s-2); }
</style>
