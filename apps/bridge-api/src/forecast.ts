// Forecast/predictions reader — parses the field-intel forecast ledger (the
// baseline standing calls + each dated forecast cycle's adjudications) into a
// shape an industry/marketing analyst can read: current calls, confidence,
// leading indicators (what would flip a call), revisions, and the call's
// evolution over time. Pure read; the lattice owns the files, this only reflects.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LAYERS = ['MODELS', 'ORCHESTRATION', 'PROTOCOLS', 'VERTICAL APPS', 'INFRA', 'FUNDING SIGNAL'];

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

function field(body: string, name: string): string | null {
  const m = body.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'mi'));
  return m?.[1] ? m[1].trim() : null;
}

function parseCycle(file: string, text: string): ForecastCycle {
  const tsMatch = file.match(/cycle-(\d+)\.md/);
  const ts = tsMatch ? Number(tsMatch[1]) : 0;
  const firstBlock = text.indexOf('\n### ');
  const head = (firstBlock >= 0 ? text.slice(0, firstBlock) : text);
  const summary = head.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ').trim().slice(0, 600);

  const re = /^###\s+(REVISED|HELD-CAVEAT|HELD)\s*:\s*(.+?)\s*$/gm;
  const matches = [...text.matchAll(re)];
  const calls: ForecastCall[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const status = m[1] as CallStatus;
    const layer = (m[2] ?? '').trim().toUpperCase();
    const start = (m.index ?? 0) + m[0].length;
    const next = matches[i + 1];
    const end = next ? (next.index ?? text.length) : text.length;
    const body = text.slice(start, end);
    calls.push({
      layer,
      status,
      confidence: field(body, 'confidence'),
      claim: status === 'REVISED' ? field(body, 'new') : status === 'HELD-CAVEAT' ? field(body, 'held') : field(body, 'cite'),
      prior: field(body, 'prior'),
      signal: field(body, 'signal') ?? field(body, 'watching'),
      watching: field(body, 'watching'),
      whyNotYet: field(body, 'why_not_yet'),
      wouldFlip: field(body, 'would_flip'),
      killConditionMet: field(body, 'kill_condition_met'),
      why: field(body, 'why'),
    });
  }
  return { file, ts, iso: new Date(ts).toISOString(), summary, calls };
}

function parseBaseline(text: string): { thesis: ForecastReport['thesis']; calls: BaselineCall[] } {
  const betM = text.match(/Bet:\s*\*\*(.+?)\*\*/i) ?? text.match(/Bet:\s*(.+)/i);
  const bet = betM ? (betM[1] ?? '').replace(/\*\*/g, '').trim() : null;
  const cpM = text.match(/##\s*Central problem\s*\n+([\s\S]+?)(?:\n\n|##)/i);
  const central = cpM?.[1] ? cpM[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() : null;
  const horM = text.match(/(\d{2})-month horizon/i);
  const horizon = horM?.[1] ? `${horM[1]}-month horizon` : null;

  const calls: BaselineCall[] = [];
  for (const seg of text.split(/\n(?=\d+\.\s+\*\*)/)) {
    const m = seg.match(/^\d+\.\s+\*\*([A-Z ]+?)\s*[—-]\s*(.+?)\*\*\s*([\s\S]*)/);
    if (!m) continue;
    const layer = (m[1] ?? '').trim().toUpperCase();
    if (!LAYERS.includes(layer)) continue;
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

export function readForecastReport(opts: { limitCycles?: number } = {}): ForecastReport {
  const dir = ledgerDir();
  const fdir = join(dir, 'forecast');
  if (!existsSync(fdir)) return emptyReport();

  // baseline
  let thesis: ForecastReport['thesis'] = { central: null, bet: null, horizon: null };
  let baseline: BaselineCall[] = [];
  try {
    const bpath = join(dir, 'baseline.md');
    if (existsSync(bpath)) {
      const parsed = parseBaseline(readFileSync(bpath, 'utf8'));
      thesis = parsed.thesis;
      baseline = parsed.calls;
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

  if (cycles.length === 0) {
    return { ...emptyReport(), available: baseline.length > 0, thesis, baseline };
  }

  // current = latest cycle, enriched with baseline context; ensure all layers present
  const latest = cycles[0]!;
  const latestByLayer = new Map(latest.calls.map((c) => [c.layer, c]));
  const order = LAYERS.filter((l) => latestByLayer.has(l) || baseByLayer.has(l));
  const current: CurrentCall[] = order.map((layer) => {
    const c = latestByLayer.get(layer);
    const b = baseByLayer.get(layer);
    const base = {
      headline: b?.headline ?? null,
      prediction: b?.prediction ?? null,
      killCondition: b?.killCondition ?? null,
      baselineConfidence: b?.confidence ?? null,
    };
    if (c) return { ...c, ...base };
    // layer absent from latest cycle — represent from baseline as a standing HELD
    return {
      layer, status: 'HELD', confidence: b?.confidence ?? null, claim: b?.headline ?? null,
      prior: null, signal: null, watching: null, whyNotYet: null, wouldFlip: null, killConditionMet: null, why: null,
      ...base,
    };
  });

  // leading indicators — drawn from current caveats (what an analyst should monitor)
  const watchlist = current
    .filter((c) => c.status === 'HELD-CAVEAT')
    .map((c) => ({ layer: c.layer, wouldFlip: c.wouldFlip, watching: c.watching, whyNotYet: c.whyNotYet, confidence: c.confidence }));

  // revisions across the recent window
  const revisions = cycles
    .flatMap((cy) => cy.calls.filter((c) => c.status === 'REVISED').map((c) => ({ ...c, iso: cy.iso })))
    .slice(0, 30);

  // per-layer evolution (oldest→newest)
  const timeline: ForecastReport['timeline'] = {};
  for (const layer of LAYERS) {
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
