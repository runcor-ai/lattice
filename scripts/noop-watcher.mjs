#!/usr/bin/env node
/**
 * noop-watcher.mjs — cleanly close a lattice once it has gone idle.
 *
 * Polls a lattice's decision trace and, after it chooses `noop` for N
 * consecutive cycles (default 3), stops it via the bridge (a clean stop that
 * keeps the run viewable). Use it so an idle lattice — one that has finished
 * its work and is just observing — doesn't burn cycles forever.
 *
 * Usage:
 *   node scripts/noop-watcher.mjs <lattice-id>
 *   node scripts/noop-watcher.mjs <lattice-id> --threshold=3 --poll=6000
 */

const BASE = process.env.RUNCOR_BRIDGE ?? 'http://127.0.0.1:7100';
const argv = process.argv.slice(2);
const LATTICE = argv.find((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const m = argv.find((a) => a.startsWith(`--${k}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const THRESHOLD = opt('threshold', 3);
const POLL = opt('poll', 6000);

if (!LATTICE) {
  console.error('usage: node scripts/noop-watcher.mjs <lattice-id> [--threshold=3] [--poll=6000]');
  process.exit(1);
}

const log = (...m) => console.log(`[noop-watcher ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function api(method, path) {
  // 8s timeout so a stalled bridge call can never hang the watcher forever.
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

/** The decided action for the most recent cycles, oldest→newest, deduped.
 *  The trace endpoint orders ASC, so we page from `after_cycle` to get the
 *  TRAILING window (not the first 20 rows of the whole run). */
async function recentDecisions(currentCycle) {
  const after = Math.max(0, (currentCycle ?? 0) - 12);
  const byCycle = new Map();
  let rows = [];
  try {
    rows = await api('GET', `/api/lattices/${LATTICE}/trace?kind=cognition&after_cycle=${after}&limit=40`);
  } catch { /* ignore */ }
  for (const r of rows) if (typeof r.cycle === 'number') byCycle.set(r.cycle, r.action ?? null);
  if (byCycle.size === 0) {
    const ph = await api('GET', `/api/lattices/${LATTICE}/trace?kind=phase&phase=decide&after_cycle=${after}&limit=40`);
    for (const r of ph) {
      const m = /action=([^;]+)/.exec(r.output_summary || '');
      if (typeof r.cycle === 'number') byCycle.set(r.cycle, m ? m[1] : null);
    }
  }
  return [...byCycle.entries()].sort((a, b) => a[0] - b[0]);
}

(async () => {
  log(`watching ${LATTICE} — stop after ${THRESHOLD} consecutive noop cycles`);
  let seen = new Set();
  for (;;) {
   try {
    const state = await api('GET', `/api/lattices/${LATTICE}`);
    if (state.status === 'stopped' || state.status === 'crashed') {
      log(`lattice already ${state.status} — nothing to do`);
      break;
    }
    // The entity auto-pauses when it runs out of open jobs (it parks rather
    // than noop-looping). That IS the "done/idle" signal — close it cleanly.
    if (state.status === 'paused_no_jobs') {
      log('lattice is paused_no_jobs (all work done) — stopping cleanly');
      try { await api('POST', `/api/lattices/${LATTICE}/actions/stop`); log('stopped. Stays viewable.'); }
      catch (e) { log(`stop failed: ${e}`); }
      break;
    }
    const decisions = await recentDecisions(state.cycle);
    // count the trailing run of consecutive noop cycles
    let trailingNoops = 0;
    for (let i = decisions.length - 1; i >= 0; i--) {
      if (decisions[i][1] === 'noop') trailingNoops++;
      else break;
    }
    const last = decisions[decisions.length - 1];
    if (last && !seen.has(last[0])) {
      seen.add(last[0]);
      log(`cycle ${last[0]} action=${last[1]} — trailing noops: ${trailingNoops}/${THRESHOLD}`);
    }
    if (trailingNoops >= THRESHOLD) {
      log(`${trailingNoops} consecutive noops — stopping lattice cleanly`);
      try {
        await api('POST', `/api/lattices/${LATTICE}/actions/stop`);
        log('stopped. It stays viewable in the bridge/visualizer.');
      } catch (e) { log(`stop failed: ${e}`); }
      break;
    }
    await new Promise((r) => setTimeout(r, POLL));
   } catch (e) {
    log(`transient error (continuing): ${e}`);
    await new Promise((r) => setTimeout(r, POLL));
   }
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
