#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { makeEchoSense, makeNoopAction } from '@runcor/capabilities';
import { StubBackend } from '@runcor/engine';
import { Lattice, shutdownRegistry } from '@runcor/runtime';
import { LocalFolderDestination, Snapshotter, restoreIfNeeded } from '@runcor/snapshot';

interface LatticeConfig {
  readonly name?: string;
  readonly latticeId?: string;
  readonly identity_seed?: string;
  readonly tracePath?: string;
  readonly maxCycles?: number;
  readonly snapshotDir?: string;
  readonly snapshotEveryCycles?: number;
}

function readConfig(path: string | undefined): LatticeConfig {
  if (!path) return {};
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text) as LatticeConfig;
}

function help(): string {
  return `lattice — run one Runcor Lattice

Usage:
  lattice start [--sqlite <path>] [--config <path>] [--trace <path>]
                [--snapshot-dir <path>] [--max-cycles N]
  lattice --version

Commands:
  start    Start the lattice. Runs continuously until SIGINT/SIGTERM.

Options:
      --sqlite <path>         SQLite file (omit for ':memory:' / ephemeral)
  -c, --config <path>         Lattice config JSON file
      --trace <path>          Path for the JSONL trace
      --snapshot-dir <path>   Local folder for periodic snapshots
      --max-cycles N          (Test-only) Stop after N cycles
  -v, --version               Print version
  -h, --help                  Show this help
`;
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
    config: { type: 'string', short: 'c' },
    sqlite: { type: 'string' },
    trace: { type: 'string' },
    'snapshot-dir': { type: 'string' },
    'max-cycles': { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.version) {
  console.log('lattice 0.0.0');
  process.exit(0);
}

if (values.help || positionals.length === 0) {
  console.log(help());
  process.exit(0);
}

const command = positionals[0];
if (command !== 'start') {
  console.error(`unknown command: ${command}`);
  console.error(help());
  process.exit(1);
}

const configArg = typeof values.config === 'string' ? values.config : undefined;
const config = readConfig(configArg);
const sqliteArg = typeof values.sqlite === 'string' ? values.sqlite : undefined;
const sqlitePath = sqliteArg ?? ':memory:';
const traceArg = typeof values.trace === 'string' ? values.trace : undefined;
const tracePath = traceArg ?? config.tracePath ?? null;
const snapshotArg = typeof values['snapshot-dir'] === 'string' ? values['snapshot-dir'] : undefined;
const snapshotDir = snapshotArg ?? config.snapshotDir ?? null;
const snapshotEvery = config.snapshotEveryCycles ?? 25;
const maxCyclesArg = typeof values['max-cycles'] === 'string' ? values['max-cycles'] : undefined;
const maxCycles = maxCyclesArg ? Number(maxCyclesArg) : config.maxCycles;

// Restore from snapshot if local file missing but a snapshot exists.
const dest = snapshotDir ? new LocalFolderDestination({ path: snapshotDir }) : null;
if (dest && sqlitePath !== ':memory:' && !existsSync(sqlitePath)) {
  const restored = await restoreIfNeeded(sqlitePath, dest);
  if (restored) {
    console.log(`[lattice] restored ${sqlitePath} from snapshot ${restored}`);
  }
}

const lattice = new Lattice({
  identity: {
    composed_body: config.identity_seed ?? `I am ${config.name ?? 'a lattice'}.`,
  },
  engine: new StubBackend(),
  senses: [makeEchoSense()],
  actions: [makeNoopAction()],
  trace: { jsonlPath: tracePath },
  sqlite: { path: sqlitePath },
  ...(config.name !== undefined ? { name: config.name } : {}),
  ...(config.latticeId !== undefined ? { latticeId: config.latticeId } : {}),
});

const snapshotter = dest ? new Snapshotter(lattice.dbHandle(), sqlitePath, dest) : null;

shutdownRegistry.add(async () => {
  if (snapshotter) {
    const r = await snapshotter.snapshot(lattice.completedCycle);
    if (r.result === 'ok') {
      console.log(`[lattice] final snapshot ok @ cycle ${lattice.completedCycle} (${r.bytes} bytes)`);
    }
  }
  lattice.close();
});
shutdownRegistry.install((signal) => {
  console.log(`\n[lattice] received ${signal}; aborting at next cycle boundary`);
});

const startedAt = Date.now();

try {
  if (typeof maxCycles === 'number' && Number.isFinite(maxCycles) && maxCycles > 0) {
    let snapshotCounter = 0;
    for (let i = 0; i < maxCycles; i += 1) {
      if (shutdownRegistry.signal().aborted) break;
      await lattice.runOnce(shutdownRegistry.signal());
      snapshotCounter += 1;
      if (snapshotter && snapshotCounter >= snapshotEvery) {
        await snapshotter.snapshot(lattice.completedCycle);
        snapshotCounter = 0;
      }
    }
  } else {
    // Run until aborted; the runtime yields each cycle so SIGINT lands.
    // For snapshot pacing in continuous mode we spawn an interval that
    // checks counter delta; cheap and decoupled.
    let lastSnapshotCycle = lattice.completedCycle;
    const snapTimer = snapshotter
      ? setInterval(() => {
          if (lattice.completedCycle - lastSnapshotCycle >= snapshotEvery) {
            lastSnapshotCycle = lattice.completedCycle;
            void snapshotter.snapshot(lattice.completedCycle);
          }
        }, 1_000)
      : null;
    try {
      await lattice.runUntilAborted(shutdownRegistry.signal());
    } finally {
      if (snapTimer) clearInterval(snapTimer);
    }
  }
  const duration = Date.now() - startedAt;
  if (snapshotter) {
    await snapshotter.snapshot(lattice.completedCycle);
  }
  lattice.close();
  console.log(
    `[lattice] stopped. completed_cycles=${lattice.completedCycle} duration_ms=${duration}`,
  );
  process.exit(0);
} catch (err) {
  console.error('[lattice] fatal error:', err);
  try {
    lattice.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
