<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { TraceRow } from '@runcor/bridge-shared';

import { Api } from '../../api.js';
import type { PlaybackSnapshot } from '../playback.js';

const props = defineProps<{
  latticeId: string;
  snapshot: PlaybackSnapshot;
  /** Tab to focus when a graphic is clicked: 'thoughts' | 'memory' | 'plan'. */
  focus: string | null;
}>();
const emit = defineEmits<{ (e: 'seek', cycle: number): void }>();

type Tab = 'summary' | 'thoughts' | 'memory' | 'job';
const tab = ref<Tab>('summary');

// Claude summary of the overall job + progress, and which jobs are expanded.
const jobSummary = ref<string | null>(null);
const jobSummaryState = ref<'idle' | 'loading' | 'error'>('idle');
const jobExpanded = ref<Set<string>>(new Set());

async function fetchJobSummary() {
  jobSummaryState.value = 'loading';
  try {
    const res = await Api.jobSummary(props.latticeId);
    jobSummary.value = res.summary;
    jobSummaryState.value = 'idle';
  } catch {
    jobSummaryState.value = 'error';
  }
}
function toggleJob(id: string) {
  const s = new Set(jobExpanded.value);
  s.has(id) ? s.delete(id) : s.add(id);
  jobExpanded.value = s;
}

interface Thought {
  cycle: number;
  action: string | null;
  summary: string;
  reasoning: string | null; // raw R++ (cognition) — the model's actual thinking
  prompt: string | null; // the grounded prompt sent that cycle
  why: string | null; // episodic rationale (fallback / supplement)
  hasCognition: boolean;
}

const thoughts = ref<Thought[]>([]); // newest first
const memory = ref<Awaited<ReturnType<typeof Api.memory>> | null>(null);
const expanded = ref<Set<number>>(new Set());
const error = ref<string | null>(null);

// Claude-summarized chain of thought, one short summary per cycle (cached
// server-side too). Generated lazily when the Summary tab is open.
const summaries = ref<Map<number, string>>(new Map());
const generating = ref(false);
const genCycle = ref<number | null>(null); // cycle currently being summarized
const summaryError = ref<string | null>(null);

async function fetchSummary(cycle: number, force = false): Promise<void> {
  if (!force && summaries.value.has(cycle)) return;
  if (!thoughts.value.some((t) => t.cycle === cycle)) return;
  genCycle.value = cycle;
  try {
    const res = await Api.cycleSummary(props.latticeId, cycle);
    if (res.summary) {
      const m = new Map(summaries.value);
      m.set(cycle, res.summary);
      summaries.value = m;
    }
    summaryError.value = null;
  } catch (e) {
    summaryError.value = e instanceof Error ? e.message : String(e);
  } finally {
    genCycle.value = null;
  }
}

/** Generate short Claude summaries for every cycle that lacks one, oldest→newest. */
async function generateSummaries(): Promise<void> {
  if (generating.value) return;
  summaryError.value = null; // clear any sticky error from an earlier attempt
  generating.value = true;
  try {
    const cycles = [...thoughts.value].map((t) => t.cycle).sort((a, b) => a - b);
    for (const c of cycles) {
      if (!generating.value) break; // stopped
      if (summaries.value.has(c)) continue;
      await fetchSummary(c); // sequential — one claude pass at a time
      if (summaryError.value) break; // back off on error (e.g. usage limit)
    }
  } finally {
    generating.value = false;
  }
}
function stopGenerating() {
  generating.value = false;
}
const summarizedCount = computed(
  () => thoughts.value.filter((t) => summaries.value.has(t.cycle)).length,
);

/** Pull the BEHAVIOR Decide { … } block out of raw R++ — that's the thought. */
function decideBlock(rpp: string): string {
  const m = /BEHAVIOR\s+\w+\s*\{([\s\S]*?)\}\s*$/.exec(rpp) || /BEHAVIOR\s+\w+\s*\{([\s\S]*?)\}/.exec(rpp);
  return (m?.[1] ?? rpp).trim();
}
function firstLine(s: string, n = 160): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n) + '…' : line;
}

