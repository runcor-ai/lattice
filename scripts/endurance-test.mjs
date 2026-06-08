#!/usr/bin/env node
/**
 * endurance-test.mjs — long-horizon cross-domain coherence + resume-parity +
 * tacit-knowledge-transfer test for a single lattice.
 *
 * Runs a sequence of jobs across DIFFERENT domains (web app, CLI, data
 * transform, library port, a different language, complex multi-file, plus
 * edge cases) over 500+ cycles. The driver injects one job at a time; the
 * lattice works it, then parks (paused_no_jobs, zero LLM) until the next
 * injection wakes it — so idle is free and the run self-paces.
 *
 * Two experiments ride along:
 *   1. RESUME PARITY — at cycle ~250 the driver cleanly stops the lattice and
 *      resumes it from SQLite; it must continue at 251 with memory intact.
 *   2. TACIT TRANSFER — "learn" jobs early induce disciplines (verify-before-
 *      done, read-the-contract-first, edit-in-place). Later "transfer" jobs in
 *      NEW domains OMIT that instruction; we capture whether the lattice
 *      applies the learned discipline anyway.
 *
 * The driver persists state, so if IT dies you can relaunch with --resume.
 *
 * Usage:
 *   node scripts/endurance-test.mjs                 # start a fresh run
 *   node scripts/endurance-test.mjs --resume        # continue the latest run
 *   node scripts/endurance-test.mjs --dry-run       # print the job plan, no run
 *   node scripts/endurance-test.mjs --max=520 --resume-at=250
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.RUNCOR_BRIDGE ?? 'http://127.0.0.1:7100';
const ROOT = 'C:/runcor-lattice';
const OUT = `${ROOT}/endurance-run`;
const STATE_DIR = `${ROOT}/coherence-results`;
const args = new Map(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DRY = args.has('dry-run');
const MAX = Number(args.get('max') ?? 520);
const RESUME_AT = Number(args.get('resume-at') ?? 250);
const RESUME = args.has('resume');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
const fe = (path, minBytes) => JSON.stringify({ hooks: [{ name: 'file_exists', args: { path, minBytes } }] });
const cc = (path, needle, isRegex = true) =>
  JSON.stringify({ hooks: [{ name: 'content_contains', args: { path, needle, isRegex } }] });

/* ---- domain dirs ---- */
const D = {
  web: `${OUT}/web`, cli: `${OUT}/cli`, data: `${OUT}/data`,
  port: `${OUT}/port`, repo: `${OUT}/repo-src`, lang: `${OUT}/lang`,
};

/* ---- the job sequence: domain, transfer tag, and whether the spec OMITS a
 *      discipline (to test if learned tacit knowledge is applied anyway). ---- */
