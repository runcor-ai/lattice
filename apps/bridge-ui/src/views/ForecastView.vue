<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { Api, type ForecastReport, type CallStatus } from '../api.js';
import ConvictionGauge from '../components/ConvictionGauge.vue';

const props = defineProps<{ id: string }>();

const report = ref<ForecastReport | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const openCycle = ref<string | null>(null);
const lastUpdated = ref<number | null>(null);
const updatedClock = computed(() => (lastUpdated.value ? new Date(lastUpdated.value).toLocaleTimeString() : null));

// background:true is the auto-poll path — refresh data without flashing the loading state.
async function load(opts: { background?: boolean } = {}) {
  if (!opts.background) loading.value = true;
  error.value = null;
  try {
    report.value = await Api.forecasts(props.id);
    lastUpdated.value = Date.now();
  } catch (e) {
    // On a background poll, keep showing the last good report rather than blanking to an error.
    if (!opts.background) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// Event-driven refresh (NOT a timer): subscribe to the lattice's trace stream and re-fetch the
// forecast when a run's activity SETTLES — i.e. when the wake/run closes. During a run events
// stream in and keep resetting the debounce; ~3s after the last event (the run has closed and gone
// idle) we re-fetch ONCE, so the page shows the closed run's result on its own. When the lattice is
// idle there are no events and therefore no fetches — nothing polls.
let es: EventSource | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefreshOnSettle() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { void load({ background: true }); }, 3000);
}
onMounted(() => {
  void load();
  try {
    es = new EventSource(Api.streamUrl(props.id));
    es.addEventListener('trace', scheduleRefreshOnSettle);
    es.onmessage = scheduleRefreshOnSettle; // fallback for unnamed events
  } catch { /* stream unavailable → manual Refresh still works */ }
});
onUnmounted(() => {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  if (es) { es.close(); es = null; }
});

const LABEL: Record<CallStatus, string> = {
  HELD: 'On track',
  'HELD-CAVEAT': 'Pressure building',
  REVISED: 'Revised',
};
const statusLabel = (s: CallStatus) => LABEL[s] ?? s;
const statusClass = (s: CallStatus) =>
  s === 'HELD' ? 'st-held' : s === 'HELD-CAVEAT' ? 'st-caveat' : 'st-revised';
// A shape per status, so the banner reads without relying on color alone.
const GLYPH: Record<CallStatus, string> = { HELD: '●', 'HELD-CAVEAT': '◆', REVISED: '★' };
const statusGlyph = (s: CallStatus) => GLYPH[s] ?? '●';

const confMain = (c: string | null) => (c ? c.split('(')[0]!.trim() : '—');
// The basis note in a confidence string, with the leading number stripped.
function confNote(c: string | null): string | null {
  if (!c) return null;
  let t = c.trim().replace(/^\d+(?:\.\d+)?(?:\s*\/\s*100)?/, '').trim();
  t = t.replace(/^[—\-–:().,\s]+/, '').replace(/[()]+$/, '').trim();
  return t || null;
}
function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const r = computed(() => report.value);

