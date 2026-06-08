#!/usr/bin/env node
// Compact status probe for the coherence run + the reopen-stopwatch test.
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.RUNCOR_BRIDGE ?? 'http://127.0.0.1:7100';
const LAT = process.argv[2] ?? 'software-engineer-kg4uql';
const RUN = 'C:/runcor-lattice/coherence-run';

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  return r.ok ? r.json() : { _err: `${r.status}` };
};
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const has = (t, re) => (t ? re.test(t) : false);

const insp = await get(`/api/lattices/${LAT}`);
console.log(`\n== ${LAT} @ cycle ${insp.cycle} [${insp.status}] ==`);

const mem = await get(`/api/lattices/${LAT}/memory?limit=2`);
for (const j of mem.jobs ?? []) {
  const p = j.items.filter((i) => i.state === 'passed').length;
  console.log(`  • ${j.title} [${j.status}] ${p}/${j.items.length}`);
}

// reopen-stopwatch verification (in-place modify of app-a/index.html)
const a = read(`${RUN}/app-a/index.html`);
console.log('\n  app-a/index.html', a ? `(${a.length}B)` : '(missing)');
if (a) {
  console.log(`    lap=${has(a, /lap/i)} start/reset=${has(a, /start/i) && has(a, /reset/i)}` +
    ` | NEW: keydown=${has(a, /keydown/i)} lightTheme=${has(a, /#fff|#ffffff|background[^;]*white/i)}`);
}

// coherence: cross-contamination scan
const scan = (label, path, own, foreign) => {
  const t = read(path);
  if (!t) return console.log(`    ${label}: missing`);
  const ownOk = own.some((re) => re.test(t));
  const foul = foreign.filter((re) => re.test(t)).map((re) => re.source);
  console.log(`    ${label}: own=${ownOk} contamination=${foul.length ? foul.join(',') : 'none'}`);
};
console.log('  coherence:');
scan('app-a', `${RUN}/app-a/index.html`, [/stopwatch|lap|reset/i], [/fahrenheit|convert|kilomet|localstorage|def \w/i]);
scan('app-b', `${RUN}/app-b/index.html`, [/convert|mile|fahrenheit/i], [/stopwatch|lap\b|def \w|class \w+:/i]);
scan('rebuild/queue.py', `${RUN}/rebuild/queue.py`, [/def |class /i], [/<html|<div|stopwatch|localstorage/i]);

console.log('');
