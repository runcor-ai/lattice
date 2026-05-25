import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * SecretStore — local-only credential storage for model backend API
 * keys (spec FR-055 + FR-052: the Bridge handles credentials; the
 * lattice never sees raw keys).
 *
 * Slice 14 ships a file-backed store at `~/.runcor-lattice/secrets.json`
 * with 0600 perms. The Bridge is single-tenant local-only (FR-055), so
 * OS-level access is the trust boundary.
 *
 * NEVER logs raw keys. The roster/inspect surfaces show a masked
 * placeholder; only the lattice's engine layer reads the resolved
 * key at backend-construction time.
 */

export interface Secrets {
  readonly anthropicApiKey?: string;
  readonly openaiApiKey?: string;
}

export interface SecretStoreOptions {
  /** Override the default path (~/.runcor-lattice/secrets.json). */
  readonly path?: string;
}

export class SecretStore {
  private readonly path: string;

  constructor(opts: SecretStoreOptions = {}) {
    this.path =
      opts.path ?? join(homedir(), '.runcor-lattice', 'secrets.json');
  }

  load(): Secrets {
    if (!existsSync(this.path)) return {};
    try {
      const raw = readFileSync(this.path, 'utf8');
      return JSON.parse(raw) as Secrets;
    } catch {
      return {};
    }
  }

  save(s: Secrets): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort on platforms that don't support chmod
      }
    }
    writeFileSync(this.path, JSON.stringify(s, null, 2), 'utf8');
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort */
    }
  }

  /** Return a redacted copy safe to surface to UI / logs. */
  redactedSummary(): { hasAnthropicKey: boolean; hasOpenaiKey: boolean } {
    const s = this.load();
    return {
      hasAnthropicKey: Boolean(s.anthropicApiKey),
      hasOpenaiKey: Boolean(s.openaiApiKey),
    };
  }
}
