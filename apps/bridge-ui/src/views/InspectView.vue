<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { Api } from '../api.js';
import { useLatticesStore } from '../stores/lattices.js';
import { useTraceStore, type UiTraceEntry } from '../stores/trace.js';

const props = defineProps<{ id: string }>();

const router = useRouter();
const lattices = useLatticesStore();
const trace = useTraceStore();

const dialAutonomy = ref<'low' | 'medium' | 'high'>('medium');
const dialWhy = ref('');
const dialSaving = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await lattices.refresh();
  await lattices.select(props.id);
  await trace.loadInitial(props.id);
  trace.startStream(props.id);
  pollTimer = setInterval(async () => {
    await lattices.refresh();
    await lattices.select(props.id);
  }, 3_000);
  if (lattices.selected) dialAutonomy.value = lattices.selected.autonomy;
});
onBeforeUnmount(() => {
  trace.stopStream();
  if (pollTimer) clearInterval(pollTimer);
});

watch(
  () => lattices.selected?.autonomy,
  (v) => {
    if (v) dialAutonomy.value = v;
  },
);

const filtered = computed(() => trace.filtered);

const reverseFiltered = computed<UiTraceEntry[]>(() => [...filtered.value].reverse());

async function saveDials() {
  if (!dialWhy.value.trim()) return;
  dialSaving.value = true;
  try {
    await Api.patchDials(props.id, { autonomy: dialAutonomy.value }, dialWhy.value);
    dialWhy.value = '';
    await lattices.select(props.id);
  } finally {
    dialSaving.value = false;
  }
}

async function pause() {
  await Api.action(props.id, 'pause');
  await lattices.refresh();
  await lattices.select(props.id);
}
async function resume() {
  await Api.action(props.id, 'resume');
  await lattices.refresh();
  await lattices.select(props.id);
}
async function stop() {
  if (!confirm('Stop this lattice? Its state is preserved on disk and can be resumed by re-instantiating against the same SQLite file.')) {
    return;
  }
  await Api.action(props.id, 'stop');
  router.push('/');
}

// Hand a job to the running lattice (POST /jobs). The lattice's decide phase picks
// it up next cycle. Title/why/instruction are the operator contract; items/gates are
// optional and left to job-poster scripts for now.
const jobTitle = ref('');
const jobWhy = ref('');
const jobBody = ref('');
const jobPosting = ref(false);
const jobMsg = ref<string | null>(null);
async function postJob() {
  if (!jobTitle.value.trim() || !jobBody.value.trim() || !jobWhy.value.trim()) {
    jobMsg.value = 'Title, why, and instruction are all required.';
    return;
  }
  jobPosting.value = true;
  jobMsg.value = null;
  try {
    const res = await Api.handJob(props.id, {
      title: jobTitle.value.trim(),
      why: jobWhy.value.trim(),
      body: jobBody.value.trim(),
    });
    jobMsg.value = `Handed — job ${res.job_id.slice(0, 8)}. The lattice picks it up next cycle.`;
    jobTitle.value = '';
    jobWhy.value = '';
    jobBody.value = '';
    await lattices.refresh();
    await lattices.select(props.id);
  } catch (e) {
    jobMsg.value = 'Failed to hand job: ' + (e instanceof Error ? e.message : String(e));
  } finally {
    jobPosting.value = false;
  }
}

// Per-row expand: reveal the full trace entry (the entity's full output) below its summary.
const openRows = ref<Set<string>>(new Set());
function toggleRow(idv: string) {
  const s = new Set(openRows.value);
  if (s.has(idv)) s.delete(idv); else s.add(idv);
  openRows.value = s;
}
function fullEntry(entry: UiTraceEntry): string {
  // The full payload behind the one-line summary — pretty-printed, internal keys dropped.
  const drop = new Set(['_id', 'kind', 'cycle']);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) if (!drop.has(k) && v != null && v !== '') obj[k] = v;
  return Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

function summarize(entry: UiTraceEntry): string {
  if (entry.kind === 'phase') {
    return `${entry.phase}${entry.output_summary ? ` — ${entry.output_summary as string}` : ''}`;
  }
  if (entry.kind === 'substrate') {
    return `[${entry.outcome as string}] ${entry.law ?? ''} ${entry.reason ?? ''}`.trim();
  }
  if (entry.kind === 'subconscious') {
    return `${entry.rule as string} ${entry.now ? `→ ${entry.now as string}` : ''}`.trim();
  }
  if (entry.kind === 'job') {
    return `${entry.event as string} ${(entry.detail as string) ?? ''}`.trim();
  }
  if (entry.kind === 'operator') {
    return `${entry.action as string} — ${(entry.detail as string) ?? ''}`.trim();
  }
  return JSON.stringify(entry);
}
</script>

