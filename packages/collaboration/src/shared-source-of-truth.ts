import { makeApiCapability, type Capability } from '@runcor/capabilities';

/**
 * Shared source of truth (intent §15.1).
 *
 * A read-only reference all members of a company READ but never
 * write. Reference material, not shared memory — the no-shared-memory
 * rule (Principle XIV) still holds.
 *
 * Implemented as a SENSE capability — read in `observe` every cycle.
 * Slice 13 ships an HTTP-fetch-based factory; slice 14 may add
 * caching + delta detection.
 */

export interface SharedSourceOfTruthOptions {
  readonly name: string;
  readonly uri: string;
  readonly description?: string;
  readonly fetchImpl?: typeof fetch;
  /** Optional headers (e.g. auth). */
  readonly headers?: Readonly<Record<string, string>>;
}

export function makeSharedSourceOfTruth(opts: SharedSourceOfTruthOptions): Capability<never, unknown> {
  const fetcher = opts.fetchImpl ?? fetch;
  return makeApiCapability<never, unknown>({
    name: opts.name,
    description: opts.description ?? `Read-only shared source of truth at ${opts.uri}`,
    role: { sense: true, action: false },
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    readFn: async (ctx) => {
      const res = await fetcher(opts.uri, {
        method: 'GET',
        ...(opts.headers ? { headers: opts.headers as Record<string, string> } : {}),
        signal: ctx.abortSignal,
      });
      if (!res.ok) {
        throw new Error(`shared source of truth ${opts.uri} failed: ${res.status}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return res.json();
      }
      return res.text();
    },
  });
}
