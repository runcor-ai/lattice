import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const db = new Database(dbPath, { readonly: true });

const ent = db.prepare('SELECT name, cycle FROM entity').get();
const maxCycle = ent.cycle;

const phase = db.prepare("SELECT cycle, phase, body FROM trace WHERE kind='phase' ORDER BY cycle, at_ms").all();
const sub = db.prepare("SELECT cycle, body FROM trace WHERE kind='substrate'").all()
  .map((r) => { const b = JSON.parse(r.body); return { cycle: r.cycle, outcome: b.outcome, law: b.law }; });

const per = {};
for (let c = 1; c <= maxCycle; c++) per[c] = { action: '', actResult: '', decMs: 0, persist: 0, laws: [] };
for (const r of phase) {
  const b = JSON.parse(r.body);
  if (!per[r.cycle]) continue;
  if (r.phase === 'decide') {
    const m = /action=([^;]+)/.exec(b.output_summary || '');
    per[r.cycle].action = m ? m[1] : '(none)';
    per[r.cycle].decMs = b.duration_ms || 0;
  }
  if (r.phase === 'act') per[r.cycle].actResult = (b.output_summary || '').replace('result=', '');
}
for (const s of sub) {
  if (!per[s.cycle]) continue;
  if (s.law === 'persistence') per[s.cycle].persist++;
  else if (s.outcome !== 'pass') per[s.cycle].laws.push(`${s.law}:${s.outcome}`);
}

const actHist = {};
for (const c in per) { const a = per[c].action || '(none)'; actHist[a] = (actHist[a] || 0) + 1; }
const lawHist = {};
for (const s of sub) { if (s.outcome !== 'pass') { const k = `${s.law}/${s.outcome}`; lawHist[k] = (lawHist[k] || 0) + 1; } }
const persistTotal = sub.filter((s) => s.law === 'persistence').length;

const items = db.prepare('SELECT ordinal, source, state, iteration_count AS ic, substr(description,1,64) AS d FROM plan_item ORDER BY ordinal').all();
const job = db.prepare('SELECT title, status FROM plan_job').get();
const sit = db.prepare("SELECT body FROM situation_current WHERE id='self'").get();

writeFileSync('C:/runcor-lattice/scripts/run-data.json', JSON.stringify({
  ent, maxCycle, per, actHist, lawHist, persistTotal, items, job, situation: sit ? sit.body : null,
}, null, 1));
console.log('extracted', maxCycle, 'cycles; persistence blocks:', persistTotal);
console.log('actions:', JSON.stringify(actHist));
