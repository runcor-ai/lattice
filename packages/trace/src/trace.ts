import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SqliteTraceIndex } from './sqlite-index.js';
import type { TraceEntry } from './types.js';

/**
 * Trace — the cognitive record writer.
 *
 * Three surfaces, all written for every entry:
 *   - JSONL append (durable; one entry per line).
 *   - In-memory ring buffer (queryable for tests + Bridge SSE).
 *   - Optional SQLite-backed index (fast queries; landed in slice 3).
 *
 * Per constitution Principle X: every cycle, correction, job event,
 * substrate flag, and operator action lands here.
 */

export interface TraceOptions {
  /** Path to the JSONL file. Created on demand; parent dir created if needed. */
  jsonlPath: string | null;
  /** Optional SQLite-backed indexer (slice 3 onward). */
  sqliteIndex?: SqliteTraceIndex;
  /** Initial in-memory capacity. Defaults to 1024. */
  initialCapacity?: number;
}

export type TraceSubscriber = (entry: TraceEntry) => void;

export class Trace {
  private readonly path: string | null;
  private readonly sqliteIndex: SqliteTraceIndex | undefined;
  private readonly buffer: TraceEntry[];
  private readonly subscribers: Set<TraceSubscriber> = new Set();

  constructor(opts: TraceOptions) {
    this.path = opts.jsonlPath;
    this.sqliteIndex = opts.sqliteIndex;
    this.buffer = [];
    if (this.path) {
      const dir = dirname(this.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  write(entry: TraceEntry): void {
    this.buffer.push(entry);
    if (this.path) {
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    }
    if (this.sqliteIndex) {
      this.sqliteIndex.write(entry);
    }
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        // A misbehaving subscriber must not break the trace writer.
      }
    }
  }

  subscribe(fn: TraceSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Read all entries in memory. Tests only — production reads via the indexed store. */
  snapshot(): readonly TraceEntry[] {
    return this.buffer;
  }

  /** Filter helper for tests. */
  filter(predicate: (e: TraceEntry) => boolean): TraceEntry[] {
    return this.buffer.filter(predicate);
  }

  /** Count of entries in the in-memory buffer. */
  size(): number {
    return this.buffer.length;
  }
}