function buildThoughts(cogRows: TraceRow[], episodic: { cycle: number; body: string; why: string }[]) {
  const byCycle = new Map<number, Thought>();
  // Episodic first (fallback for runs predating cognition emission).
  for (const e of episodic) {
    const action = /chosen_action=([^;]+)/.exec(e.body)?.[1]?.trim() ?? null;
    byCycle.set(e.cycle, {
      cycle: e.cycle,
      action,
      summary: firstLine(e.why || e.body),
      reasoning: null,
      prompt: null,
      why: e.why || null,
      hasCognition: false,
    });
  }
  // Cognition overlays with the real prompt + reasoning.
  for (const r of cogRows) {
    const reasoning = typeof r.reasoning === 'string' ? r.reasoning : '';
    const prompt = typeof r.prompt === 'string' ? r.prompt : '';
    const action = typeof r.action === 'string' ? r.action : (r.action == null ? null : String(r.action));
    const prev = byCycle.get(r.cycle);
    byCycle.set(r.cycle, {
      cycle: r.cycle,
      action: action ?? prev?.action ?? null,
      summary: firstLine(decideBlock(reasoning) || prev?.why || ''),
      reasoning,
      prompt,
      why: prev?.why ?? null,
      hasCognition: true,
    });
  }
  thoughts.value = [...byCycle.values()].sort((a, b) => b.cycle - a.cycle);
}

async function refresh() {
  try {
    const [cog, mem] = await Promise.all([
      Api.trace(props.latticeId, { kind: 'cognition', limit: 500 }) as Promise<TraceRow[]>,
      Api.memory(props.latticeId, 40),
    ]);
    buildThoughts(cog, mem.episodic);
    memory.value = mem;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const current = computed(() => thoughts.value.find((t) => t.cycle === props.snapshot.cycle) ?? null);

// The lattice's own chain of thought for the current cycle — its actual
// reasoning prose (the BEHAVIOR Decide block), not a retrospective summary.
const currentCot = computed<string | null>(() => {
  const c = current.value;
  if (!c) return null;
  if (c.reasoning) return decideBlock(c.reasoning);
  return c.why ?? null;
});

function toggle(cycle: number) {
  const s = new Set(expanded.value);
  s.has(cycle) ? s.delete(cycle) : s.add(cycle);
  expanded.value = s;
}

let poll: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  await refresh();
  if (tab.value === 'summary') void generateSummaries();
  poll = setInterval(async () => {
    if (props.snapshot.followLive) {
      await refresh();
      // Pick up summaries for newly-arrived cycles while watching live.
      if (tab.value === 'summary' && !generating.value) void generateSummaries();
    }
  }, 4000);
});
onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
  generating.value = false;
});

// Switching tabs kicks off the relevant Claude pass.
watch(tab, (t) => {
  if (t === 'summary' && !generating.value) void generateSummaries();
  if (t === 'job' && jobSummary.value === null && jobSummaryState.value !== 'loading') {
    void fetchJobSummary();
  }
});

// A graphic was clicked → switch tab. ('plan'/'job' both open the Job tab.)
watch(
  () => props.focus,
  (f) => {
    if (f === 'plan') tab.value = 'job';
    else if (f === 'summary' || f === 'memory' || f === 'job' || f === 'thoughts') tab.value = f;
  },
);
</script>

