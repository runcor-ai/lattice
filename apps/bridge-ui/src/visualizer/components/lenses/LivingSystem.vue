<script setup lang="ts">
import { computed } from 'vue';

import type { CycleFrame } from '../../frameModel.js';
import type { PlaybackSnapshot } from '../../playback.js';

const props = defineProps<{ frame: CycleFrame | null; playback: PlaybackSnapshot }>();
const emit = defineEmits<{
  (e: 'hover', rowId: number | null): void;
  (e: 'select', facet: string): void;
}>();

const c = computed(() => props.frame?.components ?? null);
const blocked = computed(() => !!c.value?.dispatch.blockedBy);

const fit = (s: string | null | undefined, n = 14) => { const v = s ?? '—'; return v.length > n ? v.slice(0, n - 1) + '…' : v; };
// Bodies in the field (fixed loci; size/glow carry activity, the sub-value below each
// names what it's doing this cycle so the metaphor reads concretely).
const bodies = computed(() => [
  { key: 'senses', x: 180, y: 230, r: 26 + (c.value?.senses.count ?? 0) * 2, label: 'senses', sub: `${c.value?.senses.count ?? 0} reads`, on: props.playback.phaseIndex <= 1, color: 'var(--subconscious)' },
  { key: 'decide', x: 400, y: 160, r: 34, label: 'decide', sub: fit(c.value?.decide.action, 16), on: props.playback.phaseIndex >= 3, color: 'var(--accent)' },
  { key: 'dispatch', x: 620, y: 230, r: 32, label: 'dispatch', sub: blocked.value ? 'blocked' : (c.value?.dispatch.result ?? 'idle'), on: props.playback.phaseIndex >= 4, color: blocked.value ? 'var(--red)' : 'var(--green)' },
  { key: 'memory', x: 820, y: 170, r: 22 + (c.value?.memory.writes ?? 0) * 4, label: 'memory', sub: `+${c.value?.memory.writes ?? 0} written`, on: props.playback.phaseIndex >= 6, color: 'var(--green)' },
]);

// A capped particle stream emitted by decide, colliding with dispatch — or
// repelled to the membrane when the substrate field is active.
const PARTICLE_CAP = 9;
const particles = computed(() => {
  if (props.playback.phaseIndex < 3) return [];
  const from = { x: 400, y: 160 };
  const to = blocked.value ? { x: 560, y: 230 } : { x: 620, y: 230 };
  const n = Math.min(PARTICLE_CAP, 6);
  const out: { x: number; y: number; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t + Math.sin(t * 6) * 6, k: i });
  }
  return out;
});

const decideRowId = computed(() => props.frame?.phases.find((p) => p.phase === 'decide')?.rowId ?? null);
const actRowId = computed(() => props.frame?.phases.find((p) => p.phase === 'act')?.rowId ?? null);
const firstBlock = computed(() => c.value?.substrate.find((s) => s.outcome !== 'pass') ?? null);
</script>

<template>
  <svg viewBox="0 0 1000 460" class="system" preserveAspectRatio="xMidYMid meet" @click="emit('select', 'thoughts')">
    <!-- what this view shows -->
    <text x="500" y="30" class="ls-caption">DECIDE emits toward DISPATCH · the substrate field repels when a law blocks · MEMORY accretes what's written</text>
    <text x="500" y="48" class="ls-membrane-k">↑ gate membrane</text>
    <!-- membrane between decide and dispatch (gates) -->
    <line x1="500" y1="60" x2="500" y2="400" stroke="var(--line)" stroke-dasharray="2 6" />

    <!-- substrate repelling field around dispatch -->
    <circle v-if="blocked" cx="620" cy="230" r="70" fill="none" stroke="var(--substrate)" stroke-width="2"
            @mouseenter="emit('hover', firstBlock?.rowId ?? null)" @mouseleave="emit('hover', null)">
      <animate attributeName="r" values="62;74;62" dur="1.4s" repeatCount="indefinite" />
      <animate attributeName="opacity" values="0.7;0.3;0.7" dur="1.4s" repeatCount="indefinite" />
    </circle>

    <!-- bodies -->
    <g v-for="b in bodies" :key="b.key"
       @mouseenter="emit('hover', b.key === 'decide' ? decideRowId : b.key === 'dispatch' ? actRowId : null)"
       @mouseleave="emit('hover', null)">
      <circle :cx="b.x" :cy="b.y" :r="b.r"
              :fill="b.on ? 'rgba(125,211,252,0.10)' : 'var(--bg-2)'"
              :stroke="b.color" :stroke-width="b.on ? 3 : 1.5" class="body" />
      <text :x="b.x" :y="b.y + 4" class="body-label">{{ b.label }}</text>
      <text :x="b.x" :y="b.y + b.r + 16" class="body-sub">{{ b.sub }}</text>
    </g>

    <!-- particles -->
    <circle v-for="p in particles" :key="p.k" :cx="p.x" :cy="p.y" r="4"
            :fill="blocked ? 'var(--red)' : 'var(--accent)'" class="particle" />

    <!-- accreting item bodies (memory/plan) -->
    <g v-if="c && c.items.length">
      <text x="798" y="226" class="body-sub">plan items ({{ c.items.length }})</text>
      <circle v-for="(it, i) in c.items.slice(0, 10)" :key="it.id"
              :cx="820 + (i % 5) * 22 - 44" :cy="250 + Math.floor(i / 5) * 22" r="8"
              :fill="it.state === 'passed' ? 'var(--green)' : 'var(--bg-3)'"
              :stroke="it.changedThisCycle ? 'var(--green)' : 'var(--line)'" />
    </g>
    <text v-else x="820" y="260" class="empty">no items accreted</text>

    <!-- legend of motion -->
    <text x="400" y="120" class="emit" v-if="playback.phaseIndex >= 3">
      {{ blocked ? 'repelled · ' + c?.dispatch.blockedBy : 'emitting → dispatch' }}
    </text>
  </svg>
</template>

<style scoped>
.system {
  width: 100%;
  height: 100%;
}
.body {
  transition: r var(--motion-base) var(--easing), stroke-width var(--motion-fast) var(--easing);
}
.body-label {
  fill: var(--text-1);
  font-size: 12px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.body-sub {
  fill: var(--text-2);
  font-size: 11px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.ls-caption {
  fill: var(--text-2);
  font-size: 11px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.ls-membrane-k {
  fill: var(--text-3);
  font-size: 10px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.particle {
  transition: cx var(--motion-base) var(--easing), cy var(--motion-base) var(--easing);
}
.emit {
  fill: var(--text-2);
  font-size: 12px;
  text-anchor: middle;
  font-family: var(--font-mono);
}
.empty {
  fill: var(--text-3);
  font-size: 12px;
  text-anchor: middle;
  font-style: italic;
}
</style>
