<script setup lang="ts">
import { computed } from 'vue';

import type { TraceRow } from '@runcor/bridge-shared';

const props = defineProps<{
  row: TraceRow | null;
  /** When true, a component is hovered but had no activity this cycle. */
  emptyHover: boolean;
}>();

const lines = computed<string[]>(() => {
  if (!props.row) return [];
  const r = props.row;
  const out: string[] = [`#${r.id} · c${r.cycle} · ${r.kind}${r.phase ? ' · ' + r.phase : ''}`];
  for (const [k, v] of Object.entries(r)) {
    if (['id', 'cycle', 'at_ms', 'kind', 'phase'].includes(k)) continue;
    out.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return out;
});
</script>

<template>
  <div v-if="emptyHover && !row" class="tooltip panel mono faint">no activity this cycle</div>
  <div v-else-if="row" class="tooltip panel mono">
    <div v-for="(l, i) in lines" :key="i" class="t-line" :class="{ head: i === 0 }">{{ l }}</div>
  </div>
</template>

<style scoped>
.tooltip {
  position: absolute;
  top: var(--s-3);
  right: var(--s-3);
  max-width: 420px;
  padding: var(--s-2) var(--s-3);
  font-size: var(--t-xs);
  z-index: var(--z-modal);
  pointer-events: none;
  background: var(--bg-2);
  border-color: var(--line-strong);
}
.t-line {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-1);
}
.t-line.head {
  color: var(--accent);
  margin-bottom: var(--s-1);
}
</style>