// "Where it sits" — numericize the lattice's own confidence into a 0–100 position (no engine/text
// change; derived from the confidence/status it already assigns per cycle from the signal).
const POS: Record<string, number> = { high: 88, medium: 60, 'low-medium': 48, 'low-med': 48, 'med-low': 48, low: 32, 'very-low': 20 };
function confNum(c: string | null): number {
  if (!c) return 50;
  const t = c.toLowerCase().split('(')[0]!.trim();
  const num = t.match(/(\d+(?:\.\d+)?)/);
  if (num) { let n = parseFloat(num[1]!); if (n <= 1) n *= 100; if (n >= 0 && n <= 100) return Math.round(n); }
  for (const k of Object.keys(POS).sort((a, b) => b.length - a.length)) if (t.includes(k)) return POS[k]!;
  if (t.includes('high')) return 88; if (t.includes('med')) return 60; if (t.includes('low')) return 32;
  return 50;
}
// Whether a call is actually grounded (has a real conviction). An ungrounded/deferred call —
// confidence "n/a", "ungrounded", or no parseable signal — has NO conviction; we must NOT show a
// phantom 50/100 gauge or a "pressure building" status for it.
function isUngrounded(c: { confidence: string | null; baselineConfidence: string | null }): boolean {
  const s = (c.confidence || c.baselineConfidence || '').toLowerCase().split('(')[0]!.trim();
  if (!s) return true;
  if (s.startsWith('n/a') || s.includes('ungrounded') || s.includes('unverified') || s.includes('no call')) return true;
  if (/\d/.test(s)) return false;
  return !/\b(high|med|low)/.test(s); // no number and no word-bucket → treat as ungrounded
}
const COLORS = ['#5b8def', '#e0a34a', '#d05a6e', '#4aa3a3', '#9b6dd0', '#6fae5a', '#cc7766', '#7777cc', '#aa9988', '#779988', '#cc99aa', '#88aacc'];
// Parse a call's predictive date (forecast-by). Accepts YYYY-MM-DD / YYYY-MM and "Qn 'YY".
function parseForecastDate(s: string | null): Date | null {
  if (!s) return null;
  const md = s.trim().match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (md) return new Date(Number(md[1]), Number(md[2]) - 1, md[3] ? Number(md[3]) : 1);
  const q = s.trim().match(/Q([1-4])\s*'?(\d{2,4})/i);
  if (q) { const yr = q[2]!.length === 2 ? 2000 + Number(q[2]) : Number(q[2]); return new Date(yr, (Number(q[1]) - 1) * 3 + 1, 1); }
  return null;
}
// Forecast timeline: X = time (months), each dot placed at the call's PREDICTED date
// (forecast-by); Y = conviction out of 100. A "now" marker anchors the present.
const chart = computed(() => {
  const rep = r.value;
  if (!rep || !rep.current?.length) return null;
  const dated = rep.current.map((c, i) => ({ c, i, d: parseForecastDate(c.forecastBy) })).filter((x) => x.d);
  if (!dated.length) return null; // no predictive dates yet → no timeline to draw
  const W = 900, H = 240, padL = 34, padR = 18, padT = 16, padB = 32;
  const sy = (y: number) => padT + (H - padT - padB) * (1 - y / 100);
  const now = new Date();
  const times = dated.map((x) => (x.d as Date).getTime());
  const minT = Math.min(now.getTime(), ...times);
  const maxT = Math.max(...times);
  const lo = new Date(minT), hi = new Date(maxT);
  const start = new Date(lo.getFullYear(), lo.getMonth(), 1);
  const end = new Date(hi.getFullYear(), hi.getMonth() + 1, 1); // first of the month after the last call
  const t0 = start.getTime();
  const span = Math.max(1, end.getTime() - t0);
  const sx = (t: number) => padL + (W - padL - padR) * ((t - t0) / span);
  const months: Array<{ x: number; label: string; year: string }> = [];
  let m = new Date(start);
  while (m.getTime() <= end.getTime()) {
    months.push({ x: sx(m.getTime()), label: m.toLocaleString(undefined, { month: 'short' }), year: m.getMonth() === 0 || months.length === 0 ? `'${String(m.getFullYear()).slice(2)}` : '' });
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  const nowX = now.getTime() >= t0 && now.getTime() <= end.getTime() ? sx(now.getTime()) : null;
  return {
    W, H, padL, padT, padB,
    gy: [0, 25, 50, 75, 100].map((v) => ({ v, y: sy(v) })),
    months, nowX,
    undated: rep.current.length - dated.length,
    dots: dated.map((x, k) => {
      const val = confNum(x.c.confidence || x.c.baselineConfidence);
      return { n: k + 1, layer: x.c.layer, status: x.c.status, color: COLORS[k % COLORS.length]!, x: sx((x.d as Date).getTime()), y: sy(val), val, date: x.c.forecastBy };
    }),
  };
});

// Sort calls by conviction (toggle). The gauge gives per-call legibility; this groups the strongest.
const sortByConviction = ref(false);
const sortedCurrent = computed(() => {
  const rep = r.value;
  if (!rep) return [];
  const arr = [...rep.current];
  if (sortByConviction.value) arr.sort((a, b) => confNum(b.confidence || b.baselineConfidence) - confNum(a.confidence || a.baselineConfidence));
  return arr;
});

// What changed this wake — latest cycle vs the prior one (opened / revised / retired).
const whatChanged = computed(() => {
  const rep = r.value;
  if (!rep || !rep.cycles.length) return null;
  const latest = rep.cycles[0]!;
  const prev = rep.cycles[1];
  if (!prev) return { first: true, opened: latest.calls.length, revised: 0, retired: 0 };
  const latestL = new Set(latest.calls.map((c) => c.layer));
  const prevL = new Set(prev.calls.map((c) => c.layer));
  return {
    first: false,
    opened: latest.calls.filter((c) => !prevL.has(c.layer)).length,
    revised: latest.calls.filter((c) => c.status === 'REVISED').length,
    retired: prev.calls.filter((c) => !latestL.has(c.layer)).length,
  };
});

// Provenance — parse a cited-signal string into dated source chips.
function parseSignal(sig: string | null): Array<{ date: string; host: string }> {
  if (!sig) return [];
  return sig.split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/(\d{4}-\d{2}-\d{2})[/\\](.+)/);
    if (m) return { date: m[1]!, host: m[2]!.replace(/-[a-f0-9]{6,}\.md$/i, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() };
    return { date: '', host: s.replace(/\.md$/i, '') };
  });
}

