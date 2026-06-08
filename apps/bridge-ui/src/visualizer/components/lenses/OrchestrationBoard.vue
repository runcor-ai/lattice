<script setup lang="ts">
import { computed } from 'vue';

import type { CycleFrame, Phase } from '../../frameModel.js';
import type { PlaybackSnapshot } from '../../playback.js';

const props = defineProps<{ frame: CycleFrame | null; playback: PlaybackSnapshot }>();
const emit = defineEmits<{
  (e: 'hover', rowId: number | null): void;
  (e: 'select', facet: string): void;
}>();

function rowIdForPhase(phase: Phase): number | null {
  return props.frame?.phases.find((p) => p.phase === phase)?.rowId ?? null;
}

const c = computed(() => props.frame?.components ?? null);

// The packet rides phases observe..act across the first three columns.
const PHASE_X: Record<number, number> = {
  0: 120, // observe  -> senses
  1: 120,
  2: 300, // recall   -> approaching decide
  3: 300, // decide
  4: 500, // act      -> dispatch
  5: 500,
  6: 700, // write    -> memory/items
  7: 700,
};
const packetX = computed(() => PHASE_X[props.playback.phaseIndex] ?? 120);

const blocked = computed(() => !!c.value?.dispatch.blockedBy);
const wallColor = computed(() =>
  blocked.value ? 'var(--red)' : c.value?.dispatch.result === 'ok' ? 'var(--green)' : 'var(--line-strong)',
);
const decideActive = computed(() => props.playback.phaseIndex >= 3);
const delegateCold = computed(() => !c.value?.delegate);

const firstBlock = computed(
  () => c.value?.substrate.find((s) => s.outcome !== 'pass') ?? null,
);
</script>

