<script setup lang="ts">
import type { InstantiateRequest, ModelBackendSpec } from '@runcor/bridge-shared';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Api } from '../api.js';

const router = useRouter();
const submitting = ref(false);
const error = ref<string | null>(null);

const DEFAULT_IDENTITY = `I am the operator's lattice.

I act as a careful, curious professional. I take work as it
arrives, decide the next single best action each cycle, and write
down the reasons for my decisions in my own memory.

I do not pretend to know things I have not been told.`;

const form = reactive<{
  name: string;
  identity_seed: string;
  goals: string;
  backendKind: ModelBackendSpec['kind'];
  autonomy: 'low' | 'medium' | 'high';
  dialecticDepth: number;
}>({
  name: 'my-lattice',
  identity_seed: DEFAULT_IDENTITY,
  goals: '',
  backendKind: 'stub',
  autonomy: 'medium',
  dialecticDepth: 0,
});

async function submit() {
  submitting.value = true;
  error.value = null;
  const body: InstantiateRequest = {
    name: form.name,
    identity_seed: form.identity_seed,
    goals: form.goals
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    dials: {},
    tool_manifest: [],
    model_backend: { kind: form.backendKind } as ModelBackendSpec,
    autonomy: form.autonomy,
    dialecticDepth: form.dialecticDepth,
  };
  try {
    const out = await Api.instantiate(body);
    router.push(`/lattice/${out.lattice_id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="instantiate">
    <h2>Instantiate a lattice</h2>
    <p class="muted hint">
      The lattice begins cycling immediately. Identity and goals are seeded once;
      the entity steers itself from there.
    </p>

    <div v-if="error" class="panel error">
      <div class="panel-body">{{ error }}</div>
    </div>

    <form class="panel form" @submit.prevent="submit">
      <div class="panel-body grid">
        <div class="field">
          <label for="name">Name</label>
          <input id="name" v-model="form.name" required maxlength="80" />
        </div>
        <div class="field">
          <label for="backend">Model backend</label>
          <select id="backend" v-model="form.backendKind">
            <option value="stub">stub (deterministic; no network)</option>
            <option value="direct-api">direct-api (Anthropic; requires key)</option>
            <option value="claude-code-host">claude-code-host (your subscription)</option>
          </select>
        </div>
        <div class="field">
          <label for="autonomy">Autonomy</label>
          <select id="autonomy" v-model="form.autonomy">
            <option value="low">low — operator approves substrate flags</option>
            <option value="medium">medium — escalates blocks</option>
            <option value="high">high — self-corrects</option>
          </select>
        </div>
        <div class="field">
          <label for="depth">Dialectic depth</label>
          <select id="depth" v-model.number="form.dialecticDepth">
            <option :value="0">0 — single-model decider</option>
            <option :value="1">1 — Player → Coach → Judge</option>
            <option :value="2">2 — Player → 2× Coach → Judge</option>
          </select>
        </div>
        <div class="field span2">
          <label for="seed">Identity seed</label>
          <textarea id="seed" v-model="form.identity_seed" rows="10" required></textarea>
        </div>
        <div class="field span2">
          <label for="goals">Goals (one per line)</label>
          <textarea
            id="goals"
            v-model="form.goals"
            rows="4"
            placeholder="e.g. Help me track my reading queue"
          ></textarea>
        </div>
      </div>
      <div class="panel-footer">
        <button type="button" @click="router.back()">Cancel</button>
        <button class="primary" type="submit" :disabled="submitting">
          {{ submitting ? 'Launching…' : 'Instantiate' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.instantiate h2 {
  margin: 0 0 var(--s-1);
  font-size: var(--t-2xl);
  font-weight: 600;
}
.hint {
  margin: 0 0 var(--s-4);
}
.form .panel-body.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-4);
}
.field.span2 {
  grid-column: span 2;
}
.field textarea {
  font-family: var(--font-mono);
  font-size: var(--t-sm);
  resize: vertical;
}
.panel-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  border-top: var(--bw) solid var(--line);
}
.error {
  border-color: var(--red);
  color: var(--red);
  margin-bottom: var(--s-4);
}
</style>
