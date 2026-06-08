<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';

import type { TraceRow } from '@runcor/bridge-shared';

import { Api } from '../api.js';
import Timeline from '../visualizer/components/Timeline.vue';
import ComponentTooltip from '../visualizer/components/ComponentTooltip.vue';
import ThoughtsPanel from '../visualizer/components/ThoughtsPanel.vue';
import OrchestrationBoard from '../visualizer/components/lenses/OrchestrationBoard.vue';
import CycleEngine from '../visualizer/components/lenses/CycleEngine.vue';
import LivingSystem from '../visualizer/components/lenses/LivingSystem.vue';
import { Playback, type PlaybackSnapshot, type Lens } from '../visualizer/playback.js';
import { useRunFrames } from '../visualizer/useRunFrames.js';

const props = defineProps<{ id: string }>();

const playback = new Playback();
const snapshot = ref<PlaybackSnapshot>(playback.snapshot());
let unsub: (() => void) | null = null;

const run = useRunFrames(props.id, playback);

const LENSES: Record<Lens, unknown> = {
  board: OrchestrationBoard,
  engine: CycleEngine,
  system: LivingSystem,
};
const LENS_LABEL: Record<Lens, string> = {
  board: 'Orchestration Board',
  engine: 'Cycle Engine',
  system: 'Living System',
};
const lensComponent = computed(() => LENSES[snapshot.value.lens]);
const currentFrame = computed(() => run.frameAt(snapshot.value.cycle));

// Clicking a graphic focuses a Thoughts-panel tab.
const focus = ref<string | null>(null);
function onSelect(facet: string) {
  // toggle via null so the same facet clicked twice still re-triggers the watch
  focus.value = null;
  requestAnimationFrame(() => (focus.value = facet));
}
function onSeek(cycle: number) {
  playback.pause();
  playback.seek(cycle);
}

// Hover tooltip (quick peek at the raw trace row).
const hoverRow = shallowRef<TraceRow | null>(null);
const emptyHover = ref(false);
function onHover(rowId: number | null) {
  playback.setHover(rowId);
  if (rowId == null) {
    hoverRow.value = null;
    emptyHover.value = false;
  } else {
    hoverRow.value = run.rowById(rowId);
    emptyHover.value = hoverRow.value == null;
  }
}

let liveSource: EventSource | null = null;

onMounted(async () => {
  unsub = playback.subscribe((s) => {
    snapshot.value = s;
  });
  await run.init();
  await ensureWindow(snapshot.value.cycle);

  let liveSeq = 1_000_000_000;
  liveSource = new EventSource(Api.streamUrl(props.id));
  liveSource.addEventListener('trace', (e) => {
    try {
      const raw = JSON.parse((e as MessageEvent).data) as Omit<TraceRow, 'id'>;
      const row = { ...raw, id: (raw as { id?: number }).id ?? liveSeq++ } as TraceRow;
      run.ingestLiveRow(row);
    } catch {
      /* malformed */
    }
  });

  if (!run.empty.value) playback.play();
});

onBeforeUnmount(() => {
  unsub?.();
  liveSource?.close();
  playback.dispose();
});

let windowReqCycle = -1;
async function ensureWindow(cycle: number) {
  if (!run.frameAt(cycle) && cycle !== windowReqCycle) {
    windowReqCycle = cycle;
    await run.loadWindow(cycle);
  }
}

watch(
  () => snapshot.value.cycle,
  (cycle) => {
    void ensureWindow(cycle);
  },
);

function setLens(l: Lens) {
  playback.setLens(l);
}

const stopping = ref(false);
const stopped = ref(false);
async function stopLattice() {
  if (!confirm('Stop this lattice? It stops cycling cleanly but stays viewable here for replay.')) return;
  stopping.value = true;
  try {
    await Api.action(props.id, 'stop');
    stopped.value = true;
    playback.pause();
  } catch (e) {
    alert(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    stopping.value = false;
  }
}
</script>

<template>
  <section class="visualize">
    <header class="vz-header">
      <div class="vz-title">
        <RouterLink :to="`/lattice/${id}`" class="back mono">‹ inspect</RouterLink>
        <h2 class="mono">run visualizer</h2>
        <span class="faint mono">{{ id }}</span>
      </div>
      <div class="vz-actions">
        <div class="lens-switch">
          <button
            v-for="l in (['board', 'engine', 'system'] as const)"
            :key="l"
            class="lens-btn"
            :class="{ on: snapshot.lens === l }"
            @click="setLens(l)"
          >
            {{ LENS_LABEL[l] }}
          </button>
        </div>
        <button class="danger stop-btn" :disabled="stopping || stopped" @click="stopLattice">
          {{ stopped ? '■ stopped' : stopping ? 'stopping…' : '■ Stop lattice' }}
        </button>
      </div>
    </header>

    <div class="vz-main">
      <div class="stage panel">
        <div v-if="run.error.value" class="state error">
          <p>Could not load this run.</p>
          <p class="faint mono">{{ run.error.value }}</p>
        </div>
        <div v-else-if="run.empty.value" class="state muted">
          <p>No cycles yet.</p>
          <p class="faint">This lattice has not completed a cycle. The visualizer will animate as it runs.</p>
        </div>
        <div v-else-if="run.loading.value && !currentFrame" class="state muted">
          <p>Loading run…</p>
        </div>
        <template v-else>
          <div class="lens-fill">
            <component
              :is="lensComponent"
              :frame="currentFrame"
              :playback="snapshot"
              @hover="onHover"
              @select="onSelect"
            />
          </div>
          <div
            v-if="!snapshot.playing && snapshot.followLive && snapshot.cycle === snapshot.latestCycle"
            class="idle-hint faint mono"
          >
            waiting for the next cycle…
          </div>
          <ComponentTooltip :row="hoverRow" :empty-hover="emptyHover" />
        </template>
      </div>

      <ThoughtsPanel :lattice-id="id" :snapshot="snapshot" :focus="focus" @seek="onSeek" />
    </div>

    <Timeline :playback="playback" :snapshot="snapshot" />
  </section>
</template>

<style scoped>
.visualize {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  height: 100%;
  min-height: 0;
}
.vz-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex: 0 0 auto;
}
.vz-title {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
}
.vz-title h2 {
  margin: 0;
  font-size: var(--t-lg);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.back {
  color: var(--text-2);
}
.back:hover {
  color: var(--accent);
}
.vz-actions {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.lens-switch {
  display: flex;
  gap: var(--s-1);
}
.stop-btn {
  font-size: var(--t-xs);
}
.lens-btn.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-3);
}
.vz-main {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 420px);
  grid-template-rows: minmax(0, 1fr);
  gap: var(--s-3);
}
.stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 40%, var(--bg-1), var(--bg-0));
}
.lens-fill {
  position: absolute;
  inset: 0;
}
.state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--s-7);
}
.state.error p:first-child {
  color: var(--red);
}
.idle-hint {
  position: absolute;
  bottom: var(--s-3);
  left: 50%;
  transform: translateX(-50%);
}
</style>
