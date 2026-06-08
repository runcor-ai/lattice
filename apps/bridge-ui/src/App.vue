<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const active = computed(() => route.path);

function go(path: string) {
  router.push(path);
}
</script>

<template>
  <div class="shell">
    <header class="header">
      <div class="brand">
        <div class="logo" aria-hidden="true">⌬</div>
        <div class="brand-text">
          <div class="brand-name">Runcor Lattice</div>
          <div class="brand-tag muted">Bridge — operator console</div>
        </div>
      </div>
      <nav class="nav">
        <button :class="{ active: active === '/' }" @click="go('/')">Roster</button>
        <button
          :class="{ active: active.startsWith('/instantiate') }"
          @click="go('/instantiate')"
        >
          Instantiate
        </button>
        <button
          :class="{ active: active.startsWith('/new-company') }"
          @click="go('/new-company')"
        >
          New company
        </button>
      </nav>
    </header>
    <main class="main">
      <router-view />
    </main>
    <footer class="footer muted">
      <span>Single-tenant local-only. 127.0.0.1.</span>
      <span class="faint">build slice 14</span>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s-3) var(--s-5);
  background: var(--bg-1);
  border-bottom: var(--bw) solid var(--line);
  position: sticky;
  top: 0;
  z-index: var(--z-header);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.logo {
  width: 32px;
  height: 32px;
  border-radius: var(--r-2);
  background: linear-gradient(135deg, var(--accent), #a78bfa);
  color: #0b1620;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
}
.brand-text {
  display: flex;
  flex-direction: column;
}
.brand-name {
  font-size: var(--t-lg);
  font-weight: 600;
  letter-spacing: 0.01em;
}
.brand-tag {
  font-size: var(--t-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.nav {
  display: flex;
  gap: var(--s-2);
}
.nav button {
  border-color: transparent;
}
.nav button.active {
  border-color: var(--accent);
  color: var(--accent);
}
.main {
  padding: var(--s-5);
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
  /* Let the 1fr row constrain to the viewport and scroll its own overflow,
     so tall views (roster) scroll here while fixed-height views (the
     visualizer) fill exactly without growing the page. */
  min-height: 0;
  overflow-y: auto;
}
.footer {
  display: flex;
  justify-content: space-between;
  padding: var(--s-3) var(--s-5);
  border-top: var(--bw) solid var(--line);
  font-size: var(--t-xs);
}
</style>
