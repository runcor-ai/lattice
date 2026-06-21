<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { Api, type ForecastReport, type CallStatus } from '../api.js';

const props = defineProps<{ id: string }>();

const report = ref<ForecastReport | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const openCycle = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    report.value = await Api.forecasts(props.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const LABEL: Record<CallStatus, string> = {
  HELD: 'On track',
  'HELD-CAVEAT': 'Pressure building',
  REVISED: 'Revised',
};
const statusLabel = (s: CallStatus) => LABEL[s] ?? s;
const statusClass = (s: CallStatus) =>
  s === 'HELD' ? 'st-held' : s === 'HELD-CAVEAT' ? 'st-caveat' : 'st-revised';

const confMain = (c: string | null) => (c ? c.split('(')[0]!.trim() : '—');
const confTrend = (c: string | null) => {
  const m = c?.match(/\((.+)\)/);
  return m ? m[1] : null;
};
function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const r = computed(() => report.value);
</script>

<template>
  <section class="fc">
    <header class="fc-head">
      <div>
        <RouterLink :to="`/lattice/${id}`" class="back">◂ {{ id }}</RouterLink>
        <h2>Standing Forecast</h2>
        <p class="sub muted">
          Where durable value accrues across the agentic-AI stack
          <span v-if="r?.thesis.horizon"> · {{ r.thesis.horizon }}</span>
          <span v-if="r?.currentAsOf"> · as of {{ fmtDate(r.currentAsOf) }}</span>
        </p>
      </div>
      <button class="refresh" @click="load">↻ Refresh</button>
    </header>

    <div v-if="loading" class="state muted">Loading forecast…</div>
    <div v-else-if="error" class="state err">Could not load forecast: {{ error }}</div>
    <div v-else-if="!r || !r.available" class="state muted">
      No forecast on record yet for this lattice. Calls appear here once it commits its first forecast cycle.
    </div>

    <template v-else>
      <!-- Thesis -->
      <div v-if="r.thesis.bet" class="thesis">
        <span class="thesis-k">Market thesis</span>
        <p>{{ r.thesis.bet }}</p>
      </div>

      <!-- Summary strip -->
      <div class="strip">
        <div class="stat"><b>{{ r.current.length }}</b><span>standing calls</span></div>
        <div class="stat ok"><b>{{ r.current.filter((c) => c.status === 'HELD').length }}</b><span>on track</span></div>
        <div class="stat warn"><b>{{ r.current.filter((c) => c.status === 'HELD-CAVEAT').length }}</b><span>under pressure</span></div>
        <div class="stat rev"><b>{{ r.current.filter((c) => c.status === 'REVISED').length }}</b><span>revised now</span></div>
        <div class="stat"><b>{{ r.counts.cycles }}</b><span>review cycles</span></div>
      </div>

      <!-- Current calls -->
      <h3 class="sec">Current calls</h3>
      <div class="cards">
        <article v-for="c in r.current" :key="c.layer" class="card" :class="statusClass(c.status)">
          <div class="card-top">
            <div class="layer">{{ c.layer }}</div>
            <span class="badge" :class="statusClass(c.status)">{{ statusLabel(c.status) }}</span>
          </div>
          <p class="headline">{{ c.headline || c.claim }}</p>
          <p v-if="c.prediction" class="pred">{{ c.prediction }}</p>

          <div class="conf-row">
            <span class="conf">Confidence: <b>{{ confMain(c.confidence || c.baselineConfidence) }}</b></span>
            <span v-if="confTrend(c.confidence)" class="trend">▾ {{ confTrend(c.confidence) }}</span>
          </div>

          <!-- pressure / caveat -->
          <div v-if="c.status === 'HELD-CAVEAT'" class="watchbox">
            <div class="wb-k">⚠ Pressure building — not yet decisive</div>
            <p v-if="c.whyNotYet"><span class="wb-l">Why it hasn't flipped:</span> {{ c.whyNotYet }}</p>
            <p v-if="c.wouldFlip"><span class="wb-l">What would change the call:</span> {{ c.wouldFlip }}</p>
          </div>
          <!-- revision -->
          <div v-else-if="c.status === 'REVISED'" class="revbox">
            <p v-if="c.prior"><span class="wb-l">Was:</span> {{ c.prior }}</p>
            <p v-if="c.claim"><span class="wb-l">Now:</span> {{ c.claim }}</p>
            <p v-if="c.why"><span class="wb-l">Trigger:</span> {{ c.why }}</p>
          </div>

          <div class="card-foot">
            <span v-if="c.killCondition" class="kill" :title="c.killCondition"><b>Disproven if:</b> {{ c.killCondition }}</span>
            <span v-if="c.signal || c.watching" class="evi mono">📄 {{ c.signal || c.watching }}</span>
          </div>
        </article>
      </div>

      <!-- Leading indicators -->
      <template v-if="r.watchlist.length">
        <h3 class="sec">Leading indicators — what to monitor</h3>
        <p class="sec-sub muted">Calls under pressure and the concrete signal that would change each one. These are the early-warning items to track.</p>
        <table class="watch">
          <thead><tr><th>Layer</th><th>What would change the call</th><th>Currently watching</th><th>Confidence</th></tr></thead>
          <tbody>
            <tr v-for="w in r.watchlist" :key="w.layer">
              <td class="w-layer">{{ w.layer }}</td>
              <td>{{ w.wouldFlip || '—' }}</td>
              <td class="mono w-sig">{{ w.watching || '—' }}</td>
              <td>{{ confMain(w.confidence) }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- Recent revisions -->
      <template v-if="r.revisions.length">
        <h3 class="sec">Recent revisions</h3>
        <div class="rev-list">
          <div v-for="(rv, i) in r.revisions" :key="i" class="rev-item">
            <div class="rev-head"><span class="w-layer">{{ rv.layer }}</span><span class="muted mono">{{ fmtDate(rv.iso) }}</span></div>
            <p v-if="rv.prior" class="rev-was">Was: {{ rv.prior }}</p>
            <p class="rev-now">Now: {{ rv.claim }}</p>
            <p v-if="rv.why" class="muted">Trigger: {{ rv.why }}</p>
          </div>
        </div>
      </template>

      <!-- Call evolution -->
      <h3 class="sec">How each call has moved</h3>
      <div class="evo">
        <div v-for="(pts, layer) in r.timeline" :key="layer" class="evo-row">
          <div class="evo-layer">{{ layer }}</div>
          <div class="evo-track">
            <span
              v-for="(p, i) in pts"
              :key="i"
              class="evo-pt"
              :class="statusClass(p.status)"
              :title="`${statusLabel(p.status)} · ${confMain(p.confidence)} · ${fmtDate(p.iso)}`"
            >{{ p.status === 'HELD' ? '●' : p.status === 'HELD-CAVEAT' ? '◆' : '★' }}</span>
          </div>
        </div>
        <div class="legend muted">● on track &nbsp; ◆ pressure building &nbsp; ★ revised &nbsp;—&nbsp; left = older, right = latest</div>
      </div>

      <!-- Forecast log -->
      <h3 class="sec">Forecast log</h3>
      <div class="log">
        <div v-for="cy in r.cycles" :key="cy.file" class="log-item">
          <button class="log-head" @click="openCycle = openCycle === cy.file ? null : cy.file">
            <span class="mono muted">{{ fmtDate(cy.iso) }}</span>
            <span class="log-pills">
              <span v-for="c in cy.calls" :key="c.layer" class="pill" :class="statusClass(c.status)" :title="`${c.layer}: ${statusLabel(c.status)}`">{{ c.layer.slice(0, 3) }}</span>
            </span>
            <span class="chev">{{ openCycle === cy.file ? '▾' : '▸' }}</span>
          </button>
          <div v-if="openCycle === cy.file" class="log-body">
            <p class="log-summary">{{ cy.summary }}</p>
            <div v-for="c in cy.calls" :key="c.layer" class="log-call">
              <span class="badge sm" :class="statusClass(c.status)">{{ statusLabel(c.status) }}</span>
              <b>{{ c.layer }}</b>
              <span>{{ c.claim }}</span>
              <span v-if="c.signal || c.watching" class="mono faint"> · 📄 {{ c.signal || c.watching }}</span>
            </div>
          </div>
        </div>
      </div>

      <p class="gen muted">Generated {{ fmtDate(r.generatedAt) }} · reflects the lattice's committed forecast ledger.</p>
    </template>
  </section>
</template>

<style scoped>
.fc { max-width: 1100px; margin: 0 auto; }
.fc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-3); }
.back { font-size: var(--t-xs); color: var(--text-2); text-decoration: none; }
.back:hover { color: var(--accent); }
.fc-head h2 { margin: var(--s-1) 0 var(--s-1); }
.sub { font-size: var(--t-sm); }
.refresh { white-space: nowrap; }
.state { padding: var(--s-6); text-align: center; }
.state.err { color: var(--red); }

