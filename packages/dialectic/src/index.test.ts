import { isValidR } from '@runcor/decider';
import { StubBackend, type ModelCallRequest, type RppPrompt } from '@runcor/engine';
import { Trace } from '@runcor/trace';
import { describe, it, expect } from 'vitest';

import { DialecticDecider } from './index.js';

const wrapped = 'TARGET { output: "decide" }\n' as RppPrompt;

function trace() {
  return new Trace({ jsonlPath: null });
}

/* ============================== T165 ============================== */

describe('DialecticDecider depth=1 (T165)', () => {
  it('runs Player → Coach → Judge in order; each produces R++; Judge output is returned', async () => {
    const callsByRole: string[] = [];
    const engine = new StubBackend({
      responder: (req: ModelCallRequest) => {
        // Inspect the prompt suffix to know which role this call is for.
        if (req.prompt.includes('role="player"')) {
          callsByRole.push('player');
          return 'TARGET { output: "player-draft" }';
        }
        if (req.prompt.includes('role="coach"')) {
          callsByRole.push('coach');
          return 'TARGET { output: "coach-critique" }';
        }
        if (req.prompt.includes('role="judge"')) {
          callsByRole.push('judge');
          return 'TARGET { output: "judge-decision" }';
        }
        return 'TARGET { output: "unknown" }';
      },
    });
    const decider = new DialecticDecider({ engine }, { depth: 1 });
    const r = await decider.decide({ prompt: wrapped, cycle: 1, trace: trace() });
    expect(callsByRole).toEqual(['player', 'coach', 'judge']);
    expect(isValidR(r.output)).toBe(true);
    const firstBlock = r.output.ast.blocks[0]!;
    expect((firstBlock as { output: string }).output).toBe('judge-decision');
  });

  it('depth=2 runs Player + 2×Coach + Judge', async () => {
    const calls: string[] = [];
    const engine = new StubBackend({
      responder: (req: ModelCallRequest) => {
        if (req.prompt.includes('role="player"')) {
          calls.push('player');
          return 'TARGET { output: "p" }';
        }
        if (req.prompt.includes('role="coach"')) {
          calls.push('coach');
          return 'TARGET { output: "c" }';
        }
        if (req.prompt.includes('role="judge"')) {
          calls.push('judge');
          return 'TARGET { output: "j" }';
        }
        return 'TARGET { output: "?" }';
      },
    });
    const decider = new DialecticDecider({ engine }, { depth: 2 });
    await decider.decide({ prompt: wrapped, cycle: 1, trace: trace() });
    expect(calls.filter((c) => c === 'coach')).toHaveLength(2);
    expect(calls).toEqual(['player', 'coach', 'coach', 'judge']);
  });

  it('depth=0 falls through to SingleModelDecider', async () => {
    let calls = 0;
    const engine = new StubBackend({
      responder: () => {
        calls += 1;
        return 'TARGET { output: "x" }';
      },
    });
    const decider = new DialecticDecider({ engine }, { depth: 0 });
    await decider.decide({ prompt: wrapped, cycle: 1, trace: trace() });
    expect(calls).toBe(1);
  });

  it('throws DeciderError on invalid Player output', async () => {
    const engine = new StubBackend({
      responder: (req: ModelCallRequest) => {
        if (req.prompt.includes('role="player"')) return 'invalid';
        return 'TARGET { output: "x" }';
      },
    });
    const decider = new DialecticDecider({ engine }, { depth: 1 });
    await expect(decider.decide({ prompt: wrapped, cycle: 1, trace: trace() })).rejects.toThrow(
      /dialectic player/,
    );
  });

  it('records a dialectic-summary trace entry on success', async () => {
    const engine = new StubBackend({
      responder: () => 'TARGET { output: "x" }',
    });
    const tr = trace();
    const decider = new DialecticDecider({ engine }, { depth: 1 });
    await decider.decide({ prompt: wrapped, cycle: 1, trace: tr });
    const entry = tr.filter(
      (e) =>
        e.kind === 'operator' &&
        Boolean((e as { detail?: string }).detail?.includes('decider=dialectic')),
    );
    expect(entry).toHaveLength(1);
  });
});
