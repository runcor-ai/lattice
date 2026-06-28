// Read-only replay for Step 3 (Tier-2 gate detectors) against the archived
// run-1 SQLite. Three jobs:
//
//   1. Enumerate every cheap-hook gate the lattice has on passed items
//      (content_contains, file_exists+minBytes). For each, report the gate
//      spec verbatim and whether its path is absolute or relative.
//   2. Run findGaps and report any Tier-2 findings, with the gate spec /
//      what the lattice assumed / what the file really shows / verdict.
//   3. Probe the schema for persisted gate-exit records (gate-state JSONL,
//      completion-check result rows, trace entries that durably capture
//      a costly hook's exit). The Step-3 plan said command_exits_zero /
//      http_status_is are out of scope BECAUSE no persistent record of
//      their exit exists — this confirms that empirically against the
//      actual schema instead of leaving it as assumption.
//
// Usage:
//   node replay-tier2-gates.mjs <sqlite> <pathRoot>

import Database from 'better-sqlite3';

import { findGaps } from './dist/index.js';

const [, , dbPath, pathRoot] = process.argv;
if (!dbPath || !pathRoot) {
  console.error('Usage: node replay-tier2-gates.mjs <sqlite> <pathRoot>');
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const entity = db.prepare(`SELECT cycle, name FROM entity WHERE id = 'self'`).get();
console.log(`lattice "${entity.name}" @ cycle ${entity.cycle}`);
console.log(`pathRoot: ${pathRoot}`);
console.log('');

// === 1. Enumerate cheap-hook gates on passed items ===
console.log('=== 1. Cheap-hook gates on passed items (Tier-2 surface) ===\n');

const passedItems = db
  .prepare(
    `SELECT id, description, completion_check FROM plan_item WHERE state = 'passed'`,
  )
  .all();

const gates = [];
for (const item of passedItems) {
  let cc;
  try {
    cc = JSON.parse(item.completion_check);
  } catch {
    continue;
  }
  for (const h of cc?.hooks ?? []) {
    if (h?.name === 'content_contains' || h?.name === 'file_exists') {
      gates.push({
        item_id: item.id,
        hook: h.name,
        args: h.args ?? {},
        item_desc: (item.description ?? '').slice(0, 80).replace(/\n/g, ' '),
      });
    }
  }
}

console.log(`${passedItems.length} passed items in the database.`);
console.log(`${gates.length} cheap-hook gates found (the Tier-2 surface).\n`);

const harnessGates = gates.filter((g) => {
  const p = String(g.args.path ?? '');
  return p.includes('/harness/') || p.startsWith('harness/');
});
console.log(`  ${harnessGates.length} reference harness paths (Step-3 calibration target).`);
const minBytesGates = gates.filter(
  (g) => g.hook === 'file_exists' && typeof g.args.minBytes === 'number' && g.args.minBytes > 0,
);
console.log(`  ${minBytesGates.length} have a non-zero minBytes (gate_minbytes_unmet surface).`);
const contentGates = gates.filter((g) => g.hook === 'content_contains');
console.log(`  ${contentGates.length} use content_contains (gate_content_unmet surface).`);
console.log('');

if (contentGates.length > 0) {
  console.log('--- content_contains gates (sample, up to 5) ---');
  for (const g of contentGates.slice(0, 5)) {
    const p = String(g.args.path ?? '');
    const abs = p.startsWith('/') ? 'absolute' : 'RELATIVE';
    console.log(`  item ${g.item_id}`);
    console.log(`    desc:        "${g.item_desc}"`);
    console.log(`    path (${abs}): ${p}`);
    console.log(`    needle:      "${String(g.args.needle ?? '').slice(0, 80)}"`);
    console.log(`    isRegex:     ${g.args.isRegex === true}`);
    console.log('');
  }
}

if (minBytesGates.length > 0) {
  console.log('--- file_exists+minBytes gates (sample, up to 5) ---');
  for (const g of minBytesGates.slice(0, 5)) {
    const p = String(g.args.path ?? '');
    const abs = p.startsWith('/') ? 'absolute' : 'RELATIVE';
    console.log(`  item ${g.item_id}`);
    console.log(`    desc:        "${g.item_desc}"`);
    console.log(`    path (${abs}): ${p}`);
    console.log(`    minBytes:    ${g.args.minBytes}`);
    console.log('');
  }
}

// === 2. Run Tier-2 detectors ===
console.log('=== 2. Tier-2 findings (live re-check against the filesystem) ===\n');

const skipNotes = [];
const findings = findGaps({
  db,
  currentCycle: entity.cycle,
  pathRoot,
  onSkip: (n) => skipNotes.push(n),
});

const tier2 = findings.filter(
  (f) => f.kind === 'gate_content_unmet' || f.kind === 'gate_minbytes_unmet',
);
console.log(`tier-2 findings: ${tier2.length}`);
console.log(`tier-1 (claim_vs_disk) findings: ${findings.filter((f) => f.kind === 'claim_vs_disk').length}`);
console.log(`skip-notes: ${skipNotes.length}`);
console.log('');

if (tier2.length > 0) {
  console.log('--- findings ---');
  for (const f of tier2) {
    const itemId = /item_id=([^;]+)/.exec(f.evidence)?.[1];
    const desc = itemId
      ? (db.prepare(`SELECT description FROM plan_item WHERE id = ?`).get(itemId)
          ?.description ?? '')
          .slice(0, 100)
          .replace(/\n/g, ' ')
      : '';
    console.log(`  kind: ${f.kind}`);
    console.log(`  item: ${itemId}  "${desc}"`);
    console.log(`  evidence: ${f.evidence}`);
    console.log('');
  }
}

if (skipNotes.length > 0) {
  console.log('--- skip-notes (first 10) ---');
  for (const n of skipNotes.slice(0, 10)) {
    console.log(`  [${n.reason}] ${n.detail}`);
  }
  if (skipNotes.length > 10) console.log(`  … and ${skipNotes.length - 10} more`);
  console.log('');
}

// === 3. Probe for persisted gate-exit records ===
console.log('=== 3. Persistent gate-exit records (event-vs-state probe) ===\n');

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
  .all()
  .map((r) => r.name);

const suspects = tables.filter((t) =>
  /(gate|exit|hook|check|run|result)/i.test(t),
);
console.log(`tables matching gate/exit/hook/check/run/result names: ${suspects.length}`);
for (const t of suspects) console.log(`  ${t}`);
console.log('');

// Look in the trace for evidence of persisted hook-evaluation results.
console.log('Searching trace bodies for hook-evaluation result records …');
const traceProbe = db
  .prepare(
    `SELECT kind, COUNT(*) AS n FROM trace
     WHERE body LIKE '%command_exits_zero%' OR body LIKE '%exitCode%'
        OR body LIKE '%http_status_is%' OR body LIKE '%passed":false%'
     GROUP BY kind`,
  )
  .all();
if (traceProbe.length === 0) {
  console.log(
    '  no trace rows mention command_exits_zero / exitCode / http_status_is / passed:false',
  );
} else {
  for (const r of traceProbe) console.log(`  kind=${r.kind}: ${r.n} rows`);
}

// Look in plan_item for any persisted last-result columns.
const planItemCols = db.prepare(`PRAGMA table_info(plan_item)`).all().map((c) => c.name);
const resultCols = planItemCols.filter((c) =>
  /(result|exit|last_run|last_check|passed|fail|reason)/i.test(c),
);
console.log('');
console.log(
  `plan_item columns suggesting persisted result/exit: ${resultCols.length}`,
);
for (const c of resultCols) console.log(`  ${c}`);
console.log('');

console.log('--- verdict ---');
if (suspects.length === 0 && traceProbe.length === 0 && resultCols.length === 0) {
  console.log(
    'No persistent gate-exit record exists in the schema. command_exits_zero',
  );
  console.log(
    'and http_status_is are correctly out of scope for Tier-2: their exits',
  );
  console.log(
    'are events that completed at a moment now gone, not states the watchdog',
  );
  console.log('can re-read without executing.');
} else {
  console.log(
    'Persisted records found. These are potential Tier-2 readers for the',
  );
  console.log(
    'next iteration — the event-result has become a re-readable state.',
  );
}

db.close();
