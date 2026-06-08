<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { useLatticesStore } from '../stores/lattices.js';

const lattices = useLatticesStore();
const router = useRouter();

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  await lattices.refresh();
  timer = setInterval(() => lattices.refresh(), 2_000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

function open(id: string) {
  router.push(`/lattice/${id}`);
}
function visualize(id: string) {
  router.push(`/lattice/${id}/visualize`);
}
function instantiate() {
  router.push('/instantiate');
}
</script>

<template>
  <section class="roster">
    <div class="roster-header">
      <h2>Lattices</h2>
      <div class="actions">
        <span class="muted last-refresh" v-if="lattices.lastRefreshAtMs">
          refreshed {{ new Date(lattices.lastRefreshAtMs).toLocaleTimeString() }}
        </span>
        <button class="primary" @click="instantiate">New lattice</button>
      </div>
    </div>

    <div v-if="lattices.error" class="error panel">
      <div class="panel-body">{{ lattices.error }}</div>
    </div>

    <div class="panel">
      <table class="data" v-if="lattices.rows.length > 0">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Cycle</th>
            <th>Backend</th>
            <th>Autonomy</th>
            <th>ID</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in lattices.rows" :key="row.lattice_id" @click="open(row.lattice_id)">
            <td><span class="dot" :class="row.status"></span></td>
            <td>
              <span class="row-name">{{ row.name }}</span>
            </td>
            <td class="mono">{{ row.cycle }}</td>
            <td>
              <span class="chip">{{ row.model_backend }}</span>
            </td>
            <td><span class="chip">{{ row.autonomy }}</span></td>
            <td class="mono faint">{{ row.lattice_id }}</td>
            <td class="row-viz">
              <button class="viz-btn" @click.stop="visualize(row.lattice_id)">Visualize ▸</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">
        <p class="empty-title">No lattices yet.</p>
        <p class="muted">
          Instantiate one to begin. The entity will start cycling immediately and write its
          first trace entry within seconds.
        </p>
        <button class="primary" @click="instantiate">Instantiate a lattice</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.roster-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--s-4);
}
.roster-header h2 {
  margin: 0;
  font-size: var(--t-2xl);
  font-weight: 600;
  letter-spacing: -0.01em;
}
.actions {
  display: flex;
  gap: var(--s-3);
  align-items: center;
}
.last-refresh {
  font-size: var(--t-xs);
}
.error {
  border-color: var(--red);
  color: var(--red);
  margin-bottom: var(--s-4);
}
table.data tbody tr {
  cursor: pointer;
}
.row-name {
  font-weight: 500;
}
.row-viz {
  text-align: right;
}
.viz-btn {
  padding: 2px 10px;
  font-size: var(--t-xs);
  border-color: var(--accent);
  color: var(--accent);
}
.viz-btn:hover {
  background: var(--bg-3);
}
.empty {
  text-align: center;
  padding: var(--s-7) var(--s-4);
}
.empty-title {
  font-size: var(--t-lg);
  margin-bottom: var(--s-2);
}
</style>