.thesis { display: flex; gap: var(--s-3); align-items: baseline; background: var(--bg-1); border: var(--bw) solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--r-2); padding: var(--s-3) var(--s-4); margin: var(--s-4) 0; }
.thesis-k { font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); white-space: nowrap; }
.thesis p { margin: 0; font-size: var(--t-md); line-height: var(--leading-normal); }

.strip { display: flex; gap: var(--s-3); flex-wrap: wrap; margin: var(--s-4) 0 var(--s-2); }
.stat { background: var(--bg-1); border: var(--bw) solid var(--line); border-radius: var(--r-2); padding: var(--s-2) var(--s-4); min-width: 92px; }
.stat b { display: block; font-size: var(--t-xl); }
.stat span { font-size: var(--t-xs); color: var(--text-2); }
.stat.ok b { color: var(--green); }
.stat.warn b { color: var(--orange); }
.stat.rev b { color: var(--accent); }

.sec { margin: var(--s-6) 0 var(--s-2); font-size: var(--t-lg); }
.sec-sub { font-size: var(--t-sm); margin: 0 0 var(--s-3); }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: var(--s-3); }
.card { background: var(--bg-1); border: var(--bw) solid var(--line); border-top: 3px solid var(--line-strong); border-radius: var(--r-2); padding: var(--s-3) var(--s-4); display: flex; flex-direction: column; gap: var(--s-2); }
.card.st-held { border-top-color: var(--green); }
.card.st-caveat { border-top-color: var(--orange); }
.card.st-revised { border-top-color: var(--accent); }
.card-top { display: flex; justify-content: space-between; align-items: center; }
.layer { font-weight: 700; letter-spacing: 0.02em; }
.badge { font-size: var(--t-xs); padding: 2px 8px; border-radius: var(--r-1); font-weight: 600; }
.badge.sm { font-size: 10px; }
.badge.st-held { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); }
.badge.st-caveat { background: color-mix(in srgb, var(--orange) 20%, transparent); color: var(--orange); }
.badge.st-revised { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
.headline { margin: 0; font-weight: 600; font-size: var(--t-md); line-height: var(--leading-tight); }
.pred { margin: 0; font-size: var(--t-sm); color: var(--text-1); line-height: var(--leading-normal); }
.conf-row { display: flex; gap: var(--s-3); align-items: baseline; font-size: var(--t-sm); }
.conf b { color: var(--text-0); }
.trend { color: var(--orange); font-size: var(--t-xs); }
.watchbox { background: color-mix(in srgb, var(--orange) 8%, var(--bg-2)); border: var(--bw) solid color-mix(in srgb, var(--orange) 30%, var(--line)); border-radius: var(--r-1); padding: var(--s-2) var(--s-3); }
.revbox { background: color-mix(in srgb, var(--accent) 8%, var(--bg-2)); border: var(--bw) solid color-mix(in srgb, var(--accent) 25%, var(--line)); border-radius: var(--r-1); padding: var(--s-2) var(--s-3); }
.watchbox p, .revbox p { margin: 4px 0; font-size: var(--t-sm); line-height: var(--leading-normal); }
.wb-k { font-size: var(--t-xs); font-weight: 700; color: var(--orange); text-transform: uppercase; letter-spacing: 0.04em; }
.wb-l { color: var(--text-2); font-weight: 600; }
.card-foot { margin-top: auto; display: flex; flex-direction: column; gap: 4px; padding-top: var(--s-2); border-top: var(--bw) solid var(--line); }
.kill { font-size: var(--t-xs); color: var(--text-2); line-height: var(--leading-normal); }
.kill b { color: var(--text-1); }
.evi { font-size: var(--t-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.watch { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.watch th { text-align: left; font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); border-bottom: var(--bw) solid var(--line-strong); padding: var(--s-2); }
.watch td { padding: var(--s-2); border-bottom: var(--bw) solid var(--line); vertical-align: top; line-height: var(--leading-normal); }
.w-layer { font-weight: 700; white-space: nowrap; }
.w-sig { color: var(--text-3); font-size: var(--t-xs); }

.rev-list { display: flex; flex-direction: column; gap: var(--s-2); }
.rev-item { background: var(--bg-1); border: var(--bw) solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--r-1); padding: var(--s-2) var(--s-3); }
.rev-head { display: flex; justify-content: space-between; font-size: var(--t-xs); }
.rev-was { margin: 4px 0 0; color: var(--text-3); text-decoration: line-through; font-size: var(--t-sm); }
.rev-now { margin: 2px 0; font-size: var(--t-sm); }

.evo { background: var(--bg-1); border: var(--bw) solid var(--line); border-radius: var(--r-2); padding: var(--s-3) var(--s-4); }
.evo-row { display: flex; align-items: center; gap: var(--s-3); padding: 3px 0; }
.evo-layer { width: 130px; font-size: var(--t-sm); font-weight: 600; }
.evo-track { display: flex; gap: 6px; }
.evo-pt { font-size: var(--t-md); cursor: default; }
.evo-pt.st-held { color: var(--green); }
.evo-pt.st-caveat { color: var(--orange); }
.evo-pt.st-revised { color: var(--accent); }
.legend { font-size: var(--t-xs); margin-top: var(--s-2); }

.log { display: flex; flex-direction: column; gap: var(--s-1); }
.log-item { border: var(--bw) solid var(--line); border-radius: var(--r-1); overflow: hidden; }
.log-head { width: 100%; display: flex; align-items: center; gap: var(--s-3); justify-content: space-between; background: var(--bg-1); border: none; border-radius: 0; padding: var(--s-2) var(--s-3); cursor: pointer; text-align: left; }
.log-pills { display: flex; gap: 3px; flex-wrap: wrap; flex: 1; }
.pill { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: var(--r-1); }
.pill.st-held { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); }
.pill.st-caveat { background: color-mix(in srgb, var(--orange) 20%, transparent); color: var(--orange); }
.pill.st-revised { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
.chev { color: var(--text-2); }
.log-body { padding: var(--s-3); background: var(--bg-0); border-top: var(--bw) solid var(--line); }
.log-summary { margin: 0 0 var(--s-2); font-size: var(--t-sm); color: var(--text-1); line-height: var(--leading-normal); }
.log-call { font-size: var(--t-sm); padding: 3px 0; display: flex; gap: var(--s-2); align-items: baseline; flex-wrap: wrap; line-height: var(--leading-normal); }
.faint { opacity: 0.6; }
.gen { font-size: var(--t-xs); margin-top: var(--s-5); text-align: right; }
</style>
