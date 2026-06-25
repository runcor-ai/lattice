// Forecast/predictions reader — parses the field-intel forecast ledger (the
// baseline standing calls + each dated forecast cycle's adjudications) into a
// shape an industry/marketing analyst can read: current calls, confidence,
// leading indicators (what would flip a call), revisions, and the call's
// evolution over time. Pure read; the lattice owns the files, this only reflects.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';


export type CallStatus = 'HELD' | 'HELD-CAVEAT' | 'REVISED';

export interface ForecastCall {
  layer: string;
  status: CallStatus;
  confidence: string | null;
  claim: string | null; // the operative one-liner (revised:new / caveat:held / held:cite)
  prior: string | null; // revised only — the claim being replaced
  signal: string | null; // cited signal file (revised:signal / caveat:watching)
  watching: string | null; // caveat — the emerging signal pressuring the call
  whyNotYet: string | null; // caveat — why the kill-condition is not yet met
  wouldFlip: string | null; // caveat — the leading indicator that would change the call
  killConditionMet: string | null; // caveat — yes/no
  why: string | null; // revised — the kill-condition the new signal met
  forecastBy: string | null; // the predictive date — by when this call should resolve (forecast-by: YYYY-MM-DD)
  basis: string | null; // the current signal/evidence the forward prediction rests on
}

export interface ForecastCycle {
  file: string;
  ts: number;
  iso: string;
  summary: string;
  calls: ForecastCall[];
}

export interface BaselineCall {
  layer: string;
  headline: string;
  prediction: string;
  confidence: string | null;
  killCondition: string | null;
}

export interface CurrentCall extends ForecastCall {
  headline: string | null; // from baseline
  prediction: string | null; // from baseline (dated, falsifiable)
  killCondition: string | null; // from baseline
  baselineConfidence: string | null; // standing confidence (used when a HELD carries none)
}

export interface ForecastReport {
  generatedAt: string;
  available: boolean;
  thesis: { central: string | null; bet: string | null; horizon: string | null };
  baseline: BaselineCall[];
  current: CurrentCall[];
  currentAsOf: string | null;
  watchlist: Array<{
    layer: string;
    wouldFlip: string | null;
    watching: string | null;
    whyNotYet: string | null;
    confidence: string | null;
  }>;
  revisions: Array<ForecastCall & { iso: string }>;
  timeline: Record<string, Array<{ iso: string; ts: number; status: CallStatus; confidence: string | null }>>;
  cycles: ForecastCycle[];
  counts: { cycles: number; held: number; caveat: number; revised: number };
}

function ledgerDir(): string {
  return process.env.RUNCOR_FORECAST_LEDGER ?? join(process.cwd(), '..', 'field-intel', 'ledger');
}

// Normalize a cycle's call label to the canonical baseline layer: strip "(CALL n)" suffixes
// and fold abbreviations into the matching baseline layer (e.g. FUNDING → FUNDING SIGNAL),
// so label drift across cycles doesn't spawn phantom/duplicate calls.
function canonLayer(raw: string, baseLayers: string[]): string {
  const s = raw.replace(/\s*\(.*?\)\s*$/, '').trim().toUpperCase();
  if (baseLayers.includes(s)) return s;
  return baseLayers.find((b) => b === s || b.startsWith(s) || s.startsWith(b)) ?? s;
}