// Corpus freshness — latest gathered date and # distinct sources across current calls.
const freshness = computed(() => {
  const rep = r.value;
  if (!rep) return null;
  const all = rep.current.flatMap((c) => parseSignal(c.signal));
  if (!all.length) return null;
  const dates = all.map((x) => x.date).filter(Boolean).sort();
  const hosts = new Set(all.map((x) => x.host).filter(Boolean));
  return { last: dates.length ? dates[dates.length - 1]! : null, sources: hosts.size };
});
</script>

<template>
  <section class="fc">
    <header class="fc-head">
      <div>
        <RouterLink :to="`/lattice/${id}`" class="back">◂ {{ id }}</RouterLink>
        <h2>Standing Forecast</h2>
        <p class="sub muted">
          Dated, falsifiable calls grounded in cited signal
          <span v-if="r?.thesis.horizon"> · {{ r.thesis.horizon }}</span>
          <span v-if="r?.currentAsOf"> · as of {{ fmtDate(r.currentAsOf) }}</span>
          <span v-else-if="r && r.counts.cycles === 0"> · baseline (no adjudication cycle yet)</span>
        </p>
      </div>
      <div class="liverow">
        <span class="live" title="Refreshes on its own when a run closes">● live</span>
        <span v-if="updatedClock" class="upd">updated {{ updatedClock }}</span>
        <button class="refresh" @click="() => load()">↻ Refresh</button>
      </div>
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

      <!-- What changed this wake + corpus freshness -->
      <div class="wakebar" v-if="whatChanged || freshness">
        <div v-if="whatChanged" class="wb-group">
          <span class="eyebrow">This wake</span>
          <span v-if="whatChanged.first" class="wb-i">baseline · {{ whatChanged.opened }} calls opened</span>
          <template v-else>
            <span class="wb-i op">+{{ whatChanged.opened }} opened</span>
            <span class="wb-i rev">{{ whatChanged.revised }} revised</span>
            <span class="wb-i ret">−{{ whatChanged.retired }} retired</span>
          </template>
        </div>
        <div v-if="freshness" class="wb-group">
          <span class="eyebrow">Corpus</span>
          <span class="wb-i">gathered {{ freshness.last || '—' }}</span>
          <span class="wb-i">{{ freshness.sources }} distinct source{{ freshness.sources === 1 ? '' : 's' }}</span>
        </div>
      </div>

      <!-- Signal chart: one dot per call (own column, never overlapping), height = position /100 -->
      <div v-if="chart" class="chartbox">
        <div class="chart-k">Forecast timeline — conviction (0–100) by predicted date
          <span class="muted">· each dot sits at the date its call is forecast to resolve<span v-if="chart.undated"> · {{ chart.undated }} undated call{{ chart.undated > 1 ? 's' : '' }} not plotted</span></span>
        </div>
        <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" class="chart">
          <!-- conviction gridlines + axis -->
          <line v-for="g in chart.gy" :key="'g' + g.v" :x1="chart.padL" :x2="chart.W - 12" :y1="g.y" :y2="g.y" class="grid" />
          <text v-for="g in chart.gy" :key="'a' + g.v" :x="2" :y="g.y + 3" class="axis">{{ g.v }}</text>
          <!-- month gridlines + labels (X = time) -->
          <g v-for="(mo, mi) in chart.months" :key="'m' + mi">
            <line :x1="mo.x" :x2="mo.x" :y1="chart.padT" :y2="chart.H - chart.padB" class="vgrid" />
            <text :x="mo.x" :y="chart.H - chart.padB + 14" class="axisx">{{ mo.label }}</text>
            <text v-if="mo.year" :x="mo.x" :y="chart.H - chart.padB + 25" class="axisx yr">{{ mo.year }}</text>
          </g>
          <!-- present-day marker -->
          <g v-if="chart.nowX != null">
            <line :x1="chart.nowX" :x2="chart.nowX" :y1="chart.padT" :y2="chart.H - chart.padB" class="nowline" />
            <text :x="chart.nowX" :y="chart.padT - 4" class="nowtxt">now</text>
          </g>
          <!-- calls, plotted at (predicted date, conviction) -->
          <g v-for="d in chart.dots" :key="d.n">
            <circle :cx="d.x" :cy="d.y" r="8" :fill="d.color" />
            <text :x="d.x" :y="d.y + 3.2" class="dotn">{{ d.n }}</text>
          </g>
        </svg>
        <div class="legend">
          <span v-for="d in chart.dots" :key="'l' + d.n" class="leg" :title="`${d.layer} — forecast ${d.date}`">
            <i :style="{ background: d.color }">{{ d.n }}</i>{{ d.layer.slice(0, 60) }} <b>· {{ d.val }}</b> <span class="leg-d num">{{ d.date }}</span>
          </span>
        </div>
      </div>

      <!-- Current calls -->
      <div class="sec-row">
        <h3 class="sec">Current calls</h3>
        <button class="sortbtn" @click="sortByConviction = !sortByConviction">{{ sortByConviction ? '↓ sorted by conviction' : '↕ sort by conviction' }}</button>
      </div>
      <div class="cards">
        <article v-for="c in sortedCurrent" :key="c.layer" class="card" :class="statusClass(c.status)">
          <div class="cband" :class="isUngrounded(c) ? 'st-pending' : statusClass(c.status)">
            <span class="cband-label"><span class="cband-glyph" aria-hidden="true">{{ isUngrounded(c) ? '○' : statusGlyph(c.status) }}</span>{{ isUngrounded(c) ? 'Awaiting signal' : statusLabel(c.status) }}</span>
            <span v-if="c.forecastBy" class="cband-date num" title="The predictive date — when this call is forecast to resolve">forecast · {{ c.forecastBy }}</span>
          </div>
          <div class="layer">{{ c.layer }}</div>
          <p class="headline">{{ c.claim || c.headline }}</p>
          <p v-if="c.prediction && c.prediction !== c.claim" class="pred">{{ c.prediction }}</p>
          <p v-if="c.basis" class="basis"><span class="basis-k">Basis</span> {{ c.basis }}</p>

          <div v-if="!isUngrounded(c)" class="conv">
            <span class="conv-k eyebrow">Conviction</span>
            <ConvictionGauge :value="confNum(c.confidence || c.baselineConfidence)" :status="statusClass(c.status)" />
          </div>
          <div v-else class="conv">
            <span class="conv-k eyebrow">Conviction</span>
            <span class="ung-tag">no scorable call yet — insufficient signal</span>
          </div>
          <p v-if="confNote(c.confidence) && !isUngrounded(c)" class="conf-note">{{ confNote(c.confidence) }}</p>

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
            <div v-if="parseSignal(c.signal).length" class="prov">
              <span class="prov-k eyebrow">Source</span>
              <span v-for="(sg, si) in parseSignal(c.signal)" :key="si" class="src" :title="c.signal || ''">{{ sg.host }}<span v-if="sg.date" class="src-d num"> · {{ sg.date.slice(5) }}</span></span>
            </div>
            <span v-else-if="c.watching" class="evi mono">📄 {{ c.watching }}</span>
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
.liverow { display: flex; align-items: center; gap: var(--s-3); }
.live { color: var(--green); font-family: var(--font-mono); font-size: var(--t-xs); letter-spacing: 0.04em; white-space: nowrap; }
.upd { color: var(--text-2); font-family: var(--font-mono); font-size: var(--t-xs); white-space: nowrap; }
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
.card { background: var(--bg-1); border: var(--bw) solid var(--line); border-radius: var(--r-2); padding: var(--s-3) var(--s-4); display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; overflow: hidden; overflow-wrap: anywhere; word-break: break-word; }

