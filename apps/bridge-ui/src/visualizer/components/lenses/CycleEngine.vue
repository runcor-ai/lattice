<script setup lang="ts">
import { computed } from 'vue';

import { PHASE_ORDER, type CycleFrame } from '../../frameModel.js';
import type { PlaybackSnapshot } from '../../playback.js';

const props = defineProps<{ frame: CycleFrame | null; playback: PlaybackSnapshot }>();
const emit = defineEmits<{
  (e: 'hover', rowId: number | null): void;
  (e: 'select', facet: string): void;
}>();

const CX = 500;
const CY = 230;
const R = 150;

interface Node {
  phase: string;
  x: number;
  y: number;
  active: boolean;
  failed: boolean;
  rowId: number | null;
}

const nodes = computed<Node[]>(() =>
  PHASE_ORDER.map((phase, i) => {
    const angle = (i / PHASE_ORDER.length) * Math.PI * 2 - Math.PI / 2;
    const slice = props.frame?.phases.find((p) => p.phase === phase);
    return {
      phase,
      x: CX + Math.cos(angle) * R,
      y: CY + Math.sin(angle) * R,
      active: i === props.playback.phaseIndex,
      failed: slice?.status === 'failed',
      rowId: slice?.rowId ?? null,
    };
  }),
);

const pulse = computed<Node>(() => {
  const i = Math.min(PHASE_ORDER.length - 1, Math.max(0, props.playback.phaseIndex));
  return nodes.value[i] as Node;
});
const c = computed(() => props.frame?.components ?? null);
const blocked = computed(() => !!c.value?.dispatch.blockedBy);
const actNode = computed<Node>(() => nodes.value[4] as Node); // act
// Truncate so SVG text stays inside its shape (SVG text neither wraps nor clips).
const fit = (s: string | null | undefined, n = 16) => { const v = s ?? '—'; return v.length > n ? v.slice(0, n - 1) + '…' : v; };
</script>

<template>
  <svg viewBox="0 0 1000 460" class="engine" preserveAspectRatio="xMidYMid meet" @click="emit('select', 'thoughts')">
    <!-- ring -->
    <circle :cx="CX" :cy="CY" :r="R" fill="none" stroke="var(--line)" stroke-width="2" />

    <!-- arc from centre to the dispatched component (act node) -->
    <line
      v-if="playback.phaseIndex >= 4 && c?.dispatch.action"
      :x1="CX" :y1="CY" :x2="actNode.x" :y2="actNode.y"
      :stroke="blocked ? 'var(--red)' : 'var(--accent)'" stroke-width="2" stroke-dasharray="3 3"
    />

    <!-- phase nodes -->
    <g v-for="n in nodes" :key="n.phase"
       @mouseenter="emit('hover', n.rowId)" @mouseleave="emit('hover', null)">
      <circle :cx="n.x" :cy="n.y" :r="n.active ? 16 : 10"
              :fill="n.failed ? 'var(--red)' : n.active ? 'var(--accent)' : 'var(--bg-3)'"
              :stroke="n.active ? 'var(--accent)' : 'var(--line-strong)'" stroke-width="2" />
      <text :x="n.x" :y="n.y - 22" class="phase-label" :class="{ on: n.active }">{{ n.phase }}</text>
    </g>

    <!-- orbiting pulse -->
    <circle :cx="pulse.x" :cy="pulse.y" r="6" fill="var(--accent)" class="pulse" />

    <!-- centre: the decision -->
    <circle :cx="CX" :cy="CY" :r="64" :fill="blocked ? 'rgba(248,113,113,0.10)' : 'var(--bg-2)'"
            :stroke="blocked ? 'var(--red)' : 'var(--line-strong)'" stroke-width="2"
            @mouseenter="emit('hover', frame?.phases.find((p) => p.phase === 'decide')?.rowId ?? null)"
            @mouseleave="emit('hover', null)" />
    <text :x="CX" :y="CY - 6" class="centre-action">{{ fit(c?.decide.action, 15) }}</text>
    <text :x="CX" :y="CY + 16" class="centre-sub" :class="{ bad: blocked }">
      {{ blocked ? 'blocked: ' + c?.dispatch.blockedBy : (c?.dispatch.result ?? '') }}
    </text>

    <!-- satellites: memory, items, substrate, delegate -->
    <g class="satellites">
      <g @mouseenter="emit('hover', frame?.phases.find((p) => p.phase === 'write')?.rowId ?? null)" @mouseleave="emit('hover', null)">
        <text x="120" y="420" class="sat">memory +{{ c?.memory.writes ?? 0 }}</text>
      </g>
      <text x="320" y="420" class="sat" :class="{ moved: (c?.items.some((i) => i.changedThisCycle)) }">
        items {{ c?.items.length ?? 0 }}{{ c?.items.some((i) => i.changedThisCycle) ? ' ▲' : '' }}
      </text>
      <text x="520" y="420" class="sat sub-law">
        substrate {{ c?.substrate.filter((s) => s.outcome !== 'pass').length ?? 0 }}
      </text>
      <text x="760" y="420" class="sat" :class="{ cold: !c?.delegate }">
        delegate {{ c?.delegate ? 'HOT' : 'cold' }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.engine {
  width: 100%;
  height: 100%;
}
.phase-label {
  fill: var(--text-2);
  font-size: 11px;
  text-anchor: middle;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.phase-label.on {
  fill: var(--accent);
}
.pulse {
  transition: cx var(--motion-base) var(--easing), cy var(--motion-base) var(--easing);
}
.centre-action {
  fill: var(--accent);
  font-size: 13px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.centre-sub {
  fill: var(--text-2);
  font-size: 11px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.centre-sub.bad {
  fill: var(--red);
}
.sat {
  fill: var(--text-1);
  font-size: 12px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.sat.cold {
  fill: var(--text-3);
}
.sat.moved {
  fill: var(--green);
}
.sub-law {
  fill: var(--substrate);
}
</style>