<template>
  <aside class="thoughts panel">
    <div class="tp-tabs">
      <button :class="{ on: tab === 'summary' }" @click="tab = 'summary'">Summary</button>
      <button :class="{ on: tab === 'thoughts' }" @click="tab = 'thoughts'">Thoughts</button>
      <button :class="{ on: tab === 'memory' }" @click="tab = 'memory'">Memory</button>
      <button :class="{ on: tab === 'job' }" @click="tab = 'job'">Job</button>
      <span class="spacer"></span>
      <button class="refresh" title="Refresh" @click="refresh">⟳</button>
    </div>

    <div v-if="error" class="tp-error mono faint">{{ error }}</div>

    <!-- SUMMARY — a short Claude-written digest per cycle -->
    <div v-show="tab === 'summary'" class="tp-body">
      <!-- current cycle, featured (never collapsed) -->
      <div v-if="current" class="sum-now">
        <div class="sum-h">
          <span class="cy-c">c{{ current.cycle }}</span>
          <span class="cy-act">{{ current.action ?? '—' }}</span>
          <span class="chip ai">live</span>
        </div>
        <div v-if="summaries.get(current.cycle)" class="sum-now-text">{{ summaries.get(current.cycle) }}</div>
        <div v-else-if="genCycle === current.cycle" class="sum-now-text faint">summarizing…</div>
        <button v-else class="mini" @click="fetchSummary(current.cycle, true)">summarize this cycle ›</button>

        <!-- the lattice's actual chain of thought (its reasoning), not a digest -->
        <div v-if="currentCot" class="cot">
          <div class="cot-label faint">⛓ chain of thought</div>
          <div class="cot-text">{{ currentCot }}</div>
        </div>

        <!-- the complete raw output, collapsed below the summary -->
        <details v-if="current.reasoning" class="block">
          <summary>full output (raw reasoning)</summary>
          <pre class="mono">{{ current.reasoning }}</pre>
        </details>
        <details v-if="current.prompt" class="block">
          <summary>prompt sent to the model</summary>
          <pre class="mono prompt">{{ current.prompt }}</pre>
        </details>
      </div>

      <div class="sum-bar">
        <span class="faint">{{ summarizedCount }}/{{ thoughts.length }} summarized</span>
        <span class="spacer"></span>
        <button v-if="generating" class="mini" @click="stopGenerating">■ stop</button>
        <button v-else class="mini" @click="generateSummaries">↻ summarize all</button>
      </div>
      <div v-if="summaryError" class="tp-error mono faint">summarize failed: {{ summaryError }}</div>

      <!-- earlier cycles, compact one-liners -->
      <ul class="sum-list">
        <li
          v-for="t in thoughts.filter((x) => x.cycle !== snapshot.cycle)"
          :key="t.cycle"
          class="sum"
          @click="emit('seek', t.cycle)"
        >
          <div class="sum-h">
            <span class="cy-c">c{{ t.cycle }}</span>
            <span class="cy-act">{{ t.action ?? '—' }}</span>
          </div>
          <div v-if="summaries.get(t.cycle)" class="sum-text">{{ summaries.get(t.cycle) }}</div>
          <div v-else-if="genCycle === t.cycle" class="sum-text faint">summarizing…</div>
          <button v-else class="mini sum-gen" @click.stop="fetchSummary(t.cycle, true)">summarize ›</button>
        </li>
        <li v-if="!thoughts.length" class="faint tp-empty">No cycles yet.</li>
      </ul>
    </div>

    <!-- THOUGHTS -->
    <div v-show="tab === 'thoughts'" class="tp-body">
      <!-- current cycle, prominent -->
      <div v-if="current" class="now">
        <div class="now-head">
          <span class="c">c{{ current.cycle }}</span>
          <span class="act">{{ current.action ?? '—' }}</span>
          <span v-if="!current.hasCognition" class="chip faint" title="This cycle predates prompt/reasoning capture">decision + memory only</span>
        </div>
        <p class="now-summary">{{ current.summary || '(no recorded reasoning)' }}</p>
        <details v-if="current.reasoning" class="block">
          <summary>full reasoning (raw R++)</summary>
          <pre class="mono">{{ current.reasoning }}</pre>
        </details>
        <details v-if="current.prompt" class="block">
          <summary>prompt sent to the model</summary>
          <pre class="mono prompt">{{ current.prompt }}</pre>
        </details>
        <details v-if="current.why" class="block">
          <summary>why (episodic memory)</summary>
          <pre class="mono">{{ current.why }}</pre>
        </details>
      </div>
      <div v-else class="tp-empty faint">No recorded thought for cycle {{ snapshot.cycle }} yet.</div>

      <!-- all cycles, collapsible (Claude/Copilot style) -->
      <div class="all-head faint">ALL CYCLES ({{ thoughts.length }})</div>
      <ul class="cycle-list">
        <li
          v-for="t in thoughts"
          :key="t.cycle"
          class="cy"
          :class="{ active: t.cycle === snapshot.cycle }"
        >
          <div class="cy-head" @click="emit('seek', t.cycle)">
            <span class="cy-c">c{{ t.cycle }}</span>
            <span class="cy-act">{{ t.action ?? '—' }}</span>
            <span class="cy-sum">{{ t.summary }}</span>
            <button class="cy-x" @click.stop="toggle(t.cycle)">{{ expanded.has(t.cycle) ? '−' : '+' }}</button>
          </div>
          <div v-if="expanded.has(t.cycle)" class="cy-detail">
            <pre v-if="t.reasoning" class="mono">{{ t.reasoning }}</pre>
            <pre v-else-if="t.why" class="mono">{{ t.why }}</pre>
            <details v-if="t.prompt" class="block">
              <summary>prompt</summary>
              <pre class="mono prompt">{{ t.prompt }}</pre>
            </details>
          </div>
        </li>
      </ul>
    </div>

    <!-- MEMORY -->
    <div v-show="tab === 'memory'" class="tp-body">
      <div v-if="memory?.situation" class="mem-situation">
        <div class="all-head faint">SITUATION (c{{ memory.situation_cycle }})</div>
        <pre class="mono">{{ memory.situation }}</pre>
      </div>
      <div class="all-head faint">EPISODIC</div>
      <div v-for="(m, i) in memory?.episodic ?? []" :key="'e' + i" class="mem">
        <div class="mem-h"><span class="cy-c">c{{ m.cycle }}</span><span class="mem-why">{{ m.why }}</span></div>
        <pre class="mono faint">{{ m.body }}</pre>
      </div>
      <div class="all-head faint">SEMANTIC</div>
      <div v-for="(m, i) in memory?.semantic ?? []" :key="'s' + i" class="mem">
        <div class="mem-h"><span class="cy-c">c{{ m.cycle }}</span><span class="mem-why">{{ m.why }}</span></div>
        <pre class="mono faint">{{ m.body }}</pre>
      </div>
      <div class="all-head faint">IDENTITY</div>
      <div v-for="(m, i) in memory?.identity ?? []" :key="'i' + i" class="mem">
        <pre class="mono">{{ m.body }}</pre>
      </div>
    </div>

    <!-- JOB — Claude summary of the job + the complete job, expandable -->
    <div v-show="tab === 'job'" class="tp-body">
      <div class="sum-now">
        <div class="sum-h">
          <span class="chip ai">job summary</span>
          <span class="spacer"></span>
          <button class="mini" @click="fetchJobSummary">↻</button>
        </div>
        <div v-if="jobSummary" class="sum-now-text">{{ jobSummary }}</div>
        <div v-else-if="jobSummaryState === 'loading'" class="sum-now-text faint">summarizing the job…</div>
        <div v-else-if="jobSummaryState === 'error'" class="sum-now-text faint">summary unavailable</div>
        <div v-else class="sum-now-text faint">no job summary yet</div>
      </div>

      <div class="all-head faint">COMPLETE JOB</div>
      <div v-for="j in memory?.jobs ?? []" :key="j.id" class="jobc">
        <div class="job-h" @click="toggleJob(j.id)">
          <span class="job-x">{{ jobExpanded.has(j.id) ? '−' : '+' }}</span>
          <span class="job-title">{{ j.title }}</span>
          <span class="chip" :class="{ accent: j.status === 'open' }">{{ j.status }}</span>
        </div>
        <div v-if="jobExpanded.has(j.id)" class="job-detail">
          <div v-if="j.why" class="job-why"><span class="r-lbl">why</span> {{ j.why }}</div>
          <pre v-if="j.body" class="mono job-body">{{ j.body }}</pre>
          <div class="all-head faint">ITEMS ({{ j.items.length }})</div>
          <div v-for="(it, i) in j.items" :key="i" class="plan-item" :class="it.state">
            <span class="pi-state">{{ it.state === 'passed' ? '▣' : it.state === 'deferred' ? '◇' : '◻' }}</span>
            <span class="pi-desc">{{ it.description }}</span>
          </div>
        </div>
      </div>
      <div v-if="!(memory?.jobs ?? []).length" class="faint tp-empty">No job handed to this lattice.</div>

      <div class="all-head faint">GOALS</div>
      <div v-for="(g, i) in memory?.goals ?? []" :key="'g' + i" class="goal">
        <span class="chip">{{ g.state }}</span> {{ g.body }}
        <div class="faint why">{{ g.why }}</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.thoughts {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.tp-tabs {
  display: flex;
  gap: var(--s-1);
  padding: var(--s-2);
  border-bottom: var(--bw) solid var(--line);
  flex: 0 0 auto;
}
.tp-tabs button {
  padding: var(--s-1) var(--s-2);
  font-size: var(--t-xs);
}
.tp-tabs button.on {
  border-color: var(--accent);
  color: var(--accent);
}
.tp-tabs .spacer {
  flex: 1;
}
.tp-body {
  overflow-y: auto;
  padding: var(--s-3);
  min-height: 0;
}
.tp-error {
  padding: var(--s-2) var(--s-3);
  color: var(--red);
}
.mini {
  padding: 1px 8px;
  font-size: var(--t-xs);
}
.sum-now {
  border: var(--bw) solid var(--accent);
  border-radius: var(--r-2);
  padding: var(--s-3);
  background: var(--bg-2);
  margin-bottom: var(--s-3);
}
.sum-now-text {
  margin-top: var(--s-2);
  font-size: var(--t-sm);
  line-height: 1.55;
  color: var(--text-0);
}
.cot {
  margin-top: var(--s-3);
  border-top: var(--bw) dashed var(--line);
  padding-top: var(--s-2);
}
.cot-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: var(--s-1);
}
.cot-text {
  font-size: var(--t-sm);
  line-height: 1.5;
  color: var(--text-2);
  font-style: italic;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow-y: auto;
}
.chip.ai {
  border-color: var(--accent);
  color: var(--accent);
}
.sum-bar {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
  font-size: var(--t-xs);
}
.sum-bar .spacer {
  flex: 1;
}
.sum-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sum {
  border: var(--bw) solid var(--line);
  border-radius: var(--r-2);
  padding: var(--s-2);
  margin-bottom: var(--s-2);
  cursor: pointer;
}
.sum:hover {
  border-color: var(--line-strong);
}
.sum.active {
  border-color: var(--accent);
  background: var(--bg-2);
}
.sum-h {
  display: flex;
  gap: var(--s-2);
  align-items: baseline;
  margin-bottom: var(--s-1);
}
.sum-text {
  font-size: var(--t-sm);
  line-height: 1.5;
  color: var(--text-1);
}
.sum-gen {
  margin-top: 2px;
}
.now {
  border: var(--bw) solid var(--line-strong);
  border-radius: var(--r-2);
  padding: var(--s-3);
  background: var(--bg-2);
  margin-bottom: var(--s-3);
}
.now-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.now-head .c {
  color: var(--accent);
  font-family: var(--font-mono);
  font-weight: 600;
}
.now-head .act {
  font-family: var(--font-mono);
  color: var(--text-0);
}
.now-summary {
  margin: var(--s-2) 0;
  color: var(--text-1);
  font-size: var(--t-sm);
  line-height: 1.5;
}
.block {
  margin-top: var(--s-1);
}
.block summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: var(--t-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.block pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-0);
  border: var(--bw) solid var(--line);
  border-radius: var(--r-1);
  padding: var(--s-2);
  margin: var(--s-1) 0 0;
  font-size: var(--t-xs);
  max-height: 320px;
  overflow: auto;
}
.prompt {
  color: var(--text-2);
}
.all-head {
  font-size: 10px;
  letter-spacing: 0.08em;
  margin: var(--s-3) 0 var(--s-1);
}
.cycle-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cy {
  border-bottom: var(--bw) solid var(--line);
}
.cy.active {
  background: var(--bg-2);
}
.cy-head {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-1);
  cursor: pointer;
}
.cy-head:hover {
  background: var(--bg-3);
}
.cy-c {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--t-xs);
  flex: 0 0 auto;
}
.cy-act {
  font-family: var(--font-mono);
  font-size: var(--t-xs);
  color: var(--text-1);
  flex: 0 0 auto;
}
.cy-sum {
  font-size: var(--t-xs);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}