/* Full-width status band along the top of the card (full-bleed past card padding). */
.cband {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-2);
  margin: calc(-1 * var(--s-3)) calc(-1 * var(--s-4)) var(--s-1);
  padding: 5px var(--s-4);
  border-bottom: var(--bw) solid var(--line);
}
.cband-label {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--font-mono); font-weight: 700; font-size: var(--t-xs);
  letter-spacing: 0.1em; text-transform: uppercase;
}
.cband-glyph { font-size: 9px; line-height: 1; }
.cband-date { font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-1); white-space: nowrap; letter-spacing: 0.02em; }
.cband.st-held { background: color-mix(in srgb, var(--green) 15%, var(--bg-1)); color: var(--green); border-bottom-color: color-mix(in srgb, var(--green) 35%, var(--line)); }
.cband.st-caveat { background: color-mix(in srgb, var(--orange) 15%, var(--bg-1)); color: var(--orange); border-bottom-color: color-mix(in srgb, var(--orange) 35%, var(--line)); }
.cband.st-revised { background: color-mix(in srgb, var(--accent) 15%, var(--bg-1)); color: var(--accent); border-bottom-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.cband.st-pending { background: color-mix(in srgb, var(--text-2) 9%, var(--bg-1)); color: var(--text-2); border-bottom-color: var(--line); }

.layer { font-weight: 700; letter-spacing: 0.02em; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.opened { font-size: var(--t-xs); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.badge { font-size: var(--t-xs); padding: 2px 8px; border-radius: var(--r-1); font-weight: 600; }
.badge.sm { font-size: 10px; }
.badge.st-held { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); }
.badge.st-caveat { background: color-mix(in srgb, var(--orange) 20%, transparent); color: var(--orange); }
.badge.st-revised { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
.headline { margin: 0; font-weight: 600; font-size: var(--t-md); line-height: var(--leading-tight); }
.pred { margin: 0; font-size: var(--t-sm); color: var(--text-1); line-height: var(--leading-normal); }
.basis { margin: 0; font-size: var(--t-xs); color: var(--text-2); line-height: var(--leading-normal); }
.basis-k { font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin-right: 6px; font-size: 10px; }

/* wake / corpus bar */
.wakebar { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-6); align-items: center; margin: var(--s-3) 0; padding: var(--s-2) var(--s-4); background: var(--bg-1); border: var(--bw) solid var(--line); border-radius: var(--r-2); }
.wb-group { display: flex; align-items: center; gap: var(--s-3); }
.wb-i { font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-1); white-space: nowrap; }
.wb-i.op { color: var(--green); }
.wb-i.rev { color: var(--accent); }
.wb-i.ret { color: var(--text-2); }

/* section header row with a control on the right */
.sec-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-3); }
.sortbtn { font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-2); border-color: transparent; padding: var(--s-1) var(--s-2); }
.sortbtn:hover { color: var(--text-0); background: var(--bg-2); border-color: var(--line); }

