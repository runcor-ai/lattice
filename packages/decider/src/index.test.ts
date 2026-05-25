import { StubBackend, type RppPrompt } from '@runcor/engine';
import { Trace } from '@runcor/trace';
import { describe, it, expect } from 'vitest';

import { DeciderError, isValidR, SingleModelDecider, selectDecider } from './index.js';

const wrapped = 'TARGET { output: "noop" }\n' as RppPrompt;

function trace() {
  return new Trace({ jsonlPath: null });
}

/* ============================== T164 ============================== */

describe('SingleModelDecider (T164 / FR-024)', () => {
  it('returns a parser-validated R++ ParseResult on first attempt', async () => {
    const decider = new SingleModelDecider({ engine: new StubBackend() });
    const r = await decider.decide({
      prompt: wrapped,
      cycle: 1,
      trace: trace(),
      maxTokens: 256,
    });
    expect(isValidR(r.output)).toBe(true);
    expect(r.output.ast.blocks.length).toBeGreaterThan(0);
    expect(r.usage.input).toBeGreaterThan(0);
    expect(r.usage.output).toBeGreaterThan(0);
  });

  it('retries up to 2 times when the response fails parsing; trace records retries', async () => {
    let calls = 0;
    const flaky = new StubBackend({
      responder: () => {
        calls += 1;
        if (calls < 3) return 'this is not r++';
        return 'TARGET { output: "x" }';
      },
    });
    const tr = trace();
    const decider = new SingleModelDecider({ engine: flaky });
    const r = await decider.decide({ prompt: wrapped, cycle: 1, trace: tr });
    expect(calls).toBe(3);
    expect(isValidR(r.output)).toBe(true);

    const retryEntries = tr.filter(
      (e) =>
        e.kind === 'operator' &&
        (e as { action: string }).action === 'lifecycle' &&
        Boolean((e as { detail?: string }).detail?.includes('decider=single-model retry')),
    );
    expect(retryEntries).toHaveLength(2);
  });

  it('throws DeciderError(parse_failure) when all retries fail', async () => {
    const broken = new StubBackend({ responder: () => 'still not r++' });
    const decider = new SingleModelDecider({ engine: broken });
    let caught: unknown;
    try {
      await decider.decide({ prompt: wrapped, cycle: 1, trace: trace() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeciderError);
    expect((caught as DeciderError).kind).toBe('parse_failure');
  });

  it('respects maxRetries option', async () => {
    let calls = 0;
    const broken = new StubBackend({
      responder: () => {
        calls += 1;
        return 'not r++';
      },
    });
    const decider = new SingleModelDecider({ engine: broken }, { maxRetries: 0 });
    try {
      await decider.decide({ prompt: wrapped, cycle: 1, trace: trace() });
    } catch {
      /* expected */
    }
    expect(calls).toBe(1);
  });
});

/* ============================== T166 ============================== */

describe('selectDecider — factory dispatch (T166 / Bridge dial)', () => {
  it('dialecticDepth=0 returns SingleModelDecider', () => {
    const d = selectDecider({ engine: new StubBackend() }, { dialecticDepth: 0 });
    expect(d.name).toBe('single-model');
  });

  it('dialecticDepth>=1 requires a buildDialectic factory', () => {
    expect(() =>
      selectDecider({ engine: new StubBackend() }, { dialecticDepth: 2 }),
    ).toThrow(/no buildDialectic factory/);
  });

  it('dialecticDepth>=1 with a factory returns the dialectic decider', () => {
    let built = false;
    const fakeDialectic = {
      name: 'fake-dialectic',
      async decide(): Promise<never> {
        throw new Error('not invoked');
      },
    };
    const d = selectDecider(
      { engine: new StubBackend() },
      {
        dialecticDepth: 2,
        buildDialectic: (_deps, depth) => {
          built = true;
          expect(depth).toBe(2);
          return fakeDialectic;
        },
      },
    );
    expect(built).toBe(true);
    expect(d.name).toBe('fake-dialectic');
  });
});
