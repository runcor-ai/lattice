<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

interface Bundle {
  id: string;
  autonomy: string;
  dialecticDepth: number;
  tool_count: number;
  identity_seed_preview: string;
}

const router = useRouter();
const bundles = ref<Bundle[]>([]);
const selected = reactive<Record<string, boolean>>({});
const submitting = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch('/api/bundles');
    bundles.value = (await res.json()) as Bundle[];
    for (const b of bundles.value) selected[b.id] = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});

async function launch() {
  const members = bundles.value
    .filter((b) => selected[b.id])
    .map((b) => ({ bundle_id: b.id }));
  if (members.length === 0) {
    error.value = 'Pick at least one role.';
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: { message: string } };
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    router.push('/');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section>
    <h2>Instantiate a company</h2>
    <p class="muted hint">
      Pick role bundles. Each lattice gets its own SQLite file, its own
      identity, its own memory. They share NOTHING. They find each other
      via the registry — but Law 11 (Standing) governs engagement.
    </p>

    <div v-if="error" class="panel error">
      <div class="panel-body">{{ error }}</div>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Available roles</h3></div>
      <div class="bundle-grid">
        <label
          v-for="b in bundles"
          :key="b.id"
          class="bundle"
          :class="{ picked: selected[b.id] }"
        >
          <div class="bundle-head">
            <input type="checkbox" v-model="selected[b.id]" />
            <span class="bundle-id mono">{{ b.id }}</span>
            <span class="chip">{{ b.autonomy }}</span>
            <span class="chip" v-if="b.dialecticDepth > 0">depth {{ b.dialecticDepth }}</span>
          </div>
          <pre class="bundle-preview mono">{{ b.identity_seed_preview }}…</pre>
        </label>
      </div>
    </div>

    <div class="panel-footer">
      <button type="button" @click="router.back()">Cancel</button>
      <button class="primary" :disabled="submitting" @click="launch">
        {{ submitting ? 'Launching…' : 'Launch company' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 var(--s-1);
  font-size: var(--t-2xl);
  font-weight: 600;
}
.hint {
  margin: 0 0 var(--s-4);
  max-width: 720px;
}
.error {
  border-color: var(--red);
  color: var(--red);
  margin-bottom: var(--s-4);
}
.bundle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--s-3);
  padding: var(--s-4);
}
.bundle {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--bg-2);
  border: var(--bw) solid var(--line);
  border-radius: var(--r-2);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--easing);
}
.bundle.picked {
  border-color: var(--accent);
  background: rgba(125, 211, 252, 0.04);
}
.bundle-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.bundle-head input {
  width: auto;
  margin: 0;
}
.bundle-id {
  font-weight: 600;
  text-transform: uppercase;
  font-size: var(--t-sm);
  letter-spacing: 0.04em;
}
.bundle-preview {
  margin: 0;
  font-size: var(--t-xs);
  color: var(--text-2);
  white-space: pre-wrap;
  max-height: 5.5em;
  overflow: hidden;
}
.panel-footer {
  display: flex;
  gap: var(--s-2);
  justify-content: flex-end;
  margin-top: var(--s-4);
}
</style>