const JOBS = [
  // ---- LEARN phase: induce disciplines ----
  { tag: 'web/learn-verify', domain: 'web', title: 'Build a stopwatch web app',
    body: `Build ${D.web}/stopwatch.html — a self-contained stopwatch (Start/Stop/Reset, mm:ss.cs). One file, no build, no network. Before declaring done, VERIFY it opens and the buttons are wired. Stopwatch only.`,
    items: [{ description: `${D.web}/stopwatch.html`, completion_check: fe(`${D.web}/stopwatch.html`, 800) }] },
  { tag: 'cli/learn-runverify', domain: 'cli', title: 'Build a Python word-count CLI',
    body: `Write ${D.cli}/wc.py — a CLI that takes a file path arg and prints line/word/char counts. Pure stdlib. Also write ${D.cli}/test_wc.py with assertions and RUN it to verify it passes before declaring done.`,
    items: [{ description: `${D.cli}/wc.py`, completion_check: fe(`${D.cli}/wc.py`, 200) },
            { description: `${D.cli}/test_wc.py`, completion_check: fe(`${D.cli}/test_wc.py`, 100) }] },
  { tag: 'port/learn-contract', domain: 'port', title: 'Port a JS library to Python (read the contract first)',
    body: `The repo at ${D.repo} is a small JS library. START by reading its README/source to understand its public contract, THEN reimplement that behavior in ${D.port}/lib.py with ${D.port}/test_lib.py. Pure stdlib.`,
    items: [{ description: `${D.port}/lib.py`, completion_check: fe(`${D.port}/lib.py`, 200) },
            { description: `${D.port}/test_lib.py`, completion_check: fe(`${D.port}/test_lib.py`, 100) }] },
  { tag: 'data/learn-schema', domain: 'data', title: 'Summarize a CSV dataset (inspect it first)',
    body: `A CSV is at ${D.data}/input.csv. FIRST read a sample to learn its columns, THEN write ${D.data}/summarize.py that reads it and writes ${D.data}/summary.json with row count and per-numeric-column min/max/mean. Run it to produce summary.json.`,
    items: [{ description: `${D.data}/summarize.py`, completion_check: fe(`${D.data}/summarize.py`, 200) },
            { description: `${D.data}/summary.json`, completion_check: fe(`${D.data}/summary.json`, 20) }] },

  // ---- TRANSFER phase: NEW domains, discipline OMITTED from the spec ----
  { tag: 'cli/transfer-verify', domain: 'cli', transfer: 'verify-before-done', omits: 'verification',
    title: 'Build a JSON pretty-printer CLI',
    body: `Write ${D.cli}/jsonpp.py — a CLI that reads a JSON file path arg and prints it indented. Pure stdlib.`,
    items: [{ description: `${D.cli}/jsonpp.py`, completion_check: fe(`${D.cli}/jsonpp.py`, 150) }] },
  { tag: 'data/transfer-schema', domain: 'data', transfer: 'inspect-data-first', omits: 'inspect-first',
    title: 'Aggregate a second dataset',
    body: `Write ${D.data}/agg.py that reads ${D.data}/events.csv and writes ${D.data}/agg.json grouping by the category column with counts.`,
    items: [{ description: `${D.data}/agg.py`, completion_check: fe(`${D.data}/agg.py`, 150) },
            { description: `${D.data}/agg.json`, completion_check: fe(`${D.data}/agg.json`, 10) }] },
  { tag: 'lang/transfer-lang', domain: 'lang', transfer: 'verify-before-done', omits: 'verification',
    title: 'Write a POSIX shell utility',
    body: `Write ${D.lang}/greet.sh — a POSIX shell script that takes a name arg and prints a greeting, with a usage message if no arg. Make it executable-style (shebang).`,
    items: [{ description: `${D.lang}/greet.sh`, completion_check: fe(`${D.lang}/greet.sh`, 60) }] },

  // ---- COMPLEX + EDGE ----
  { tag: 'cli/complex-multifile', domain: 'cli', title: 'Build a multi-command todo CLI (complex)',
    body: `Write ${D.cli}/todo.py — a CLI with subcommands: add <text>, list, done <n>. Persist to ${D.cli}/todos.json. Include ${D.cli}/test_todo.py exercising add/list/done and run it.`,
    items: [{ description: `${D.cli}/todo.py`, completion_check: fe(`${D.cli}/todo.py`, 300) },
            { description: `${D.cli}/test_todo.py`, completion_check: fe(`${D.cli}/test_todo.py`, 120) }] },
  { tag: 'web/reopen-editinplace', domain: 'web', transfer: 'edit-in-place',
    title: 'Revise the stopwatch (reopen + modify in place)',
    body: `The stopwatch at ${D.web}/stopwatch.html already exists. Reopen that file and MODIFY IT IN PLACE: add a Lap button that lists split times. Keep Start/Stop/Reset. Do not rewrite from scratch; do not touch other deliverables.`,
    items: [{ description: `${D.web}/stopwatch.html has lap`, completion_check: cc(`${D.web}/stopwatch.html`, 'lap|Lap') }] },
  { tag: 'cross/dependency', domain: 'cli', title: 'Use a prior deliverable',
    body: `Run the word-count CLI you wrote (${D.cli}/wc.py) against ${D.repo}/readme.md (or its README) and save the output to ${D.cli}/wc-of-readme.txt.`,
    items: [{ description: `${D.cli}/wc-of-readme.txt`, completion_check: fe(`${D.cli}/wc-of-readme.txt`, 5) }] },
  { tag: 'edge/underspecified', domain: 'data', edge: 'ambiguous',
    title: 'Improve the data tooling (deliberately vague)',
    body: `Make the data tooling better. (This spec is intentionally vague — choose a concrete, defensible improvement, state your assumption, and deliver it under ${D.data}/. Do not fabricate requirements you cannot ground.)`,
    items: [{ description: `some concrete data deliverable`, completion_check: fe(`${D.data}/IMPROVEMENT.md`, 80) }] },
  { tag: 'edge/contradiction', domain: 'web', edge: 'contradiction',
    title: 'Contradictory restyle of the stopwatch',
    body: `Restyle ${D.web}/stopwatch.html to a DARK theme. (Note: a later instruction may override this — always apply the most recent styling instruction, in place, keeping all behavior.)`,
    items: [{ description: `${D.web}/stopwatch.html dark`, completion_check: cc(`${D.web}/stopwatch.html`, 'background[^;]*(#0|#1|#2|black|dark)') }] },
];