// Display-layer dedup. The front-end generator is generic code; the lattice may honestly emit two
// calls that are really the same node (e.g. two SELF self-architecture calls, or a call rephrased).
// We collapse those for a clean view — the underlying map is left exactly as the entity wrote it.
// Genuinely distinct developments that merely share a layer prefix (two different MODELS events) are
// kept; they are not duplicates.
function dedupKey(s: string | null): Set<string> {
  return new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function dedupJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
function nodeLabel(layer: string): string {
  return (layer.split(/\s*[—–:-]\s*/)[0] ?? layer).trim().toUpperCase();
}
function dedupeCurrent<T extends CurrentCall>(calls: T[]): T[] {
  const out: T[] = [];
  for (const c of calls) {
    const label = nodeLabel(c.layer);
    const cw = dedupKey(`${c.layer} ${c.claim ?? c.headline ?? ''}`);
    const dup = out.find((o) => {
      // SELF is a singleton node — one self-architecture call; collapse any extras.
      if (label === 'SELF' && nodeLabel(o.layer) === 'SELF') return true;
      // otherwise only collapse a near-identical call (the same call rephrased), never a distinct one.
      return dedupJaccard(cw, dedupKey(`${o.layer} ${o.claim ?? o.headline ?? ''}`)) >= 0.72;
    });
    if (!dup) out.push(c); // keep the first occurrence
  }
  return out;
}

function field(body: string, name: string): string | null {
  // Tolerate a leading bullet/quote marker — entities write "- held: x" as often as "held: x".
  const m = body.match(new RegExp(`^[\\s>*-]*${name}\\s*:\\s*(.+)$`, 'mi'));
  return m?.[1] ? m[1].trim() : null;
}

// Robust-to-format: parse ANY "### <LABEL>: <name>" block that carries a call-field signature
// (held/claim/cite/would_flip/kill_condition/confidence/watching) into a call — regardless of the
// verb the entity chose. Entities have used HELD-CAVEAT, HELD, REVISED, and CALL; the label is
// normalized to the three display statuses rather than whitelisted. The block-field filter keeps
// prose sub-sections (e.g. "### Discipline note") from being mistaken for calls.
const CALL_FIELD_RE = /^[\s>*-]*(held|claim|cite|new|would_flip|kill_condition|kill_condition_met|confidence|watching|connecting_step|development)\s*:/im;
function normalizeStatus(rawLabel: string): CallStatus {
  // Detect the status verb ANYWHERE in the (possibly compound) header — entities write
  // "HELD-CAVEAT", "NEW / HELD-CAVEAT", "REVISED", "NEW", "CALL", etc. Caveat is checked first.
  const s = rawLabel.toUpperCase();
  if (/HELD[-_\s]*CAVEAT|CAVEAT/.test(s)) return 'HELD-CAVEAT';
  if (/REVIS|KILL|BROKEN/.test(s)) return 'REVISED';
  return 'HELD'; // HELD, CALL, NEW, and any other forward/standing call
}
function parseBlocks(text: string): ForecastCall[] {
  // Header is everything up to the first colon (may be a compound status like "NEW / HELD-CAVEAT");
  // the call-field-signature filter below excludes prose "### " sub-sections.
  const re = /^###\s+(.+?)\s*:\s*(.+?)\s*$/gm;
  const matches = [...text.matchAll(re)];
  const calls: ForecastCall[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const start = (m.index ?? 0) + m[0].length;
    const next = matches[i + 1];
    const end = next ? (next.index ?? text.length) : text.length;
    const body = text.slice(start, end);
    if (!CALL_FIELD_RE.test(body)) continue; // not a call block (e.g. a prose sub-section)
    const status = normalizeStatus(m[1] ?? '');
    // Strip a leading "Cn —"/"Cn:" enumerator; if that leaves nothing (header was just "C2"),
    // keep the enumerator as the layer label.
    const rawLabel = (m[2] ?? '').trim();
    const stripped = rawLabel.replace(/^C\d+\b\s*[—–:.)-]*\s*/i, '').trim();
    const layer = (stripped || rawLabel).toUpperCase();
    // The claim text: prefer a substantive `held`/`new`, but if the entity wrote a bare boolean
    // (`held: yes`) skip it and use the real `claim:` field underneath.
    const heldRaw = field(body, 'held');
    const heldClaim = heldRaw && !/^(yes|no|true|false|n\/a)\b/i.test(heldRaw.trim()) ? heldRaw : null;
    calls.push({
      layer,
      status,
      confidence: field(body, 'confidence'),
      claim: heldClaim ?? field(body, 'claim') ?? field(body, 'new') ?? field(body, 'cite') ?? heldRaw,
      prior: field(body, 'prior'),
      signal: field(body, 'signal') ?? field(body, 'watching') ?? field(body, 'development'),
      watching: field(body, 'watching'),
      whyNotYet: field(body, 'why_not_yet') ?? field(body, 'connecting_step'),
      wouldFlip: field(body, 'would_flip') ?? field(body, 'kill_condition'),
      killConditionMet: field(body, 'kill_condition_met'),
      why: field(body, 'why'),
      forecastBy: field(body, 'forecast-by') ?? field(body, 'forecast_by') ?? field(body, 'forecast-for') ?? field(body, 'horizon'),
      basis: field(body, 'basis') ?? field(body, 'observable'),
    });
  }
  return calls;
}

function parseCycle(file: string, text: string): ForecastCycle {
  const tsMatch = file.match(/cycle-(\d+)\.md/);
  const ts = tsMatch ? Number(tsMatch[1]) : 0;
  const firstBlock = text.indexOf('\n### ');
  const head = (firstBlock >= 0 ? text.slice(0, firstBlock) : text);
  const summary = head.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ').trim().slice(0, 600);
  return { file, ts, iso: new Date(ts).toISOString(), summary, calls: parseBlocks(text) };
}

