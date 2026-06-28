// Read-only replay of the Tier-3 frame_order detector against the archived
// run-1 SQLite. Three jobs:
//
//   1. Run findOpenQuestions and report each surface in the user's specified
//      shape (expected sequence / produced sequence / first divergence /
//      lattice's position / watchdog's position).
//   2. Structural sanity: confirm no Tier-3 surface landed in
//      memory_semantic_correction.
//   3. If the job declared NO expected sequence (the run-1 case), emit a
//      PASTE-READY expected-sequence block the job WOULD have needed for
//      the gap to be detectable — the actual ordered list of deliverables
//      the lattice produced, rendered in each of the three parser formats.
//
// Usage:
//   cd packages/watchdog && node replay-tier3-frame-order.mjs <sqlite> <pathRoot>

import Database from 'better-sqlite3';

import { findOpenQuestions } from './dist/index.js';

const [, , dbPath, pathRoot] = process.argv;
if (!dbPath || !pathRoot) {
  console.error('Usage: node replay-tier3-frame-order.mjs <sqlite> <pathRoot>');
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const entity = db.prepare(`SELECT cycle, name FROM entity WHERE id = 'self'`).get();
console.log(`lattice "${entity.name}" @ cycle ${entity.cycle}`);
console.log(`pathRoot: ${pathRoot}`);
console.log('');

// === 1. Surfaces ===
console.log('=== 1. Tier-3 surfaces (frame_order) ===\n');

const surfaces = findOpenQuestions({ db });
console.log(`open-question surfaces: ${surfaces.length}`);
console.log('');

if (surfaces.length > 0) {
  for (const q of surfaces) {
    console.log(`  kind:               ${q.kind}`);
    console.log(`  item_id:            ${q.itemId ?? 'NA'}`);
    console.log(`  lattice's position: ${q.latticePosition}`);
    console.log(`  watchdog's position: ${q.watchdogPosition}`);
    console.log(`  no authoritative object because: ${q.noObjectReason}`);
    console.log('');
  }
}

// === 2. Structural sanity ===
console.log('=== 2. Structural sanity ===\n');

const corrTier3 = db
  .prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction WHERE rule LIKE 'tier3:%'`)
  .get();
console.log(`memory_semantic_correction rows with tier3:* rule: ${corrTier3.n} (expected 0)`);

const corrTotal = db
  .prepare(`SELECT COUNT(*) AS n FROM memory_semantic_correction`)
  .get();
console.log(`memory_semantic_correction total rows: ${corrTotal.n}`);

// Check whether the live replay would write into the corrections channel —
// findOpenQuestions itself never writes; the slow-clock's surfaceOpenQuestions
// is what persists, and that lives in @runcor/slowclock. Here we're checking
// the pure read-side: no Tier-3 row appeared in the corrections table on disk.
console.log('');

// === 3. Per-job expected-sequence diagnostics ===
console.log('=== 3. Per-job expected sequence (what the parser sees) ===\n');

const jobs = db
  .prepare(`SELECT id, title, status, body FROM plan_job`)
  .all();

for (const job of jobs) {
  console.log(`--- job "${job.title}" (status=${job.status}) ---`);
  if (!job.body || job.body.length === 0) {
    console.log('  body: <empty>');
    console.log('');
    continue;
  }

  const expected = parseExpectedSequence(job.body);
  if (expected.length >= 2) {
    console.log(`  parsed expected sequence (${expected.length} items):`);
    for (let i = 0; i < expected.length; i++) {
      console.log(`    ${i + 1}. ${truncate(expected[i], 100)}`);
    }
  } else {
    console.log('  parsed expected sequence: NONE (no parseable ordered list)');
  }

  // Show what the job WOULD have detected as the produced order.
  const produced = db
    .prepare(
      `SELECT id, description, passed_at_cycle
       FROM plan_item
       WHERE job_id = ? AND state = 'passed' AND source != 'plan_step'
       ORDER BY passed_at_cycle ASC, ordinal ASC`,
    )
    .all(job.id);
  console.log(`  produced deliverables (${produced.length}, excluding plan_step):`);
  for (let i = 0; i < produced.length; i++) {
    console.log(`    ${i + 1}. ${truncate(produced[i].description, 100)} (passed@${produced[i].passed_at_cycle})`);
  }
  console.log('');
}

// === 4. Paste-ready expected-sequence block ===
console.log('=== 4. Paste-ready expected-sequence block ===\n');

// For each job whose parsed expected sequence is empty, emit a paste-ready
// block in each of the three formats. Turn the null result into an artifact
// the operator can drop into the next job body.
//
// Label sourcing — in priority order:
//   (1) ≥2 produced deliverables → use those (the operator can edit)
//   (2) the body's own `## section headers` → operator-authored intent
//   (3) the body's first bulleted list (5 items max) → likely the "deliverables"
//   (4) generic placeholders if none of the above yield ≥2 labels
let emittedAny = false;
for (const job of jobs) {
  const expected = parseExpectedSequence(job.body ?? '');
  if (expected.length >= 2) continue;

  const produced = db
    .prepare(
      `SELECT description, passed_at_cycle
       FROM plan_item
       WHERE job_id = ? AND state = 'passed' AND source != 'plan_step'
       ORDER BY passed_at_cycle ASC, ordinal ASC`,
    )
    .all(job.id);

  const { labels, sourceNote } = pickTemplateLabels(produced, job.body ?? '');
  if (labels.length < 2) {
    console.log(`--- for job "${job.title}" ---`);
    console.log(`The job stated no parseable ordered sequence and the body does not yield`);
    console.log(`enough candidate labels to template. To enable order-divergence detection,`);
    console.log(`add a numbered list, "Step N:" prefix list, or arrow chain (≥3 tokens) to`);
    console.log(`the job body. Generic placeholders below.\n`);
    // Fully neutral placeholders — no domain words, no SDLC assumptions.
    // The operator replaces "Step A/B/C/…" with whatever their job intends
    // as the correct order.
    emitFormats(['Step A', 'Step B', 'Step C', 'Step D'], 'PLACEHOLDER');
    console.log('');
    emittedAny = true;
    continue;
  }

  emittedAny = true;
  console.log(`--- for job "${job.title}" ---`);
  console.log(`The job stated no parseable ordered sequence. Paste ONE of these into the`);
  console.log(`job body to make order-divergence detectable on the next run.`);
  console.log(`Label source: ${sourceNote}. Edit to reflect what the job INTENDS as the`);
  console.log(`correct order; the labels below are starting points only.\n`);
  emitFormats(labels, sourceNote);
  console.log('');
}

if (!emittedAny) {
  console.log('(every job already had a parseable expected sequence)');
}

function emitFormats(labels, sourceNote) {
  // Format A: numbered Markdown list
  console.log('  -- Format A: numbered list --');
  console.log('  ## Expected sequence');
  for (let i = 0; i < labels.length; i++) {
    console.log(`  ${i + 1}. ${oneLine(labels[i])}`);
  }
  console.log('');

  // Format B: Step N: prefix
  console.log('  -- Format B: Step N: prefix --');
  console.log('  ## Expected sequence');
  for (let i = 0; i < labels.length; i++) {
    console.log(`  Step ${i + 1}: ${oneLine(labels[i])}`);
  }
  console.log('');

  // Format C: arrow chain (only if all labels are short enough for one line)
  if (labels.every((l) => l.length <= 50)) {
    console.log('  -- Format C: arrow chain --');
    const clean = labels.map((l) => oneLine(l).replace(/[,()→]/g, ''));
    console.log(`  expected pipeline: ${clean.join(' → ')}`);
    console.log('');
  } else {
    console.log('  (arrow chain format omitted — labels too long for a one-line chain)');
    console.log('');
  }
}

function pickTemplateLabels(produced, body) {
  if (produced.length >= 2) {
    return {
      labels: produced.map((p) => p.description),
      sourceNote: 'actual produced deliverables (chronological)',
    };
  }
  // (2) section headers
  const headerMatches = [...body.matchAll(/^\s*#+\s+(.+?)\s*$/gm)];
  const headers = headerMatches.map((m) => m[1].trim()).filter((s) => s.length > 0);
  if (headers.length >= 2) {
    return {
      labels: headers,
      sourceNote: `job body's own ## section headers (${headers.length} found)`,
    };
  }
  // (3) first bulleted list
  const bullets = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m) bullets.push(m[1].trim());
    else if (bullets.length >= 2) break;
  }
  if (bullets.length >= 2) {
    return {
      labels: bullets.slice(0, 8),
      sourceNote: `job body's first bulleted list (${Math.min(bullets.length, 8)} items)`,
    };
  }
  // (4) nothing
  return { labels: [], sourceNote: 'placeholders' };
}

db.close();

/* --- inline copies of the parser logic (kept here read-only so the replay
       is independent of @runcor/watchdog's private parsers) --- */

function parseExpectedSequence(body) {
  const cands = [
    parseNumberedList(body),
    parseStepPrefixList(body),
    parseArrowChain(body),
  ];
  let best = [];
  for (const c of cands) if (c.length >= 2 && c.length > best.length) best = c;
  return best;
}

function parseSequentialList(body, re) {
  const matches = [];
  for (const m of body.matchAll(re)) {
    const n = Number(m[1]);
    const label = (m[2] ?? '').trim();
    if (Number.isFinite(n) && label.length > 0) matches.push({ n, label });
  }
  if (matches.length < 2) return [];
  let best = [];
  let current = [];
  let expected = 1;
  for (const m of matches) {
    if (m.n === expected) {
      current.push(m.label);
      expected += 1;
    } else if (m.n === 1) {
      if (current.length > best.length) best = current;
      current = [m.label];
      expected = 2;
    } else {
      if (current.length > best.length) best = current;
      current = [];
      expected = 1;
    }
  }
  if (current.length > best.length) best = current;
  return best.length >= 2 ? best : [];
}

function parseNumberedList(body) {
  return parseSequentialList(body, /^\s*(\d+)[.)]\s+(.+?)\s*$/gm);
}
function parseStepPrefixList(body) {
  return parseSequentialList(body, /^\s*step\s+(\d+)\s*[:.]\s*(.+?)\s*$/gim);
}
function parseArrowChain(body) {
  // Same tightening as the live parser in packages/watchdog/src/index.ts —
  // reject bulleted lines, fragments with commas, and unbalanced parens, all
  // hallmarks of prose using `→` as an annotation rather than a pipeline.
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/->|→/.test(line)) continue;
    if (/^[-*>]\s/.test(line)) continue;
    const parts = line
      .split(/\s*(?:->|→)\s*/)
      .map((p) => p.replace(/[.,;:!?]+$/, '').trim())
      .filter((p) => p.length > 0);
    if (parts.length < 3) continue;
    let dirty = false;
    for (const p of parts) {
      if (p.includes(',')) { dirty = true; break; }
      const opens = (p.match(/\(/g) ?? []).length;
      const closes = (p.match(/\)/g) ?? []).length;
      if (opens !== closes) { dirty = true; break; }
    }
    if (dirty) continue;
    return parts;
  }
  return [];
}

function oneLine(s) {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
function truncate(s, max) {
  const o = oneLine(s);
  return o.length <= max ? o : `${o.slice(0, max - 1)}…`;
}
