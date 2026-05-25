import type { DiscoveryCandidate, RegistryClient } from './discovery.js';

/**
 * MCP Registry HTTP client (intent §15 + §25).
 *
 * The official MCP Registry (`modelcontextprotocol/registry`) is a
 * dumb directory queryable over HTTP. The client is intentionally
 * minimal — slice 10 ships the contract; slice 14 will tighten with
 * pagination, caching, and the Bridge's "discovered servers" view.
 *
 * For testing, an `InMemoryRegistry` is provided so the discovery
 * flow can be exercised without a real registry running.
 */

export interface HttpRegistryClientOptions {
  readonly baseUrl: string;
  /** Override the default fetch implementation (tests inject mocks). */
  readonly fetchImpl?: typeof fetch;
}

interface RegistryResponse {
  readonly candidates: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly mcp_server_uri?: string;
    readonly role: { sense: boolean; action: boolean };
    readonly destructive: boolean;
  }[];
}

export class HttpRegistryClient implements RegistryClient {
  constructor(private readonly opts: HttpRegistryClientOptions) {}

  async search(query: string): Promise<readonly DiscoveryCandidate[]> {
    const url = new URL('/v1/search', this.opts.baseUrl);
    url.searchParams.set('q', query);
    const fetcher = this.opts.fetchImpl ?? fetch;
    const res = await fetcher(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`registry search failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as RegistryResponse;
    return body.candidates.map(
      (c): DiscoveryCandidate => ({
        candidateId: c.id,
        name: c.name,
        description: c.description,
        ...(c.mcp_server_uri ? { mcpServerUri: c.mcp_server_uri } : {}),
        proposedRole: c.role,
        destructive: c.destructive,
      }),
    );
  }
}

/** Test/dev helper — an in-memory registry pre-loaded with candidates. */
export class InMemoryRegistry implements RegistryClient {
  constructor(private readonly candidates: readonly DiscoveryCandidate[]) {}

  async search(query: string): Promise<readonly DiscoveryCandidate[]> {
    const q = query.toLowerCase();
    return this.candidates.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }
}
