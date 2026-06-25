<script setup lang="ts">
/* Persistent per-lattice context bar.
 *
 * Fixes the long-standing navigation gap: once inside a lattice you could only
 * move between its Inspect / Visualize / Forecast views by going back to the
 * Roster. This bar gives two one-click moves that always preserve your place:
 *   - LATTICE SWITCHER: jump to another lattice while STAYING on the same view
 *     (e.g. AI-market Forecast -> governance Forecast).
 *   - VIEW TABS: switch view while STAYING on the same lattice.
 * You can always read which lattice + which view you are in.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Api } from '../api.js';
import type { RosterRow } from '@runcor/bridge-shared';

const props = defineProps<{ id: string; view: 'inspect' | 'visualize' | 'forecast' }>();
const router = useRouter();

const lattices = ref<RosterRow[]>([]);
const open = ref(false);
let poll: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try { lattices.value = await Api.roster(); } catch { /* keep last good */ }
}
onMounted(() => { void refresh(); poll = setInterval(refresh, 5000); });
onUnmounted(() => { if (poll) clearInterval(poll); });

const current = computed(() => lattices.value.find((l) => l.lattice_id === props.id) ?? null);
const others = computed(() => lattices.value.filter((l) => l.lattice_id !== props.id));

function pathFor(id: string, view: 'inspect' | 'visualize' | 'forecast') {
  return view === 'inspect' ? `/lattice/${id}` : `/lattice/${id}/${view}`;
}
function switchTo(id: string) {
  open.value = false;
  if (id !== props.id) void router.push(pathFor(id, props.view)); // preserve the current view
}
function statusClass(s: string | undefined) {
  return s ? s.replace(/[^a-z_]/gi, '') : 'stopped';
}
function statusLabel(s: string | undefined) {
  if (!s) return 'unknown';
  return s === 'paused_no_jobs' ? 'resting' : s;
}

const TABS: Array<{ key: 'inspect' | 'visualize' | 'forecast'; label: string }> = [
  { key: 'inspect', label: 'Inspect' },
  { key: 'visualize', label: 'Visualize' },
  { key: 'forecast', label: 'Forecast' },
];
</script>

<template>
  <div class="ctxbar">
    <!-- Lattice switcher -->
    <div class="switch" :class="{ open }">
      <button class="sw-btn" @click="open = !open" :aria-expanded="open" aria-haspopup="listbox">
        <span class="dot" :class="statusClass(current?.status)" aria-hidden="true"></span>
        <span class="sw-name">{{ current?.name || id }}</span>
        <span class="sw-meta num" v-if="current">c{{ current.cycle }} · {{ statusLabel(current.status) }}</span>
        <span class="sw-caret" aria-hidden="true">{{ open ? '▴' : '▾' }}</span>
      </button>
      <ul v-if="open" class="sw-menu" role="listbox">
        <li v-for="l in lattices" :key="l.lattice_id" role="option" :aria-selected="l.lattice_id === id">
          <button class="sw-opt" :class="{ active: l.lattice_id === id }" @click="switchTo(l.lattice_id)">
            <span class="dot" :class="statusClass(l.status)" aria-hidden="true"></span>
            <span class="sw-opt-name">{{ l.name }}</span>
            <span class="sw-opt-meta num">c{{ l.cycle }} · {{ statusLabel(l.status) }}</span>
          </button>
        </li>
        <li v-if="!others.length && lattices.length" class="sw-only muted">only this lattice is up</li>
      </ul>
    </div>

    <!-- View tabs -->
    <nav class="tabs" aria-label="lattice views">
      <RouterLink
        v-for="t in TABS"
        :key="t.key"
        :to="pathFor(id, t.key)"
        class="tab"
        :class="{ active: t.key === view }"
        :aria-current="t.key === view ? 'page' : undefined"
      >{{ t.label }}</RouterLink>
    </nav>

    <span class="ctx-id num faint" :title="id">{{ id }}</span>
  </div>
  <!-- click-away -->
  <div v-if="open" class="sw-scrim" @click="open = false"></div>
</template>

<style scoped>
.ctxbar {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-2) var(--s-5);
  background: var(--bg-1);
  border-bottom: var(--bw) solid var(--line);
  position: sticky; top: 0; z-index: var(--z-header);
}

/* --- switcher --- */
.switch { position: relative; }
.sw-btn {
  display: flex; align-items: center; gap: var(--s-2);
  border-color: var(--line-strong); background: var(--bg-2);
  padding: var(--s-1) var(--s-3); border-radius: var(--r-2);
}
.sw-name { font-weight: 600; letter-spacing: 0.01em; }
.sw-meta { font-size: var(--t-xs); color: var(--text-2); }
.sw-caret { color: var(--text-2); font-size: 10px; }
.sw-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: var(--z-modal);
  margin: 0; padding: var(--s-1); list-style: none; min-width: 260px;
  background: var(--bg-2); border: var(--bw) solid var(--line-strong);
  border-radius: var(--r-2); box-shadow: 0 12px 28px rgba(0,0,0,0.45);
}
.sw-opt {
  display: flex; align-items: center; gap: var(--s-2); width: 100%;
  border: none; border-radius: var(--r-1); padding: var(--s-2) var(--s-2); text-align: left;
}
.sw-opt:hover { background: var(--bg-3); }
.sw-opt.active { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sw-opt-name { font-weight: 500; }
.sw-opt-meta { margin-left: auto; font-size: var(--t-xs); color: var(--text-2); }
.sw-only { padding: var(--s-2); font-size: var(--t-xs); }
.sw-scrim { position: fixed; inset: 0; z-index: calc(var(--z-modal) - 1); }

/* --- view tabs --- */
.tabs { display: flex; gap: 2px; }
.tab {
  font-family: var(--font-mono); font-size: var(--t-sm); letter-spacing: 0.02em;
  color: var(--text-2); padding: var(--s-1) var(--s-3);
  border-radius: var(--r-1); border-bottom: 2px solid transparent;
}
.tab:hover { color: var(--text-0); background: var(--bg-2); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.ctx-id { margin-left: auto; font-size: var(--t-xs); }
</style>
