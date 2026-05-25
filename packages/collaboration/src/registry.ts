import type {
  PeerRegistry,
  RegistryEntry,
  SelfRegistration,
} from './types.js';

/**
 * Registries (intent §15.1).
 *
 * A registry is *dumb infrastructure* — a single shared place where
 * lattices post their one-sentence essence and read peers'. It is
 * NOT shared memory; reading it tells you who EXISTS, nothing more.
 *
 * Two implementations:
 *   - InMemoryPeerRegistry: tests / single-process companies
 *     (slice 15 may use this for in-process company bundles).
 *   - HttpPeerRegistry: production — points at the reference
 *     `apps/registry` HTTP service.
 */

export class InMemoryPeerRegistry implements PeerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /** TTL in ms; default never. */
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? Number.POSITIVE_INFINITY;
  }

  async register(self: SelfRegistration): Promise<void> {
    this.entries.set(self.lattice_id, {
      lattice_id: self.lattice_id,
      name: self.name,
      essence: self.essence,
      mcp_uri: self.mcp_uri,
      posted_at_ms: Date.now(),
    });
  }

  async list(): Promise<readonly RegistryEntry[]> {
    const now = Date.now();
    if (this.ttlMs === Number.POSITIVE_INFINITY) return [...this.entries.values()];
    const cutoff = now - this.ttlMs;
    for (const [id, e] of this.entries) {
      if (e.posted_at_ms < cutoff) this.entries.delete(id);
    }
    return [...this.entries.values()];
  }

  async heartbeat(self: { lattice_id: string }): Promise<void> {
    const existing = this.entries.get(self.lattice_id);
    if (existing) {
      this.entries.set(self.lattice_id, { ...existing, posted_at_ms: Date.now() });
    }
  }

  async withdraw(lattice_id: string): Promise<void> {
    this.entries.delete(lattice_id);
  }
}

export interface HttpPeerRegistryOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

interface RegistryHttpResponse {
  readonly entries: readonly RegistryEntry[];
}

export class HttpPeerRegistry implements PeerRegistry {
  constructor(private readonly opts: HttpPeerRegistryOptions) {}

  private url(path: string): URL {
    return new URL(path, this.opts.baseUrl);
  }
  private fetcher(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async register(self: SelfRegistration): Promise<void> {
    const res = await this.fetcher()(this.url('/v1/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(self),
    });
    if (!res.ok) throw new Error(`registry register failed: ${res.status}`);
  }

  async list(): Promise<readonly RegistryEntry[]> {
    const res = await this.fetcher()(this.url('/v1/peers'), { method: 'GET' });
    if (!res.ok) throw new Error(`registry list failed: ${res.status}`);
    const body = (await res.json()) as RegistryHttpResponse;
    return body.entries;
  }

  async heartbeat(self: { lattice_id: string }): Promise<void> {
    const res = await this.fetcher()(this.url('/v1/heartbeat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(self),
    });
    if (!res.ok) throw new Error(`registry heartbeat failed: ${res.status}`);
  }

  async withdraw(lattice_id: string): Promise<void> {
    const res = await this.fetcher()(this.url('/v1/withdraw'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lattice_id }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`registry withdraw failed: ${res.status}`);
    }
  }
}