/* ---- coherence/domain scan ---- */
function listOut() {
  const walk = (dir) => {
    const abs = dir.replace(/\//g, '\\');
    if (!existsSync(abs)) return [];
    return readdirSync(abs).flatMap((f) => {
      const p = join(abs, f); const st = statSync(p);
      return st.isDirectory() ? walk(`${dir}/${f}`) : [{ path: `${dir}/${f}`, bytes: st.size }];
    });
  };
  return Object.fromEntries(Object.entries(D).filter(([k]) => k !== 'repo').map(([k, v]) => [k, walk(v)]));
}

/* ---- state ---- */
let RESULTS, LATTICE, state;
function loadOrInitState() {
  if (RESUME) {
    const runs = existsSync(STATE_DIR.replace(/\//g, '\\'))
      ? readdirSync(STATE_DIR.replace(/\//g, '\\')).filter((d) => d.startsWith('endurance-'))
      : [];
    const latest = runs.sort().pop();
    if (latest) {
      RESULTS = `${STATE_DIR}/${latest}`;
      state = JSON.parse(readFileSync(join(RESULTS.replace(/\//g, '\\'), 'state.json'), 'utf8'));
      LATTICE = state.latticeId;
      log(`resuming run ${latest} — lattice ${LATTICE}, jobIndex ${state.jobIndex}`);
      return;
    }
    log('no prior run to resume; starting fresh');
  }
  RESULTS = `${STATE_DIR}/endurance-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  state = { latticeId: null, jobIndex: 0, resumeDone: false, parity: null, startedAt: new Date().toISOString() };
}
function saveState() {
  mkdirSync(RESULTS.replace(/\//g, '\\'), { recursive: true });
  state.latticeId = LATTICE;
  writeFileSync(join(RESULTS.replace(/\//g, '\\'), 'state.json'), JSON.stringify(state, null, 2));
}
function record(name, data) {
  mkdirSync(RESULTS.replace(/\//g, '\\'), { recursive: true });
  writeFileSync(join(RESULTS.replace(/\//g, '\\'), name), JSON.stringify(data, null, 2));
}

/* ---- setup: dirs, sample data, cloned repo ---- */
function setup() {
  for (const d of Object.values(D)) mkdirSync(d.replace(/\//g, '\\'), { recursive: true });
  if (DRY) return;
  const csv = `${D.data}/input.csv`.replace(/\//g, '\\');
  if (!existsSync(csv)) writeFileSync(csv, 'id,value,weight\n1,10,2.5\n2,20,1.0\n3,30,3.5\n4,40,0.5\n');
  const events = `${D.data}/events.csv`.replace(/\//g, '\\');
  if (!existsSync(events)) writeFileSync(events, 'ts,category,amount\n1,a,5\n2,b,3\n3,a,7\n4,c,2\n5,b,9\n');
  if (!existsSync(`${D.repo}/.git`.replace(/\//g, '\\')) && !existsSync(`${D.repo}/readme.md`.replace(/\//g, '\\'))) {
    log('cloning yocto-queue for the port job');
    spawnSync('git', ['clone', '--depth', '1', 'https://github.com/sindresorhus/yocto-queue', D.repo.replace(/\//g, '\\')], { stdio: 'inherit', shell: true });
  }
}

/* ---- lattice lifecycle ---- */
function manifest() {
  return [
    { name: 'out-write', kind: 'fs-write', role: { sense: false, action: true }, readOnly: false, destructive: false, concurrencySafe: false, config: { outDir: OUT } },
    { name: 'repo-listing', kind: 'fs-read', role: { sense: true, action: false }, readOnly: true, destructive: false, concurrencySafe: true, config: { root: D.repo, maxEntries: 300 } },
    { name: 'repo-read', kind: 'fs-read-content', role: { sense: true, action: true }, readOnly: true, destructive: false, concurrencySafe: true, config: { root: D.repo, defaultMaxBytes: 16000, hardMaxBytes: 200000 } },
    { name: 'delegate-cc', kind: 'claude-delegate', role: { sense: false, action: true }, readOnly: false, destructive: false, concurrencySafe: false, config: { workdir: OUT, timeoutMs: 600000, outputMaxBytes: 32000 } },
  ];
}
async function instantiate() {
  const res = await api('POST', '/api/lattices', {
    name: 'endurance', identity_seed:
      'You are a senior engineer working many jobs over a long horizon. Carry your hard-won habits across domains: verify a deliverable works before declaring it done; read a source’s contract before reimplementing it; edit existing files in place rather than rewriting; keep every job’s work strictly separate.',
    goals: ['Deliver every job correctly, carrying disciplines across domains'],
    bundle_id: 'software-engineer', autonomy: 'high', dialecticDepth: 0,
    model_backend: { kind: 'claude-code-host' }, tool_manifest: manifest(),
  });
  LATTICE = res.lattice_id; saveState();
  log(`instantiated ${LATTICE}`); record('instantiate.json', { lattice: LATTICE });
}
async function lstate() {
  try { const o = await api('GET', `/api/lattices/${LATTICE}`); return { cycle: o.cycle ?? 0, status: o.status }; }
  catch { return { cycle: -1, status: 'unreachable' }; }
}
async function memory() { try { return await api('GET', `/api/lattices/${LATTICE}/memory?limit=60`); } catch { return null; } }

async function handJob(job) {
  const res = await api('POST', `/api/lattices/${LATTICE}/jobs`, { title: job.title, why: `endurance: ${job.tag}`, body: job.body, items: job.items });
  log(`  handed [${job.tag}] ${job.title} -> ${res.job_id}`);
  return res.job_id;
}

/** Wait until the lattice parks (paused_no_jobs) or the cap is hit. Returns the cycle. */
async function waitForIdleOrCap() {
  for (;;) {
    const s = await lstate();
    if (s.status === 'paused_no_jobs') return s.cycle;
    if (s.status === 'stopped' || s.status === 'crashed' || s.cycle < 0) return s.cycle;
    if (s.cycle >= MAX) return s.cycle;
    await sleep(6000);
  }
}

async function resumeParityCheck() {
  log(`RESUME PARITY: stopping ${LATTICE} cleanly at cycle ~${RESUME_AT}`);
  const before = await api('GET', `/api/lattices/${LATTICE}`);
  const memBefore = await memory();
  await api('POST', `/api/lattices/${LATTICE}/actions/stop`);
  await sleep(2000);
  const sqlite = `${ROOT}/data/${LATTICE}.sqlite`;
  log('resuming from SQLite…');
  await api('POST', '/api/lattices', {
    name: 'endurance-resumed', identity_seed: 'resume placeholder', autonomy: 'high',
    model_backend: { kind: 'claude-code-host' }, resume_from_path: sqlite, tool_manifest: manifest(),
  });
  await sleep(2000);
  const after = await api('GET', `/api/lattices/${LATTICE}`);
  const memAfter = await memory();
  const parity = {
    cycleBefore: before.cycle, cycleAfter: after.cycle, statusAfter: after.status,
    episodicBefore: memBefore?.episodic?.length, episodicAfter: memAfter?.episodic?.length,
    identityPreserved: (memBefore?.identity?.length ?? 0) === (memAfter?.identity?.length ?? 0),
    ok: after.cycle >= before.cycle && (after.status === 'running' || after.status === 'paused_no_jobs'),
  };
  state.parity = parity; state.resumeDone = true; saveState();
  record('resume-parity.json', parity);
  log(`RESUME PARITY: ${parity.ok ? 'OK' : 'CHECK'} — cycle ${parity.cycleBefore}→${parity.cycleAfter}, identity preserved=${parity.identityPreserved}`);
}

async function captureJob(job, cycle) {
  const mem = await memory();
  const cap = {
    job: job.tag, cycle, deliverables: listOut(),
    // capture the durable lessons present in memory at this point (transfer evidence)
    semanticLessons: (mem?.semantic ?? []).filter((s) => /lesson|pattern|verify|contract|in place|separate/i.test(s.body || '')).map((s) => ({ cycle: s.cycle, body: (s.body || '').slice(0, 400) })),
    situation: (mem?.situation || '').slice(0, 800),
    transfer: job.transfer ?? null, omits: job.omits ?? null, edge: job.edge ?? null,
  };
  record(`job-${String(state.jobIndex).padStart(2, '0')}-${job.domain}.json`, cap);
  log(`  captured ${job.tag}: ${cap.semanticLessons.length} durable lessons in memory`);
}

/* ---- main driver ---- */
async function run() {
  while (state.jobIndex < JOBS.length) {
    const s = await lstate();
    if (s.cycle >= MAX) { log(`cap ${MAX} reached at job ${state.jobIndex}`); break; }
    // resume-parity checkpoint at the midpoint, on a clean job boundary
    if (!state.resumeDone && s.cycle >= RESUME_AT) { await resumeParityCheck(); }

    const job = JOBS[state.jobIndex];
    await handJob(job);
    await sleep(4000);
    const cycle = await waitForIdleOrCap();
    await captureJob(job, cycle);
    state.jobIndex += 1; saveState();
    if (cycle < 0) { log('lattice unreachable — aborting'); break; }
    if (cycle >= MAX) { log(`cap ${MAX} reached`); break; }
  }
  // finalize
  const fin = await lstate();
  if (fin.status !== 'stopped') { try { await api('POST', `/api/lattices/${LATTICE}/actions/stop`); } catch { /* ignore */ } }
  const verdict = {
    lattice: LATTICE, jobsRun: state.jobIndex, finalCycle: fin.cycle,
    resumeParity: state.parity, resultsDir: RESULTS,
  };
  record('verdict.json', verdict);
  log('================ ENDURANCE COMPLETE ================');
  log(`lattice ${LATTICE}: ${state.jobIndex}/${JOBS.length} jobs, final cycle ${fin.cycle}, resume-parity ${state.parity?.ok ? 'OK' : 'n/a'}`);
  log(`results: ${RESULTS}`);
}

/* ---- entry ---- */
(async () => {
  loadOrInitState();
  setup();
  if (DRY) {
    log(`ENDURANCE PLAN — ${JOBS.length} jobs, resume@${RESUME_AT}, cap ${MAX}`);
    JOBS.forEach((j, i) => log(`  ${i}. [${j.domain}] ${j.tag}${j.transfer ? ' (transfer: ' + j.transfer + (j.omits ? ', omits ' + j.omits : '') + ')' : ''}${j.edge ? ' (edge: ' + j.edge + ')' : ''}`));
    return;
  }
  await api('GET', '/api/health');
  if (!LATTICE) await instantiate();
  await run();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
