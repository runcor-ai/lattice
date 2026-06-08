import { describe, it, expect } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

import CycleEngine from './components/lenses/CycleEngine.vue';
import LivingSystem from './components/lenses/LivingSystem.vue';
import OrchestrationBoard from './components/lenses/OrchestrationBoard.vue';
import type { CycleFrame } from './frameModel.js';
import { Playback } from './playback.js';

// SSR render — no DOM, no @vue/test-utils. Asserts each lens renders a frame
// without throwing and surfaces the key state in its output.

function frame(over: Partial<CycleFrame['components']> = {}): CycleFrame {
  return {
    cycle: 23,
    phases: [
      { phase: 'observe', status: 'ok', rowId: 1 },
      { phase: 'ground', status: 'ok', rowId: 2 },
      { phase: 'recall', status: 'ok', rowId: 3 },
      { phase: 'decide', status: 'ok', rowId: 4 },
      { phase: 'act', status: 'failed', rowId: 5 },
      { phase: 'judge', status: 'ok', rowId: 6 },
      { phase: 'write', status: 'ok', rowId: 7 },
      { phase: 'pulse', status: 'ok', rowId: 8 },
    ],
    components: {
      senses: { count: 2, status: 'active' },
      decide: { action: 'workspace', blocks: 1, status: 'active' },
      dispatch: { action: 'workspace', result: 'failed', blockedBy: 'no-progress', status: 'blocked' },
      gates: [],
      items: [],
      substrate: [{ law: 'no-progress', outcome: 'block', phase: 'act', reason: 'stalled', rowId: 9 }],
      memory: { writes: 0, status: 'idle' },
      clocks: { fast: true, medium: false, slow: false },
      delegate: null,
      ...over,
    },
    transitions: [{ kind: 'substrate-fired', label: 'no-progress: block', rowId: 9 }],
    rowIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  };
}

async function render(comp: unknown, f: CycleFrame | null) {
  const pb = new Playback({ now: () => 0, raf: () => 0, caf: () => {} });
  pb.setRange(1, 56);
  pb.seek(23, 4);
  const app = createSSRApp({
    render: () => h(comp as never, { frame: f, playback: pb.snapshot() }),
  });
  return renderToString(app);
}

const lenses: [string, unknown][] = [
  ['OrchestrationBoard', OrchestrationBoard],
  ['CycleEngine', CycleEngine],
  ['LivingSystem', LivingSystem],
];

describe('lenses — render a blocked frame without throwing', () => {
  for (const [name, comp] of lenses) {
    it(`${name} renders an svg and shows the blocked dispatch`, async () => {
      const html = await render(comp, frame());
      expect(html).toContain('<svg');
      // The stalled action appears in every lens.
      expect(html).toContain('workspace');
    });

    it(`${name} renders a null frame (empty state) without throwing`, async () => {
      const html = await render(comp, null);
      expect(html).toContain('<svg');
    });
  }
});

describe('lenses — the stuck-loop tells (legibility)', () => {
  it('Board shows COLD delegate and BLOCKED dispatch', async () => {
    const html = await render(OrchestrationBoard, frame());
    expect(html).toContain('COLD');
    expect(html).toContain('BLOCKED');
  });

  it('a delegating frame is NOT cold', async () => {
    const html = await render(
      OrchestrationBoard,
      frame({
        delegate: { brief: 'claude-delegate' },
        dispatch: { action: 'claude-delegate', result: 'ok', status: 'active' },
      }),
    );
    expect(html).not.toContain('COLD');
  });
});