<template>
  <section v-if="lattices.selected" class="inspect">
    <header class="inspect-header">
      <div>
        <h2>
          <span class="dot" :class="lattices.selected.status"></span>
          {{ lattices.selected.name }}
        </h2>
        <div class="meta muted mono">
          {{ lattices.selected.lattice_id }} · cycle
          <strong class="cycle">{{ lattices.selected.cycle }}</strong>
          · {{ lattices.selected.model_backend }} · {{ lattices.selected.autonomy }} autonomy
        </div>
      </div>
      <div class="inspect-actions">
        <RouterLink :to="`/lattice/${id}/forecast`" class="viz-link">Forecast ▸</RouterLink>
        <RouterLink :to="`/lattice/${id}/visualize`" class="viz-link">Visualize ▸</RouterLink>
        <button v-if="lattices.selected.status === 'running'" @click="pause">Pause</button>
        <button v-else-if="lattices.selected.status === 'paused'" class="primary" @click="resume">
          Resume
        </button>
        <button class="danger" @click="stop">Stop</button>
      </div>
    </header>

    <div class="grid">
      <div class="col-left">
        <div class="panel">
          <div class="panel-header"><h3>Live trace</h3>
            <div class="trace-filters">
              <select v-model="trace.kindFilter">
                <option :value="null">all kinds</option>
                <option value="phase">phase</option>
                <option value="substrate">substrate</option>
                <option value="subconscious">subconscious</option>
                <option value="job">job</option>
                <option value="operator">operator</option>
              </select>
              <select v-model="trace.phaseFilter" :disabled="trace.kindFilter !== null && trace.kindFilter !== 'phase'">
                <option :value="null">all phases</option>
                <option value="observe">observe</option>
                <option value="ground">ground</option>
                <option value="recall">recall</option>
                <option value="decide">decide</option>
                <option value="act">act</option>
                <option value="judge">judge</option>
                <option value="write">write</option>
                <option value="pulse">pulse</option>
              </select>
              <span class="chip" :class="{ accent: trace.streaming }">
                <span class="dot" :class="trace.streaming ? 'running' : 'stopped'"></span>
                {{ trace.streaming ? 'live' : 'paused' }}
              </span>
            </div>
          </div>
          <div class="trace-list">
            <div
              v-for="entry in reverseFiltered"
              :key="entry._id"
              class="trace-item"
              :class="`trace-kind-${entry.kind}`"
            >
              <button class="trace-row" @click="toggleRow(entry._id)" :aria-expanded="openRows.has(entry._id)" title="show full output">
                <span class="trace-cycle mono faint">c{{ entry.cycle }}</span>
                <span class="trace-kind mono">{{ entry.kind }}</span>
                <span class="trace-body mono">{{ summarize(entry) }}</span>
                <span class="trace-chev" aria-hidden="true">{{ openRows.has(entry._id) ? '▾' : '▸' }}</span>
              </button>
              <pre v-if="openRows.has(entry._id)" class="trace-full mono">{{ fullEntry(entry) }}</pre>
            </div>
            <div v-if="reverseFiltered.length === 0" class="trace-empty muted">
              No entries yet. The trace updates as the lattice cycles.
            </div>
          </div>
        </div>
      </div>

      <div class="col-right">
        <div class="panel">
          <div class="panel-header"><h3>Memory</h3></div>
          <div class="panel-body memory">
            <div v-if="lattices.inspect" class="memory-grid">
              <div class="kv">
                <div class="k">identity</div>
                <div class="v">{{ lattices.inspect.memory_summary.identity_count }}</div>
              </div>
              <div class="kv">
                <div class="k">episodic</div>
                <div class="v">{{ lattices.inspect.memory_summary.episodic_count }}</div>
              </div>
              <div class="kv">
                <div class="k">semantic</div>
                <div class="v">{{ lattices.inspect.memory_summary.semantic_count }}</div>
              </div>
              <div class="kv">
                <div class="k">open jobs</div>
                <div class="v">{{ lattices.inspect.memory_summary.plan_jobs_open }}</div>
              </div>
              <div class="kv">
                <div class="k">closed jobs</div>
                <div class="v">{{ lattices.inspect.memory_summary.plan_jobs_closed }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3>Dials</h3></div>
          <div class="panel-body">
            <div class="field">
              <label for="autonomy-dial">Autonomy</label>
              <select id="autonomy-dial" v-model="dialAutonomy">
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <div class="field">
              <label for="why">Why</label>
              <input
                id="why"
                v-model="dialWhy"
                placeholder="state your reason (required by FR-015)"
              />
            </div>
            <button class="primary" :disabled="dialSaving || !dialWhy.trim()" @click="saveDials">
              {{ dialSaving ? 'Saving…' : 'Apply' }}
            </button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3>Hand a job</h3></div>
          <div class="panel-body">
            <div class="field"><label for="jt">Title</label><input id="jt" v-model="jobTitle" placeholder="e.g. Re-ground your baseline" /></div>
            <div class="field"><label for="jw">Why</label><input id="jw" v-model="jobWhy" placeholder="the reason you're handing this" /></div>
            <div class="field"><label for="jb">Instruction</label><textarea id="jb" v-model="jobBody" rows="5" placeholder="what you want the lattice to do — it becomes the job body the entity reasons from"></textarea></div>
            <button class="primary" :disabled="jobPosting || !jobTitle.trim() || !jobBody.trim() || !jobWhy.trim()" @click="postJob">{{ jobPosting ? 'Handing…' : 'Hand job' }}</button>
            <p v-if="jobMsg" class="job-msg muted">{{ jobMsg }}</p>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3>Identity</h3></div>
          <div class="panel-body">
            <pre class="identity mono">{{ lattices.inspect?.identity.composed_body ?? '(not yet composed)' }}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>
  <section v-else class="loading muted">Loading lattice {{ id }}…</section>
</template>

<style scoped>
.inspect-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: var(--s-4);
}
.inspect-header h2 {
  margin: 0;
  font-size: var(--t-xl);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.meta {
  margin-top: var(--s-1);
  font-size: var(--t-sm);
}
.cycle {
  color: var(--accent);
  font-weight: 600;
}
.inspect-actions {
  display: flex;
  gap: var(--s-2);
  align-items: center;
}
.viz-link {
  border: var(--bw) solid var(--accent);
  color: var(--accent);
  border-radius: var(--r-2);
  padding: var(--s-2) var(--s-3);
  font-size: var(--t-sm);
}
.viz-link:hover {
  background: var(--bg-3);
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: var(--s-4);
}
.col-left,
.col-right {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  min-width: 0;
}
.col-right .panel + .panel { margin-top: 0; }
.col-left .panel + .panel { margin-top: 0; }
.trace-list {
  max-height: 65vh;
  overflow-y: auto;
  padding: var(--s-1) var(--s-4);
}
.trace-item { border-bottom: var(--bw) solid var(--line); }
.trace-item:last-child { border-bottom: none; }
.trace-row {
  display: grid;
  grid-template-columns: 44px 92px 1fr auto;
  gap: var(--s-3);
  width: 100%;
  padding: var(--s-1) 0;
  border: none; border-radius: 0; background: transparent;
  font-size: var(--t-sm);
  align-items: baseline;
  text-align: left;
}
.trace-row:hover { background: var(--bg-2); }
.trace-chev { color: var(--text-3); font-size: 10px; }
.trace-full {
  margin: var(--s-1) 0 var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--bg-0);
  border: var(--bw) solid var(--line);
  border-radius: var(--r-1);
  font-size: var(--t-xs);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 40vh;
  overflow-y: auto;
}
.job-msg { margin-top: var(--s-2); font-size: var(--t-xs); line-height: var(--leading-normal); }
.trace-cycle {
  text-align: right;
}
.trace-kind {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--t-xs);
}
.trace-body {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-filters {
  display: flex;
  gap: var(--s-2);
  align-items: center;
}
.trace-filters select {
  width: auto;
  background: var(--bg-2);
}
.trace-empty {
  padding: var(--s-5);
  text-align: center;
}
.memory-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-3);
}
.kv {
  display: flex;
  justify-content: space-between;
  padding: var(--s-2);
  border-bottom: var(--bw) solid var(--line);
}
.kv:last-child { border-bottom: none; }
.kv .k {
  color: var(--text-2);
  font-size: var(--t-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.kv .v {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--accent);
}
.field { margin-bottom: var(--s-3); }
.identity {
  white-space: pre-wrap;
  font-size: var(--t-sm);
  max-height: 30vh;
  overflow-y: auto;
  margin: 0;
}
.loading {
  text-align: center;
  padding: var(--s-7);
}
</style>
