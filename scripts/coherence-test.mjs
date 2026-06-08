#!/usr/bin/env node
/**
 * coherence-test.mjs — robustness / coherence stress test for a single lattice.
 *
 * Hands ONE lattice three concurrent, heterogeneous, EVOLVING jobs and injects
 * requirement changes on a staggered, cycle-triggered test plan, then checks
 * the lattice kept the threads coherent — i.e. it did not cross-contaminate
 * the deliverables, applied each requirement change to the RIGHT job, and
 * applied superseding changes to the latest spec rather than getting confused.
 *
 *   Job A  — a stopwatch web app           (requirements change 3×)
 *   Job B  — a unit-converter web app      (requirements change 2×)
 *   Job C  — read a GitHub repo, analyze it, rebuild it in Python (changes 1×)
 *
 * The driver polls the lattice's cycle counter and fires plan events when their
 * trigger cycle is reached: hand-job, change-requirement (append a gated item),
 * and checkpoint (capture + score coherence). Everything is recorded to
 * coherence-results/<ts>/ for review.
 *
 * Usage:
 *   node scripts/coherence-test.mjs                 # run it (real claude backend, costs)
 *   node scripts/coherence-test.mjs --dry-run       # validate plan + setup, no run
 *   node scripts/coherence-test.mjs --cap=70        # max cycles before giving up
 *   node scripts/coherence-test.mjs --lattice=<id>  # attach to an existing lattice
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* ----------------------------- config ----------------------------- */

const BASE = process.env.RUNCOR_BRIDGE ?? 'http://127.0.0.1:7100';
const ROOT = 'C:/runcor-lattice';
const OUT = `${ROOT}/coherence-run`; // base output dir (subdirs: app-a, app-b, rebuild, repo-src)
const REPO_URL = process.env.COHERENCE_REPO ?? 'https://github.com/sindresorhus/yocto-queue';
const RESULTS = `${ROOT}/coherence-results/${new Date().toISOString().replace(/[:.]/g, '-')}`;