.cy-x {
  border: none;
  padding: 0 var(--s-2);
  color: var(--text-2);
  flex: 0 0 auto;
}
.cy-detail pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-0);
  border-radius: var(--r-1);
  padding: var(--s-2);
  margin: 0 var(--s-1) var(--s-2);
  font-size: var(--t-xs);
  max-height: 280px;
  overflow: auto;
}
.mem {
  margin-bottom: var(--s-2);
  border-bottom: var(--bw) solid var(--line);
  padding-bottom: var(--s-2);
}
.mem-h {
  display: flex;
  gap: var(--s-2);
  align-items: baseline;
}
.mem-why {
  font-size: var(--t-xs);
  color: var(--text-1);
}
.mem pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: var(--s-1) 0 0;
  font-size: var(--t-xs);
  max-height: 140px;
  overflow: auto;
}
.mem-situation pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--t-xs);
  background: var(--bg-2);
  border: var(--bw) solid var(--line);
  border-radius: var(--r-1);
  padding: var(--s-2);
}
.jobc {
  border: var(--bw) solid var(--line);
  border-radius: var(--r-2);
  margin-bottom: var(--s-2);
}
.job-h {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2);
  cursor: pointer;
}
.job-h:hover {
  background: var(--bg-3);
}
.job-x {
  color: var(--text-2);
}
.job-title {
  flex: 1;
  font-weight: 600;
  font-size: var(--t-sm);
}
.job-detail {
  padding: 0 var(--s-2) var(--s-2);
}
.job-why {
  font-size: var(--t-sm);
  color: var(--text-1);
  margin: var(--s-1) 0;
}
.job-body {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-0);
  border-radius: var(--r-1);
  padding: var(--s-2);
  font-size: var(--t-xs);
  max-height: 240px;
  overflow: auto;
}
.plan-item {
  display: flex;
  gap: var(--s-2);
  padding: var(--s-1) 0;
  font-size: var(--t-sm);
}
.plan-item.passed .pi-desc {
  color: var(--text-2);
  text-decoration: line-through;
}
.pi-state {
  color: var(--accent);
}
.goal {
  margin-bottom: var(--s-2);
  font-size: var(--t-sm);
}
.goal .why {
  font-size: var(--t-xs);
  margin-top: 2px;
}
.tp-empty {
  padding: var(--s-3);
  text-align: center;
}
</style>
