<script setup lang="ts">
/* The signature element: a calibrated conviction scale (0–100), rendered as a
 * finely-ticked instrument gauge. Calibrated confidence is the core of the
 * forecast, so the console's identity is built from it. Reused on call cards
 * and (later) the roster. Status is passed only to color the needle, so the
 * gauge ties a call's conviction to its state without relying on color alone
 * (the number is always shown). */
defineProps<{ value: number; status?: string }>();
</script>

<template>
  <div class="cg" role="meter" :aria-valuenow="value" aria-valuemin="0" aria-valuemax="100" :aria-label="`conviction ${value} of 100`">
    <div class="cg-scale">
      <div class="cg-fill" :class="status" :style="{ width: value + '%' }"></div>
      <div class="cg-needle" :class="status" :style="{ left: value + '%' }"></div>
    </div>
    <div class="cg-read num">{{ value }}<span class="cg-den">/100</span></div>
  </div>
</template>

<style scoped>
.cg { display: flex; align-items: center; gap: var(--s-3); }
.cg-scale {
  position: relative; flex: 1; height: 11px; border-radius: 1px;
  background: var(--gauge-track);
  /* calibration ticks every 10% */
  background-image: repeating-linear-gradient(90deg, var(--gauge-tick) 0 1px, transparent 1px 10%);
  border: 1px solid var(--line);
  overflow: hidden;
}
.cg-fill { position: absolute; top: 0; bottom: 0; left: 0; background: color-mix(in srgb, var(--accent) 32%, transparent); transition: width var(--motion-base) var(--easing); }
.cg-fill.st-held { background: color-mix(in srgb, var(--green) 26%, transparent); }
.cg-fill.st-caveat { background: color-mix(in srgb, var(--orange) 26%, transparent); }
.cg-fill.st-revised { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.cg-needle { position: absolute; top: -1px; bottom: -1px; width: 2px; background: var(--accent); transform: translateX(-1px); transition: left var(--motion-base) var(--easing); }
.cg-needle.st-held { background: var(--green); }
.cg-needle.st-caveat { background: var(--orange); }
.cg-needle.st-revised { background: var(--accent); }
.cg-read { font-family: var(--font-mono); font-weight: 700; font-size: var(--t-md); min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
.cg-den { color: var(--text-3); font-size: var(--t-xs); font-weight: 400; }
@media (prefers-reduced-motion: reduce) { .cg-fill, .cg-needle { transition: none; } }
</style>