<template>
  <svg viewBox="0 0 1000 460" class="board" preserveAspectRatio="xMidYMid meet">
    <!-- flow rail -->
    <line x1="120" y1="150" x2="880" y2="150" stroke="var(--line)" stroke-width="2" />

    <!-- SENSES -->
    <g class="col" @mouseenter="emit('hover', rowIdForPhase('observe'))" @mouseleave="emit('hover', null)">
      <rect x="60" y="110" width="120" height="80" rx="8"
            :fill="playback.phaseIndex <= 1 ? 'var(--bg-3)' : 'var(--bg-2)'"
            :stroke="playback.phaseIndex <= 1 ? 'var(--accent)' : 'var(--line)'" />
      <text x="120" y="100" class="label">SENSES</text>
      <text x="120" y="155" class="val">{{ c?.senses.count ?? 0 }} reads</text>
    </g>

    <!-- DECIDE -->
    <g class="col click" @click="emit('select', 'thoughts')" @mouseenter="emit('hover', rowIdForPhase('decide'))" @mouseleave="emit('hover', null)">
      <rect x="240" y="110" width="120" height="80" rx="8"
            :fill="decideActive ? 'var(--bg-3)' : 'var(--bg-2)'"
            :stroke="decideActive ? 'var(--accent)' : 'var(--line)'" />
      <text x="300" y="100" class="label">DECIDE</text>
      <text x="300" y="148" class="val action">{{ c?.decide.action ?? '—' }}</text>
      <text x="300" y="170" class="sub">blocks={{ c?.decide.blocks ?? 0 }}</text>
    </g>

    <!-- DISPATCH + substrate wall -->
    <g class="col click" @click="emit('select', 'thoughts')" @mouseenter="emit('hover', rowIdForPhase('act'))" @mouseleave="emit('hover', null)">
      <rect x="440" y="110" width="120" height="80" rx="8"
            :fill="blocked ? 'rgba(248,113,113,0.10)' : 'var(--bg-2)'"
            :stroke="blocked ? 'var(--red)' : playback.phaseIndex >= 4 ? 'var(--accent)' : 'var(--line)'" />
      <text x="500" y="100" class="label">DISPATCH</text>
      <text x="500" y="148" class="val action">{{ c?.dispatch.action ?? '—' }}</text>
      <text x="500" y="170" class="sub" :class="{ bad: blocked }">
        {{ blocked ? 'BLOCKED · ' + c?.dispatch.blockedBy : c?.dispatch.result ?? '' }}
      </text>
    </g>
    <!-- the substrate "wall" just right of dispatch -->
    <g v-if="firstBlock" @mouseenter="emit('hover', firstBlock.rowId)" @mouseleave="emit('hover', null)">
      <rect x="582" y="96" width="10" height="108" rx="2" :fill="wallColor">
        <animate attributeName="opacity" values="1;0.45;1" dur="0.9s" repeatCount="indefinite" />
      </rect>
      <text x="587" y="86" class="wall-label">{{ firstBlock.law }}</text>
    </g>

    <!-- GATES · ITEMS -->
    <g class="col click" @click="emit('select', 'plan')">
      <text x="700" y="60" class="label">ITEMS · GATES</text>
      <template v-if="c && c.items.length">
        <g v-for="(it, i) in c.items.slice(0, 6)" :key="it.id"
           @mouseenter="emit('hover', null)" @mouseleave="emit('hover', null)">
          <rect :x="650" :y="80 + i * 30" width="200" height="24" rx="5"
                :fill="it.changedThisCycle ? 'rgba(132,204,139,0.14)' : 'var(--bg-2)'"
                :stroke="it.state === 'passed' ? 'var(--green)' : it.changedThisCycle ? 'var(--green)' : 'var(--line)'" />
          <text :x="662" :y="96 + i * 30" class="item">
            {{ it.state === 'passed' ? '▣' : '◻' }} {{ it.label.slice(0, 26) }}
          </text>
        </g>
      </template>
      <text v-else x="700" y="120" class="empty">no items — plan static</text>
    </g>

    <!-- MEMORY -->
    <g class="col click" @click="emit('select', 'memory')" @mouseenter="emit('hover', rowIdForPhase('write'))" @mouseleave="emit('hover', null)">
      <rect x="880" y="110" width="90" height="80" rx="8"
            :fill="c && c.memory.writes > 0 ? 'rgba(132,204,139,0.10)' : 'var(--bg-2)'"
            :stroke="c && c.memory.writes > 0 ? 'var(--green)' : 'var(--line)'" />
      <text x="925" y="100" class="label">MEMORY</text>
      <text x="925" y="155" class="val">+{{ c?.memory.writes ?? 0 }}</text>
    </g>

    <!-- the travelling packet -->
    <circle :cx="packetX" cy="150" r="9" :fill="blocked && packetX >= 500 ? 'var(--red)' : 'var(--accent)'"
            class="packet" />

    <!-- DELEGATE lane -->
    <g class="col" @mouseenter="emit('hover', rowIdForPhase('decide'))" @mouseleave="emit('hover', null)">
      <line x1="440" y1="300" x2="880" y2="300" stroke="var(--line)" stroke-dasharray="4 4" />
      <text x="120" y="305" class="label" text-anchor="start">DELEGATE → executor</text>
      <rect x="440" y="280" width="200" height="40" rx="8"
            :fill="delegateCold ? 'var(--bg-2)' : 'rgba(125,211,252,0.12)'"
            :stroke="delegateCold ? 'var(--line)' : 'var(--accent)'" />
      <text x="540" y="304" class="val" :class="{ cold: delegateCold }">
        {{ delegateCold ? 'COLD' : c?.delegate?.brief }}
      </text>
    </g>

    <!-- substrate firings strip -->
    <g v-if="c && c.substrate.length" class="col">
      <text x="120" y="370" class="label" text-anchor="start">SUBSTRATE</text>
      <g v-for="(s, i) in c.substrate.slice(0, 4)" :key="i"
         @mouseenter="emit('hover', s.rowId)" @mouseleave="emit('hover', null)">
        <rect :x="120 + i * 200" y="385" width="185" height="30" rx="6"
              fill="rgba(192,132,252,0.10)" stroke="var(--substrate)" />
        <text :x="128 + i * 200" y="404" class="sub sub-law">{{ s.law }} · {{ s.outcome }}</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.board {
  width: 100%;
  height: 100%;
  font-family: var(--font-sans);
}
.label {
  fill: var(--text-2);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-anchor: middle;
  text-transform: uppercase;
}
.val {
  fill: var(--text-0);
  font-size: 14px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.val.action {
  fill: var(--accent);
}
.val.cold {
  fill: var(--text-3);
}
.sub {
  fill: var(--text-2);
  font-size: 11px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.sub.bad {
  fill: var(--red);
}
.sub-law {
  fill: var(--substrate);
  text-anchor: start;
}
.item {
  fill: var(--text-1);
  font-size: 12px;
  font-family: var(--font-mono);
}
.empty {
  fill: var(--text-3);
  font-size: 12px;
  text-anchor: middle;
  font-style: italic;
}
.wall-label {
  fill: var(--red);
  font-size: 10px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.packet {
  transition: cx var(--motion-base) var(--easing), fill var(--motion-fast) var(--easing);
}
.click {
  cursor: pointer;
}
</style>
