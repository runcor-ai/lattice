<script setup lang="ts">
import { computed } from 'vue';

import { PHASE_ORDER } from '../frameModel.js';
import type { Playback, PlaybackSnapshot } from '../playback.js';
import { MIN_SPEED, MAX_SPEED } from '../playback.js';

const props = defineProps<{
  playback: Playback;
  snapshot: PlaybackSnapshot;
}>();

const SPEEDS = [0.25, 0.5, 1, 2, 4, 10];

const span = computed(() => Math.max(1, props.snapshot.latestCycle - props.snapshot.firstCycle));
const pct = computed(() => {
  const { cycle, firstCycle } = props.snapshot;
  return ((cycle - firstCycle) / span.value) * 100;
});

function onScrub(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  props.playback.seek(v);
}
function onSpeed(e: Event) {
  props.playback.setSpeed(Number((e.target as HTMLInputElement).value));
}
function pickSpeed(s: number) {
  props.playback.setSpeed(s);
}
</script>

<template>
  <div class="timeline panel">
    <div class="transport">
      <button title="Step cycle back" @click="playback.stepCycle(-1)">⏮</button>
      <button title="Step phase back" @click="playback.stepPhase(-1)">◁</button>
      <button class="primary play" :title="snapshot.playing ? 'Pause' : 'Play'" @click="playback.toggle()">
        {{ snapshot.playing ? '❚❚' : '▶' }}
      </button>
      <button title="Step phase forward" @click="playback.stepPhase(1)">▷</button>
      <button title="Step cycle forward" @click="playback.stepCycle(1)">⏭</button>

      <span class="readout mono">
        cycle <strong class="accent">{{ snapshot.cycle }}</strong>
        / {{ snapshot.latestCycle }}
        · <span class="phase-name">{{ PHASE_ORDER[snapshot.phaseIndex] }}</span>
      </span>

      <span class="spacer"></span>

      <span class="follow chip" :class="{ accent: snapshot.followLive }">
        <span class="dot" :class="snapshot.followLive ? 'running' : 'stopped'"></span>
        {{ snapshot.followLive ? 'live' : 'history' }}
      </span>

      <div class="speed">
        <span class="faint mono">speed</span>
        <input
          type="range"
          class="speed-range"
          :min="MIN_SPEED"
          :max="MAX_SPEED"
          step="0.05"
          :value="snapshot.speed"
          @input="onSpeed"
        />
        <span class="mono speed-val">{{ snapshot.speed.toFixed(2) }}×</span>
        <button
          v-for="s in SPEEDS"
          :key="s"
          class="speed-chip"
          :class="{ on: Math.abs(snapshot.speed - s) < 0.01 }"
          @click="pickSpeed(s)"
        >
          {{ s }}×
        </button>
      </div>
    </div>

    <!-- Scrubber: cycles on the X axis, with phase ticks within the playhead. -->
    <div class="scrubber">
      <input
        type="range"
        class="scrub-range"
        :min="snapshot.firstCycle"
        :max="snapshot.latestCycle"
        step="1"
        :value="snapshot.cycle"
        @input="onScrub"
      />
      <div class="phase-ticks">
        <span
          v-for="(p, i) in PHASE_ORDER"
          :key="p"
          class="phase-tick"
          :class="{ on: i === snapshot.phaseIndex }"
          :title="p"
        ></span>
      </div>
      <div class="rail-labels mono faint">
        <span>{{ snapshot.firstCycle }}</span>
        <span class="playhead-label" :style="{ left: pct + '%' }">▲ {{ snapshot.cycle }}</span>
        <span>{{ snapshot.latestCycle }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  padding: var(--s-3) var(--s-4);
}
.transport {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.transport button {
  padding: var(--s-1) var(--s-3);
  min-width: 36px;
}
.play {
  min-width: 48px;
}
.readout {
  margin-left: var(--s-3);
  font-size: var(--t-sm);
}
.readout .accent {
  color: var(--accent);
}
.phase-name {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-1);
}
.spacer {
  flex: 1;
}
.speed {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.speed-range {
  width: 120px;
}
.speed-val {
  width: 48px;
  text-align: right;
  color: var(--text-1);
}
.speed-chip {
  padding: 1px 6px;
  font-size: var(--t-xs);
}
.speed-chip.on {
  border-color: var(--accent);
  color: var(--accent);
}
.scrubber {
  margin-top: var(--s-3);
  position: relative;
}
.scrub-range {
  width: 100%;
}
.phase-ticks {
  display: flex;
  gap: 3px;
  margin-top: var(--s-1);
}
.phase-tick {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-3);
}
.phase-tick.on {
  background: var(--accent);
}
.rail-labels {
  display: flex;
  justify-content: space-between;
  font-size: var(--t-xs);
  margin-top: var(--s-1);
  position: relative;
}
.playhead-label {
  position: absolute;
  transform: translateX(-50%);
  color: var(--accent);
}
</style>
