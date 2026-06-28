// Read-only replay of the claim_vs_disk Tier-1 detector against the archived
// run-1 SQLite. Run from packages/watchdog so better-sqlite3 resolves.
//
// Usage:
//   cd packages/watchdog && node replay-claim-vs-disk.mjs <sqlite> <pathRoot>

import Database from 'better-sqlite3';

import { findGaps } from './dist/index.js';

const [, , dbPath, pathRoot] = process.argv;
if (!dbPath || !pathRoot) {
  console.error('Usage: node replay-claim-vs-disk.mjs <sqlite> <pathRoot>');
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const entity = db.prepare(`SELECT cycle, name FROM entity WHERE id = 'self'`).get();
const passedCount = db
  .prepare(`SELECT COUNT(*) AS n FROM plan_item WHERE state = 'passed'`)
  .get().n;
const openCount = db
  .prepare(`SELECT COUNT(*) AS n FROM plan_item WHERE state = 'open'`)
  .get().n;
const deferredCount = db
  .prepare(`SELECT COUNT(*) AS n FROM plan_item WHERE state = 'deferred'`)
  .get().n;

console.log(
  `lattice "${entity.name}" @ cycle ${entity.cycle} — ` +
    `${passedCount} passed / ${openCount} open / ${deferredCount} deferred`,
);
console.log(`pathRoot: ${pathRoot}`);
console.log('');

const skipNotes = [];
const findings = findGaps({
  db,
  currentCycle: entity.cycle,
  pathRoot,
  onSkip: (n) => skipNotes.push(n),
});

const cvd = findings.filter((f) => f.kind === 'claim_vs_disk');
console.log(`claim_vs_disk findings: ${cvd.length}`);
console.log(`skip-notes: ${skipNotes.length}`);
console.log('');

if (cvd.length > 0) {
  console.log('--- findings ---');
  for (const f of cvd) {
    const itemId = /item_id=([^;]+)/.exec(f.evidence)?.[1];
    const claimedPath = /claimed_path=([^;]+)/.exec(f.evidence)?.[1];
    const status = /status=(\w+)/.exec(f.evidence)?.[1];
    let desc = '';
    if (itemId) {
      const row = db
        .prepare(`SELECT description FROM plan_item WHERE id = ?`)
        .get(itemId);
      desc = (row?.description ?? '').slice(0, 140).replace(/\n/g, ' ');
    }
    console.log(`  item_id=${itemId}`);
    console.log(`    desc:        "${desc}${desc.length === 140 ? '…' : ''}"`);
    console.log(`    claimed:     ${claimedPath}`);
    console.log(`    status:      ${status}`);
    console.log('');
  }
}

if (skipNotes.length > 0) {
  console.log('--- skip-notes (first 10) ---');
  for (const n of skipNotes.slice(0, 10)) {
    console.log(`  [${n.reason}] ${n.detail}`);
  }
  if (skipNotes.length > 10) {
    console.log(`  … and ${skipNotes.length - 10} more`);
  }
}

db.close();
