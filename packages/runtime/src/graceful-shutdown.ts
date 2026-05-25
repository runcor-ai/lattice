/**
 * Graceful shutdown.
 *
 * The CLI installs SIGINT/SIGTERM handlers that:
 *   1. abort the loop signal,
 *   2. run all registered cleanup callbacks (LIFO),
 *   3. exit 0.
 *
 * Lattice.close() is the canonical cleanup: COMMIT pending, close
 * SQLite, release the lockfile. Without graceful shutdown the
 * lockfile is left behind (recoverable via lockfile staleness
 * detection, but cleaner to release on the way out).
 */

export type Cleanup = () => void | Promise<void>;

class GracefulShutdownRegistry {
  private cleanups: Cleanup[] = [];
  private installed = false;
  private signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  private aborter = new AbortController();

  signal(): AbortSignal {
    return this.aborter.signal;
  }

  add(fn: Cleanup): () => void {
    this.cleanups.push(fn);
    return () => {
      this.cleanups = this.cleanups.filter((c) => c !== fn);
    };
  }

  install(onSignal?: (signal: NodeJS.Signals) => void): void {
    if (this.installed) return;
    this.installed = true;
    const handler = (signal: NodeJS.Signals) => {
      onSignal?.(signal);
      this.aborter.abort();
      // Run cleanups LIFO; await each.
      void (async () => {
        for (const fn of [...this.cleanups].reverse()) {
          try {
            await fn();
          } catch {
            // Cleanup failures are not fatal here.
          }
        }
        process.exit(0);
      })();
    };
    for (const s of this.signals) {
      process.on(s, handler);
    }
  }

  /** Test-only: run all cleanups synchronously, do not exit. */
  async runAllForTest(): Promise<void> {
    for (const fn of [...this.cleanups].reverse()) {
      await fn();
    }
    this.cleanups = [];
  }
}

export const shutdownRegistry = new GracefulShutdownRegistry();