/* conviction gauge block on the card */
.conv { display: flex; flex-direction: column; gap: 5px; }
.conv-k { font-size: 10px; }
.conf-note { margin: 0; font-size: var(--t-xs); color: var(--text-2); line-height: var(--leading-normal); }
.ung-tag { font-size: var(--t-sm); color: var(--text-2); font-style: italic; }

/* provenance source chips */
.prov { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.prov-k { font-size: 10px; margin-right: 2px; }
.src { display: inline-flex; align-items: center; font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-1); background: var(--bg-2); border: var(--bw) solid var(--line); border-radius: var(--r-1); padding: 1px 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-d { color: var(--text-3); }
.conf-row { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); align-items: baseline; font-size: var(--t-sm); min-width: 0; }
.conf b { color: var(--text-0); }
.trend { color: var(--orange); font-size: var(--t-xs); }
.pos { color: var(--muted); font-size: var(--t-xs); }
.pos b { color: var(--text); }

/* Signal chart — where each call sits over the review cycles (stock-chart style) */
.chartbox { margin: var(--s-4) 0; padding: var(--s-3); border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.02); }
.chart-k { font-size: var(--t-sm); margin-bottom: var(--s-2); }
.chart { width: 100%; height: auto; aspect-ratio: 900 / 240; display: block; }
.chart .grid { stroke: rgba(255,255,255,0.08); stroke-width: 1; }
.chart .vgrid { stroke: rgba(255,255,255,0.05); stroke-width: 1; }
.chart .axis { fill: var(--muted); font-size: 9px; font-family: var(--font-mono); }
.chart .axisx { fill: var(--text-2); font-size: 9px; text-anchor: middle; font-family: var(--font-mono); }
.chart .axisx.yr { fill: var(--text-3); font-size: 8px; }
.chart .nowline { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.7; }
.chart .nowtxt { fill: var(--accent); font-size: 9px; text-anchor: middle; font-family: var(--font-mono); }
.chart .dotn { fill: #fff; font-size: 9px; font-weight: 700; text-anchor: middle; pointer-events: none; }
.leg-d { color: var(--text-3); }
.legend { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-3); margin-top: var(--s-2); font-size: var(--t-xs); color: var(--muted); }
.leg { display: inline-flex; align-items: center; gap: 6px; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leg i { width: 15px; height: 15px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 9px; font-weight: 700; font-style: normal; flex: none; }
.leg b { color: var(--text); }
.watchbox { background: color-mix(in srgb, var(--orange) 8%, var(--bg-2)); border: var(--bw) solid color-mix(in srgb, var(--orange) 30%, var(--line)); border-radius: var(--r-1); padding: var(--s-2) var(--s-3); }
.revbox { background: color-mix(in srgb, var(--accent) 8%, var(--bg-2)); border: var(--bw) solid color-mix(in srgb, var(--accent) 25%, var(--line)); border-radius: var(--r-1); padding: var(--s-2) var(--s-3); }
.watchbox p, .revbox p { margin: 4px 0; font-size: var(--t-sm); line-height: var(--leading-normal); }
.wb-k { font-size: var(--t-xs); font-weight: 700; color: var(--orange); text-transform: uppercase; letter-spacing: 0.04em; }
.wb-l { color: var(--text-2); font-weight: 600; }
.card-foot { margin-top: auto; display: flex; flex-direction: column; gap: 4px; padding-top: var(--s-2); border-top: var(--bw) solid var(--line); min-width: 0; }
.kill { font-size: var(--t-xs); color: var(--text-2); line-height: var(--leading-normal); overflow-wrap: anywhere; }
.kill b { color: var(--text-1); }
.evi { font-size: var(--t-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; min-width: 0; }

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
