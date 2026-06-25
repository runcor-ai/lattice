<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import LatticeContextBar from './components/LatticeContextBar.vue';

const route = useRoute();
const router = useRouter();
const active = computed(() => route.path);

// Per-lattice context: when inside /lattice/:id[/view], surface the context bar
// (lattice switcher + view tabs) so navigation never requires a trip to Roster.
const latticeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const inLattice = computed(() => !!latticeId.value && route.path.startsWith('/lattice/'));
const currentView = computed<'inspect' | 'visualize' | 'forecast'>(() =>
  route.path.endsWith('/forecast') ? 'forecast' : route.path.endsWith('/visualize') ? 'visualize' : 'inspect',
);

function go(path: string) { void router.push(path); }
</script>

<template>
  <div class="shell">
    <header class="header">
      <div class="brand" @click="go('/')" role="button" tabindex="0" @keydown.enter="go('/')">
        <div class="logo" aria-hidden="true">⌬</div>
        <div class="brand-text">
          <div class="brand-name">RUNCOR&nbsp;LATTICE</div>
          <div class="brand-tag eyebrow">Field Intelligence · operator console</div>
        </div>
      </div>
      <nav class="nav" aria-label="primary">
        <button :class="{ active: active === '/' }" @click="go('/')">Roster</button>
        <button :class="{ active: active.startsWith('/instantiate') }" @click="go('/instantiate')">Instantiate</button>
        <button :class="{ active: active.startsWith('/new-company') }" @click="go('/new-company')">New company</button>
      </nav>
    </header>

    <LatticeContextBar v-if="inLattice && latticeId" :id="latticeId" :view="currentView" />

    <main class="main">
      <router-view />
    </main>

    <footer class="footer">
      <span class="eyebrow">Single-tenant · local-only · 127.0.0.1</span>
      <span class="faint num">build · redesign</span>
    </footer>
  </div>
</template>

<style scoped>
.shell { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto; }

.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s-3) var(--s-5);
  background: var(--bg-1);
  border-bottom: var(--bw) solid var(--line-strong);
  position: sticky; top: 0; z-index: calc(var(--z-header) + 1);
}
.brand { display: flex; align-items: center; gap: var(--s-3); cursor: pointer; }
.logo {
  width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  border: var(--bw) solid var(--accent); color: var(--accent);
  border-radius: var(--r-2); font-size: 17px;
}
.brand-text { display: flex; flex-direction: column; gap: 1px; }
.brand-name { font-size: var(--t-md); font-weight: 700; letter-spacing: 0.12em; }
.brand-tag { letter-spacing: 0.1em; }

.nav { display: flex; gap: var(--s-1); }
.nav button {
  font-family: var(--font-mono); font-size: var(--t-sm); letter-spacing: 0.02em;
  border-color: transparent; color: var(--text-2); background: transparent;
  border-radius: var(--r-1); padding: var(--s-1) var(--s-3);
}
.nav button:hover { color: var(--text-0); background: var(--bg-2); border-color: transparent; }
.nav button.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: color-mix(in srgb, var(--accent) 8%, transparent); }

.main {
  padding: var(--s-5);
  max-width: 1440px; width: 100%; margin: 0 auto;
  min-height: 0; overflow-y: auto;
}
.footer {
  display: flex; justify-content: space-between; align-items: center;
  padding: var(--s-2) var(--s-5);
  border-top: var(--bw) solid var(--line);
  font-size: var(--t-xs);
}
</style>
