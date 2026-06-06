import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StubBackend } from '@runcor/engine';
import { JobsService } from '@runcor/jobs';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { Lattice } from './lattice.js';

const NOOP_RPP = 'TARGET { output: "noop" }\nBEHAVIOR Decide {\n  No action this cycle.\n}\n';

function stub(prompts?: string[]) {
  return new StubBackend({
    responder: (req) => {
      prompts?.push(String(req.prompt));
      return NOOP_RPP;
    },
  });
}

describe('Item 10 — seed layers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'layers-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('Layer 2 (init) is promoted to semantic memory once, and NOT in the per-cycle prompt', async () => {
    const prompts: string[] = [];
    const lattice = new Lattice({
      identity: { composed_body: 'PERSONA-L1', initLayer: 'INIT-CONTENT-L2' },
      engine: stub(prompts),
      memoryClocks: false,
    });

    const n = (
      lattice.dbHandle().prepare(`SELECT COUNT(*) AS n FROM memory_semantic WHERE source_ref = 'layer2-init'`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
    const body = (
      lattice.dbHandle().prepare(`SELECT body FROM memory_semantic WHERE source_ref = 'layer2-init'`).get() as { body: string }
    ).body;
    expect(body).toBe('INIT-CONTENT-L2');

    await lattice.runOnce();
    // Layer 1 is injected every cycle; Layer 2 is NOT in the prompt.
    expect(prompts.some((p) => p.includes('PERSONA-L1'))).toBe(true);
    expect(prompts.every((p) => !p.includes('INIT-CONTENT-L2'))).toBe(true);

    lattice.close();
  });

  it('Layer 2 init runs ONCE — a restart does not re-promote it', async () => {
    const sqlitePath = join(dir, 'entity.sqlite');
    const a = new Lattice({
      identity: { composed_body: 'p', initLayer: 'INIT-ONCE' },
      engine: stub(),
      sqlite: { path: sqlitePath },
      memoryClocks: false,
    });
    a.close();

    const b = new Lattice({
      identity: { composed_body: 'p', initLayer: 'INIT-ONCE' },
      engine: stub(),
      sqlite: { path: sqlitePath },
      memoryClocks: false,
    });
    const n = (
      b.dbHandle().prepare(`SELECT COUNT(*) AS n FROM memory_semantic WHERE source_ref = 'layer2-init'`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
    b.close();
  });

  it('Layer 3 (job body) is surfaced in the prompt while a job is active', async () => {
    const prompts: string[] = [];
    const lattice = new Lattice({ identity: { composed_body: 'p' }, engine: stub(prompts), memoryClocks: false });
    const jobs = new JobsService(lattice.dbHandle());
    jobs.openJob({ title: 'Migrate', source: 'operator', why: 'because', cycle: 0, at_ms: 0, body: 'JOB-BODY-XYZ details' });

    await lattice.runOnce();
    expect(prompts.some((p) => p.includes('JOB-BODY-XYZ details'))).toBe(true);
    expect(prompts.some((p) => p.includes('Layer 3'))).toBe(true);

    lattice.close();
  });

  it('Layer 3 is empty when no job is active', async () => {
    const prompts: string[] = [];
    const lattice = new Lattice({ identity: { composed_body: 'p' }, engine: stub(prompts), memoryClocks: false });
    await lattice.runOnce();
    expect(prompts.every((p) => !p.includes('Layer 3'))).toBe(true);
    lattice.close();
  });
});