function parseBaseline(text: string): { thesis: ForecastReport['thesis']; calls: BaselineCall[] } {
  const betM = text.match(/Bet:\s*\*\*(.+?)\*\*/i) ?? text.match(/Bet:\s*(.+)/i);
  const bet = betM ? (betM[1] ?? '').replace(/\*\*/g, '').trim() : null;
  const cpM = text.match(/##\s*Central problem\s*\n+([\s\S]+?)(?:\n\n|##)/i)
    ?? text.match(/##\s*Thesis\s*\n+([\s\S]+?)(?:\n\n|\n##)/i)
    ?? text.match(/^\s*Thesis:\s*([\s\S]+?)(?:\n\n|\n##|\n###)/im); // inline "Thesis: ..." form
  const central = cpM?.[1] ? cpM[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 800) : null;
  const horM = text.match(/(\d{2})-month horizon/i);
  const horizon = horM?.[1] ? `${horM[1]}-month horizon` : null;

  const calls: BaselineCall[] = [];
  for (const seg of text.split(/\n(?=\d+\.\s+\*\*)/)) {
    // Domain-agnostic: layer label = everything before the em/en-dash separator (so labels
    // with internal hyphens/slashes/digits like EU/HIGH-RISK or ISO-42001 parse correctly).
    // Accept any call label, not just the AI stack layers.
    const m = seg.match(/^\d+\.\s+\*\*([^—–]+?)\s*[—–]\s*(.+?)\*\*\s*([\s\S]*)/);
    if (!m) continue;
    const layer = (m[1] ?? '').trim().toUpperCase();
    if (!layer) continue;
    const headline = (m[2] ?? '').trim();
    const rest = (m[3] ?? '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const conf = rest.match(/Confidence:\s*([A-Za-z-]+)/i);
    const kill = rest.match(/Kill-condition:\s*(.+?)\s*$/i);
    const prediction = (rest.split(/Confidence:/i)[0] ?? '').trim();
    calls.push({
      layer,
      headline,
      prediction,
      confidence: conf?.[1] ?? null,
      killCondition: kill?.[1]?.trim() ?? null,
    });
  }
  return { thesis: { central, bet, horizon }, calls };
}

function emptyReport(): ForecastReport {
  return {
    generatedAt: new Date().toISOString(),
    available: false,
    thesis: { central: null, bet: null, horizon: null },
    baseline: [],
    current: [],
    currentAsOf: null,
    watchlist: [],
    revisions: [],
    timeline: {},
    cycles: [],
    counts: { cycles: 0, held: 0, caveat: 0, revised: 0 },
  };
}

export function readForecastReport(opts: { ledgerDir?: string; limitCycles?: number } = {}): ForecastReport {
  const dir = opts.ledgerDir ?? ledgerDir();
  const fdir = join(dir, 'forecast');
  if (!existsSync(fdir)) return emptyReport();

  // baseline
  let thesis: ForecastReport['thesis'] = { central: null, bet: null, horizon: null };
  let baseline: BaselineCall[] = [];
  let baselineBlocks: ForecastCall[] = [];
  try {
    const bpath = join(dir, 'baseline.md');
    if (existsSync(bpath)) {
      const btext = readFileSync(bpath, 'utf8');
      const parsed = parseBaseline(btext);
      thesis = parsed.thesis;
      baseline = parsed.calls;
      // The entity often writes its baseline in the same "### HELD-CAVEAT: <label>" block form
      // as a forecast cycle, not the numbered "1. **LAYER —**" form. Accept both: when the
      // numbered parse found nothing, derive the baseline calls from the blocks.
      baselineBlocks = parseBlocks(btext);
      if (baseline.length === 0 && baselineBlocks.length) {
        baseline = baselineBlocks.map((c) => ({
          layer: c.layer,
          headline: c.claim ?? c.layer,
          prediction: c.claim ?? '',
          confidence: c.confidence,
          killCondition: c.wouldFlip ?? c.whyNotYet ?? null,
        }));
      }
    }
  } catch { /* baseline optional */ }
  const baseByLayer = new Map(baseline.map((b) => [b.layer, b]));

  // cycles
  let cycles: ForecastCycle[] = [];
  try {
    const files = readdirSync(fdir).filter((f) => /^cycle-\d+\.md$/.test(f));
    cycles = files
      .map((f) => {
        try { return parseCycle(f, readFileSync(join(fdir, f), 'utf8')); } catch { return null; }
      })
      .filter((c): c is ForecastCycle => !!c && c.calls.length > 0)
      .sort((a, b) => b.ts - a.ts);
  } catch { return emptyReport(); }

  // Fold cycle label drift into the canonical baseline layers — the entity sometimes writes
  // "FUNDING" or "FUNDING (CALL 6)" instead of "FUNDING SIGNAL"; without this each variant
  // became a phantom/duplicate call (empty, no baseline behind it) in the display.
  const baseLayers = baseline.map((b) => b.layer);
  if (baseLayers.length) for (const cy of cycles) for (const c of cy.calls) c.layer = canonLayer(c.layer, baseLayers);

  if (cycles.length === 0) {
    // No adjudication cycles yet — the baseline IS the standing forecast. Surface its calls
    // as `current` so the page shows them rather than appearing empty. When the baseline was
    // written in block form, carry each call's real status (HELD-CAVEAT/HELD/REVISED) and its
    // watching/would-flip detail; otherwise fall back to a standing HELD from the numbered form.
    const currentRaw: CurrentCall[] = baselineBlocks.length
      ? baselineBlocks.map((c) => {
          const b = baseByLayer.get(c.layer);
          return {
            ...c,
            headline: b?.headline ?? c.claim,
            prediction: b?.prediction ?? c.claim,
            killCondition: b?.killCondition ?? c.wouldFlip ?? null,
            baselineConfidence: b?.confidence ?? c.confidence,
          };
        })
      : baseline.map((b) => ({
          layer: b.layer, status: 'HELD' as CallStatus, confidence: b.confidence, claim: b.headline,
          prior: null, signal: null, watching: null, whyNotYet: null, wouldFlip: null, killConditionMet: null, why: null, forecastBy: null, basis: null,
          headline: b.headline, prediction: b.prediction, killCondition: b.killCondition, baselineConfidence: b.confidence,
        }));
    const current = dedupeCurrent(currentRaw);
    return {
      ...emptyReport(), available: baseline.length > 0, thesis, baseline, current,
      counts: {
        cycles: 0,
        held: current.filter((c) => c.status === 'HELD').length,
        caveat: current.filter((c) => c.status === 'HELD-CAVEAT').length,
        revised: current.filter((c) => c.status === 'REVISED').length,
      },
    };
  }

  // current = the LATEST cycle's calls only. The entity re-emits ALL its standing calls every
  // cycle, so the latest cycle IS the complete current set; enrich each with baseline context by
  // exact-layer match where available. We do NOT union in the baseline's own layers — that
  // double-lists any call whose label drifted between the baseline and the cycle (and a genuinely
  // new call, e.g. a freshly-reasoned C2, appears here straight from the latest cycle).
  const latest = cycles[0]!;
  const currentRaw: CurrentCall[] = latest.calls.map((c) => {
    const b = baseByLayer.get(c.layer);
    return {
      ...c,
      headline: b?.headline ?? c.claim,
      prediction: b?.prediction ?? null,
      killCondition: b?.killCondition ?? c.wouldFlip ?? null,
      baselineConfidence: b?.confidence ?? c.confidence,
    };
  });
  const current = dedupeCurrent(currentRaw);

  // leading indicators — drawn from current caveats (what an analyst should monitor)
  const watchlist = current
    .filter((c) => c.status === 'HELD-CAVEAT')
    .map((c) => ({ layer: c.layer, wouldFlip: c.wouldFlip, watching: c.watching, whyNotYet: c.whyNotYet, confidence: c.confidence }));

  // revisions across the recent window
  const revisions = cycles
    .flatMap((cy) => cy.calls.filter((c) => c.status === 'REVISED').map((c) => ({ ...c, iso: cy.iso })))
    .slice(0, 30);

  // per-layer evolution (oldest→newest) — over every layer actually seen
  const timeline: ForecastReport['timeline'] = {};
  const allLayers = [...new Set([...baseline.map((b) => b.layer), ...cycles.flatMap((cy) => cy.calls.map((c) => c.layer))])];
  for (const layer of allLayers) {
    const pts = cycles
      .filter((cy) => cy.calls.some((c) => c.layer === layer))
      .map((cy) => {
        const c = cy.calls.find((x) => x.layer === layer)!;
        return { iso: cy.iso, ts: cy.ts, status: c.status, confidence: c.confidence };
      })
      .sort((a, b) => a.ts - b.ts);
    if (pts.length) timeline[layer] = pts;
  }

  const allCalls = cycles.flatMap((c) => c.calls);
  const counts = {
    cycles: cycles.length,
    held: allCalls.filter((c) => c.status === 'HELD').length,
    caveat: allCalls.filter((c) => c.status === 'HELD-CAVEAT').length,
    revised: allCalls.filter((c) => c.status === 'REVISED').length,
  };

  const limit = opts.limitCycles ?? 25;
  return {
    generatedAt: new Date().toISOString(),
    available: true,
    thesis,
    baseline,
    current,
    currentAsOf: latest.iso,
    watchlist,
    revisions,
    timeline,
    cycles: cycles.slice(0, limit),
    counts,
  };
}