const args = new Map(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DRY = args.has('dry-run');
const CAP = Number(args.get('cap') ?? 80);
const ATTACH = args.get('lattice');

/* ----------------------------- helpers ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
const fe = (path, minBytes) => JSON.stringify({ hooks: [{ name: 'file_exists', args: { path, minBytes } }] });
const cc = (path, needle, isRegex = true) =>
  JSON.stringify({ hooks: [{ name: 'content_contains', args: { path, needle, isRegex } }] });
// Appended items use a different shape than hand-job items: { type, args }.
const ccGate = (path, needle, isRegex = true) => ({ type: 'content_contains', args: { path, needle, isRegex } });

function record(name, data) {
  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, name), JSON.stringify(data, null, 2));
}

/* ----------------------------- the three jobs ----------------------------- */

const APP_A = `${OUT}/app-a`;
const APP_B = `${OUT}/app-b`;
const REBUILD = `${OUT}/rebuild`;
const REPO = `${OUT}/repo-src`;

const jobA = {
  label: 'A-stopwatch',
  title: 'Build a stopwatch web app',
  why: 'A small self-contained timing tool the operator can open in a browser.',
  body: [
    `Build a single self-contained file at ${APP_A}/index.html — a stopwatch.`,
    'Requirements: Start, Stop, and Reset buttons; an mm:ss.cs display that ticks while running.',
    'One file, no build step, no network. Clean styling.',
    'This app is the STOPWATCH only — do not add unit-conversion or any unrelated feature.',
  ].join('\n'),
  items: [{ description: `Write ${APP_A}/index.html — a working stopwatch`, completion_check: fe(`${APP_A}/index.html`, 800) }],
};

const jobB = {
  label: 'B-converter',
  title: 'Build a unit-converter web app',
  why: 'A small self-contained conversion tool, separate from the stopwatch.',
  body: [
    `Build a single self-contained file at ${APP_B}/index.html — a unit converter.`,
    'Requirements: convert length between kilometres and miles, live as the user types.',
    'One file, no build step, no network. Clean styling.',
    'This app is the CONVERTER only — do not add stopwatch/timer features.',
  ].join('\n'),
  items: [{ description: `Write ${APP_B}/index.html — a working km/miles converter`, completion_check: fe(`${APP_B}/index.html`, 800) }],
};

const jobC = {
  label: 'C-rebuild',
  title: 'Analyze a GitHub repo and rebuild it in Python',
  why: 'Tests cross-stack comprehension: read one implementation, reproduce its behavior in another language.',
  body: [
    `The source repo has been cloned (read-only) to ${REPO}. It is a small JavaScript library.`,
    'Read its source, understand its public functionality and behavior, then reimplement that',
    `behavior in Python — write ${REBUILD}/queue.py (the port) and ${REBUILD}/test_queue.py`,
    '(a few assertions exercising the same behavior). Pure Python stdlib, no pip deps.',
    'This job is the PYTHON PORT only — it is not a web app; do not write HTML/CSS here.',
  ].join('\n'),
  items: [
    { description: `Write ${REBUILD}/queue.py — Python port of the repo's functionality`, completion_check: fe(`${REBUILD}/queue.py`, 200) },
    { description: `Write ${REBUILD}/test_queue.py — behavior tests for the port`, completion_check: fe(`${REBUILD}/test_queue.py`, 100) },
  ],
};

/* ----------------------------- the test plan ----------------------------- *
 * Cycle-triggered events. Staggered arrival + interleaved requirement changes
 * deliberately overlap to stress coherence under concurrent, evolving load.
 */
const PLAN = [
  { at: 2, kind: 'hand', job: 'A', note: 'Job A arrives first (stopwatch).' },
  { at: 6, kind: 'hand', job: 'B', note: 'Job B arrives while A is in flight (now 2 concurrent).' },
  { at: 10, kind: 'change', job: 'A', desc: 'Add lap-time recording: a Lap button that records and lists split times.',
    gate: () => ccGate(`${APP_A}/index.html`, 'lap|Lap'), note: 'Change A#1 — feature add to an existing app.' },
  { at: 14, kind: 'hand', job: 'C', note: 'Job C arrives (repo→Python) — now 3 heterogeneous concurrent jobs.' },
  { at: 16, kind: 'change', job: 'B', desc: 'Add temperature conversion (Celsius ↔ Fahrenheit) alongside length.',
    gate: () => ccGate(`${APP_B}/index.html`, 'fahrenheit|Fahrenheit'), note: 'Change B#1 while C is starting.' },
  { at: 20, kind: 'change', job: 'A', desc: 'Restyle the stopwatch to a DARK theme and add keyboard shortcuts (space = start/stop, r = reset).',
    gate: () => ccGate(`${APP_A}/index.html`, 'keydown'), note: 'Change A#2 — concurrent with B change (load spike).' },
  { at: 24, kind: 'change', job: 'B', desc: 'Add a Swap button and remember the last-used unit in localStorage.',
    gate: () => ccGate(`${APP_B}/index.html`, 'localStorage'), note: 'Change B#2 — rapid successive change to B.' },
  { at: 28, kind: 'checkpoint', note: 'Mid-run coherence probe (3 jobs evolving in parallel).' },
  { at: 34, kind: 'change', job: 'C', desc: 'Add a command-line entry point (a __main__ block) that demonstrates the port.',
    gate: () => ccGate(`${REBUILD}/queue.py`, '__main__'), note: 'Change C#1 — change to the heterogeneous job.' },
  { at: 40, kind: 'change', job: 'A', desc: 'SUPERSEDE the theme: switch the stopwatch from dark to a high-contrast LIGHT palette (white background).',
    gate: () => ccGate(`${APP_A}/index.html`, 'fff|ffffff|white'), note: 'Change A#3 — CONTRADICTS A#2 (tests applying the latest spec, not the old one).' },
  { at: 48, kind: 'checkpoint', note: 'Final coherence probe.' },
];

const JOBS = { A: jobA, B: jobB, C: jobC };

/* --------------------- coherence scanning (the core signal) --------------------- *
 * Each job owns a domain. A deliverable that contains another job's domain
 * vocabulary is a coherence violation (cross-contamination). We also assert the
 * requirement-change keywords landed in the RIGHT deliverable.
 */
const DOMAIN = {
  A: { dir: APP_A, file: 'index.html', own: [/stopwatch|start|reset|lap/i], foreign: [/fahrenheit|kilometre|kilometer|convert|def \w+\(|import unittest/i] },
  B: { dir: APP_B, file: 'index.html', own: [/convert|mile|kilomet|fahrenheit|celsius/i], foreign: [/stopwatch|lap\b|def \w+\(|class \w+:/i] },
  C: { dir: REBUILD, file: 'queue.py', own: [/def |class |return/i], foreign: [/<html|<div|stopwatch|localStorage|fahrenheit/i] },
};

function scanCoherence() {
  const findings = [];
  for (const [job, d] of Object.entries(DOMAIN)) {
    const path = join(d.dir.replace(/\//g, '\\'), d.file);
    if (!existsSync(path)) {
      findings.push({ job, file: d.file, status: 'missing' });
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const ownOk = d.own.some((re) => re.test(text));
    const contamination = d.foreign.filter((re) => re.test(text)).map((re) => re.source);
    findings.push({
      job,
      file: d.file,
      bytes: text.length,
      hasOwnDomain: ownOk,
      crossContamination: contamination,
      coherent: ownOk && contamination.length === 0,
    });
  }
  return findings;
}

async function captureState(cycle, tag) {
  const out = { cycle, tag, at: new Date().toISOString() };
  try {
    out.inspect = await api('GET', `/api/lattices/${LATTICE}`);
  } catch (e) { out.inspectError = String(e); }
  try {
    out.memory = await api('GET', `/api/lattices/${LATTICE}/memory?limit=15`);
  } catch (e) { out.memoryError = String(e); }
  out.coherence = scanCoherence();
  out.deliverables = listDeliverables();
  record(`state-c${String(cycle).padStart(3, '0')}-${tag}.json`, out);
  const viol = out.coherence.filter((f) => f.coherent === false);
  log(`  checkpoint c${cycle}: ${out.coherence.filter((f) => f.coherent).length}/3 coherent` +
    (viol.length ? ` — VIOLATIONS: ${viol.map((v) => v.job + '(' + (v.status ?? v.crossContamination.join(',')) + ')').join('; ')}` : ' — clean'));
  return out;
}

function listDeliverables() {
  const walk = (dir) => {
    const abs = dir.replace(/\//g, '\\');
    if (!existsSync(abs)) return [];
    return readdirSync(abs).flatMap((f) => {
      const p = join(abs, f);
      const st = statSync(p);
      return st.isDirectory() ? walk(`${dir}/${f}`) : [{ path: `${dir}/${f}`, bytes: st.size }];
    });
  };
  return { 'app-a': walk(APP_A), 'app-b': walk(APP_B), rebuild: walk(REBUILD) };
}

/* ----------------------------- setup ----------------------------- */

let LATTICE = ATTACH || null;
const jobIds = {}; // label -> job_id

function setup() {
  for (const d of [OUT, APP_A, APP_B, REBUILD]) mkdirSync(d.replace(/\//g, '\\'), { recursive: true });
  if (DRY) { log('dry-run: skipping repo clone'); return; }
  if (!existsSync(REPO.replace(/\//g, '\\'))) {
    log(`cloning ${REPO_URL} (shallow) → ${REPO}`);
    const r = spawnSync('git', ['clone', '--depth', '1', REPO_URL, REPO.replace(/\//g, '\\')], { stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error('git clone failed');
  } else {
    log('repo already cloned, reusing');
  }
}

async function instantiate() {
  if (LATTICE) { log(`attaching to existing lattice ${LATTICE}`); return; }
  const manifest = [
    mkWrite('app-a-write', APP_A),
    mkWrite('app-b-write', APP_B),
    mkWrite('rebuild-write', REBUILD),
    { name: 'repo-listing', kind: 'fs-read', role: { sense: true, action: false }, readOnly: true, destructive: false, concurrencySafe: true, config: { root: REPO, maxEntries: 300 } },
    { name: 'repo-read', kind: 'fs-read-content', role: { sense: true, action: true }, readOnly: true, destructive: false, concurrencySafe: true, config: { root: REPO, defaultMaxBytes: 16000, hardMaxBytes: 200000 } },
    { name: 'delegate-cc', kind: 'claude-delegate', role: { sense: false, action: true }, readOnly: false, destructive: false, concurrencySafe: false, config: { workdir: OUT, timeoutMs: 600000, outputMaxBytes: 32000 } },
  ];
  const res = await api('POST', '/api/lattices', {
    name: 'coherence-test',
    identity_seed:
      'You are a senior engineer running MULTIPLE concurrent jobs at once. Each job is independent: keep their plans, files, and requirements strictly separate, never mix one job\'s work into another, and when a job\'s requirements change, apply the LATEST instruction for THAT job only.',
    goals: ['Deliver every job correctly and keep them coherent and separate'],
    bundle_id: 'software-engineer',
    autonomy: 'high',
    dialecticDepth: 0,
    model_backend: { kind: 'claude-code-host' },
    tool_manifest: manifest,
  });
  LATTICE = res.lattice_id;
  log(`instantiated lattice ${LATTICE}`);
  record('instantiate.json', { lattice: LATTICE, manifest, repo: REPO_URL });
}
function mkWrite(name, outDir) {
  return { name, kind: 'fs-write', role: { sense: false, action: true }, readOnly: false, destructive: false, concurrencySafe: false, config: { outDir } };
}

async function fireHand(job) {
  const j = JOBS[job];
  const res = await api('POST', `/api/lattices/${LATTICE}/jobs`, { title: j.title, why: j.why, body: j.body, items: j.items });
  jobIds[j.label] = res.job_id;
  log(`  handed Job ${job} (${j.label}) → ${res.job_id}`);
}
async function fireChange(ev) {
  const j = JOBS[ev.job];
  const jobId = jobIds[j.label];
  if (!jobId) { log(`  !! cannot change Job ${ev.job}: not handed yet`); return; }
  await api('POST', `/api/lattices/${LATTICE}/jobs/${jobId}/items`, { description: ev.desc, why: 'requirement change', gate: ev.gate() });
  log(`  changed Job ${ev.job}: ${ev.desc.slice(0, 60)}…`);
}

/* ----------------------------- driver ----------------------------- */

async function latticeState() {
  try {
    const o = await api('GET', `/api/lattices/${LATTICE}`);
    return { cycle: o.cycle ?? 0, status: o.status };
  } catch { return { cycle: -1, status: 'unreachable' }; }
}
async function currentCycle() { return (await latticeState()).cycle; }

async function run() {
  const fired = new Set();
  const maxAt = Math.max(...PLAN.map((e) => e.at));
  const timeline = [];
  log(`driver running — ${PLAN.length} events through cycle ${maxAt}, cap ${CAP}`);
  for (;;) {
    const { cycle, status } = await latticeState();
    if (status === 'stopped') { log('lattice was stopped (noop-watcher) — finalizing'); break; }
    for (const ev of PLAN) {
      const id = `${ev.at}:${ev.kind}:${ev.job ?? ''}`;
      if (fired.has(id) || cycle < ev.at) continue;
      fired.add(id);
      log(`c${cycle} ▶ ${ev.kind} ${ev.job ?? ''} — ${ev.note}`);
      timeline.push({ cycle, ...ev, gate: undefined });
      try {
        if (ev.kind === 'hand') await fireHand(ev.job);
        else if (ev.kind === 'change') await fireChange(ev);
        else if (ev.kind === 'checkpoint') await captureState(cycle, 'probe');
      } catch (e) { log(`  !! event error: ${e}`); }
    }
    record('timeline.json', timeline);
    const done = PLAN.every((e) => fired.has(`${e.at}:${e.kind}:${e.job ?? ''}`));
    if (done && cycle >= maxAt + 4) { log('all events fired + settle window elapsed'); break; }
    if (cycle >= CAP) { log(`cap ${CAP} reached`); break; }
    if (cycle < 0) { log('lattice unreachable — aborting'); break; }
    await sleep(5000);
  }
  const finalCycle = await currentCycle();
  const final = await captureState(finalCycle, 'final');
  const coherent = final.coherence.filter((f) => f.coherent).length;
  const verdict = { lattice: LATTICE, finalCycle, coherentJobs: `${coherent}/3`, coherence: final.coherence, resultsDir: RESULTS };
  record('verdict.json', verdict);
  log('================ COHERENCE VERDICT ================');
  log(`lattice ${LATTICE} @ cycle ${finalCycle}: ${coherent}/3 jobs coherent`);
  for (const f of final.coherence) log(`  ${f.job}: ${f.coherent ? 'COHERENT' : 'CHECK'} — ${JSON.stringify(f)}`);
  log(`full results: ${RESULTS}`);
}

/* ----------------------------- main ----------------------------- */

(async () => {
  log(`coherence-test — bridge ${BASE}, repo ${REPO_URL}`);
  setup();
  if (DRY) {
    log('DRY RUN — plan:');
    for (const e of PLAN) log(`  c${e.at}  ${e.kind} ${e.job ?? ''}  ${e.note}`);
    log(`would instantiate 1 lattice with 3 jobs handed at c2/c6/c14 and ${PLAN.filter((e) => e.kind === 'change').length} requirement changes.`);
    record('plan.json', PLAN.map((e) => ({ ...e, gate: undefined })));
    return;
  }
  await api('GET', '/api/health');
  await instantiate();
  await run();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
