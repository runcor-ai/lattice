#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { shutdownRegistry } from '@runcor/runtime';
import { SlowclockWorker } from '@runcor/slowclock';

function help(): string {
  return `slowclock — the Runcor Lattice slow-clock worker

Usage:
  slowclock attach --sqlite <path> [--poll-interval-ms N] [--baseline N] [--trace <path>]
  slowclock --version

Options:
      --sqlite <path>           SQLite file shared with the fast clock
      --poll-interval-ms N      Polling interval in ms (default 1000)
      --baseline N              Cadence baseline in cycles (default 100)
      --trace <path>            JSONL trace for slow-clock events
  -v, --version                 Print version
  -h, --help                    Show this help
`;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
    sqlite: { type: 'string' },
    'poll-interval-ms': { type: 'string' },
    baseline: { type: 'string' },
    trace: { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.version) {
  console.log('slowclock 0.0.0');
  process.exit(0);
}
if (values.help || positionals.length === 0) {
  console.log(help());
  process.exit(0);
}

const command = positionals[0];
if (command !== 'attach') {
  console.error(`unknown command: ${command}`);
  console.error(help());
  process.exit(1);
}

const sqlite = typeof values.sqlite === 'string' ? values.sqlite : undefined;
if (!sqlite) {
  console.error('--sqlite <path> is required');
  process.exit(1);
}

const pollMsArg = typeof values['poll-interval-ms'] === 'string' ? values['poll-interval-ms'] : undefined;
const baselineArg = typeof values.baseline === 'string' ? values.baseline : undefined;
const traceArg = typeof values.trace === 'string' ? values.trace : undefined;

const worker = new SlowclockWorker({
  sqlitePath: sqlite,
  pollIntervalMs: pollMsArg ? Number(pollMsArg) : 1000,
  cadence: {
    baseline: baselineArg ? Number(baselineArg) : 100,
    loadAware: true,
  },
  tracePath: traceArg ?? null,
});

shutdownRegistry.add(() => worker.close());
shutdownRegistry.install((signal) => {
  console.log(`\n[slowclock] received ${signal}; closing`);
});

try {
  const wakes = await worker.run(shutdownRegistry.signal());
  console.log(`[slowclock] stopped. wakes=${wakes}`);
  worker.close();
  process.exit(0);
} catch (err) {
  console.error('[slowclock] fatal error:', err);
  try {
    worker.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
