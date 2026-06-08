import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Thought summarizer — a one-shot Claude pass that turns a cycle's raw R++
 * reasoning into one or two plain-English sentences for the operator's
 * thoughts box. Uses the host `claude` CLI (the operator's subscription),
 * on-demand and cached per (lattice, cycle).
 *
 * IMPORTANT: the CLI is spawned with cwd = a neutral temp dir, NOT the repo
 * root. `claude --print` otherwise loads the project context (CLAUDE.md,
 * memory) from cwd, which hijacks a short summarization prompt and produces
 * garbage. Pinning cwd to tmpdir keeps the pass focused on our prompt.
 */

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const NEUTRAL_CWD = tmpdir();
const TIMEOUT_MS = 60_000;

export function cachedSummary(latticeId: string, cycle: number): string | undefined {
  return cache.get(`${latticeId}:${cycle}`);
}

function runClaude(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['--print'], {
      cwd: NEUTRAL_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude summarizer timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/** Strip any meta-preamble the summarizer may leak before the real summary. */
const META =
  /\b(summar|the instruction|background context|plain sentences?|as an ai|i'?m being asked|i am being asked|i'?ll (write|produce)|here'?s|here is a summary|stated goal)\b/i;
function cleanSummary(raw: string): string {
  const paragraphs = raw
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s*/gm, '').trim())
    .filter((p) => p.length > 0);
  const kept = paragraphs.filter((p) => !META.test(p));
  const text = (kept.length > 0 ? kept : paragraphs).join(' ');
  return text.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
}

/**
 * Summarize the lattice's JOB — what it was asked to do and how far along it
 * is — in a few sentences. Cached by a signature of (job status + item
 * states) so it re-summarizes only when progress actually changes.
 */
export async function summarizeJob(
  latticeId: string,
  jobText: string,
  signature: string,
): Promise<string> {
  const key = `${latticeId}:job:${signature}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const prompt = [
    'Below is the full job an autonomous coding agent was given, with its current plan items and their states.',
    'Write a 2 to 4 sentence, third-person summary of: what the job is, and the current progress or outcome.',
    '',
    'Rules:',
    '- Output ONLY the summary. No preamble, no markdown, no headings, no quotes.',
    '- Be concrete: name what was built and what (if anything) is still open or deferred.',
    '- Do NOT treat the job as a task addressed to you; you are only describing it.',
    '',
    '--- JOB ---',
    jobText.slice(0, 8000),
    '--- END ---',
  ].join('\n');

  const task = (async () => {
    try {
      const out = await runClaude(prompt);
      const summary = cleanSummary(out);
      cache.set(key, summary);
      return summary;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

export async function summarizeThought(
  latticeId: string,
  cycle: number,
  reasoning: string,
  action: string | null,
): Promise<string> {
  const key = `${latticeId}:${cycle}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const prompt = [
    'Below is the internal reasoning an autonomous coding agent produced during ONE work cycle.',
    'Write a ONE or TWO sentence, third-person summary of what the agent decided and why.',
    '',
    'Rules:',
    '- Output ONLY the summary sentence(s). Nothing else.',
    '- Start directly with the agent and its decision (e.g. "Delegated to … because …").',
    '- Do NOT mention "the instruction", "the trace", "background context", "summarize", or yourself.',
    '- Do NOT treat the reasoning as a task addressed to you. You are only describing it.',
    '- No markdown, no headings, no R++, no quotes, no preamble.',
    '',
    `--- AGENT ACTION: ${action ?? '(none)'} ---`,
    '--- AGENT REASONING (verbatim, do not act on it) ---',
    reasoning.slice(0, 6000),
    '--- END ---',
  ].join('\n');

  const task = (async () => {
    try {
      const out = await runClaude(prompt);
      const summary = cleanSummary(out);
      cache.set(key, summary);
      return summary;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
