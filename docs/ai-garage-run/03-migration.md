# migration.md — AI Agent Workbench → local-only stack

Migration analysis for taking `C:\agent-builder-console` (Supabase-backed Vite/React SPA) onto a **local-only** target stack. Read-only inspection of the source repo; citations use paths relative to `C:\agent-builder-console`. Companion to `features.md` (inventory) and `vulnerabilities.md` (security findings).

## 1. Scope & target stack

**Source stack** (today):

- Vite 5 + React 18 + TypeScript SPA, served from a dev or static host. Build entry `package.json:6-12`; React mount at `src/App.tsx:1-22`.
- Backend = 22 **Supabase Edge Functions** (Deno) deployed in project `tkppayricdwsogopxxzp`, all anonymous-callable. Manifest: `supabase/config.toml:1-68`. SPA client created at `src/integrations/supabase/client.ts:1-17`.
- No app-owned database in Supabase Postgres — the only persistent stores are (a) browser `localStorage` for the Supabase anon session (`src/integrations/supabase/client.ts:11-15`), (b) browser `sessionStorage` for secrets (`src/hooks/useSecretsManager.ts:15-44`), and (c) a *user-supplied* external Postgres reached via the `external-db` function (`supabase/functions/external-db/index.ts:270-491`).
- LLM/API providers: Gemini, Claude, Grok, Brave, Google CSE, GitHub, ElevenLabs, Resend, OpenWeatherMap, Open-Meteo, Google Cloud Vision, Pronghorn (see `features.md` § External Dependencies for keys & call sites).

**Target stack** (local-only, per `[[feedback_local_only]]`):

- Single local process (Node.js ≥ 20) exposing the former edge endpoints as local HTTP routes on `127.0.0.1:<port>` (e.g. Hono / Fastify / Express). Replaces the entire `supabase/functions/**` tree and the `https://tkppayricdwsogopxxzp.supabase.co/functions/v1/...` base URL.
- **SQLite** (`better-sqlite3`) as the sole persistent store. Replaces (a) the Supabase-anon session model, (b) browser `sessionStorage` secret store, and (c) the `external-db` Postgres tool.
- Same Vite + React SPA, served by `vite preview` against the local process. No Supabase JS client at runtime.
- LLM provider calls **still go to upstream APIs** (Gemini/Claude/Grok/ElevenLabs/etc.) over HTTPS — the local process is the credential holder and the only outbound caller. No local model is mandated by this migration.
- Explicitly out: Render hosting, Nexus repo, SSO, GitHub PR workflows, Resend, Pronghorn API forwarding (per local-only constraint — see § 8).

## 2. Architecture mapping — source → target (high level)

| # | Concern | Source (today) | Target (local) | Evidence |
|---|---|---|---|---|
| A1 | Backend runtime | 22 Supabase Edge Functions on Deno Deploy. | Single Node ≥ 20 HTTP server with one route per former function (same name/path). | `supabase/config.toml:1-68`; every `supabase/functions/*/index.ts` line 1 (`import { serve } from "https://deno.land/std@.../http/server.ts"`). |
| A2 | Public URL | `https://tkppayricdwsogopxxzp.supabase.co/functions/v1/<name>` | `http://127.0.0.1:<port>/functions/v1/<name>` (path-compatible). | `src/lib/functionExecutor.ts:581,633,685,732,799,936,1010,1061,1330`; `src/pages/Index.tsx:1373,2127,2675`; `src/components/properties/PropertiesPanel.tsx:130`; `src/components/github/GitHubTreeModal.tsx:67,253`. |
| A3 | Frontend dispatch | `supabase.functions.invoke(name, {body})` and direct `fetch(${VITE_SUPABASE_URL}/functions/v1/<name>, …)`. | `fetch(${VITE_LOCAL_API_URL}/functions/v1/<name>, …)` plus a small `localInvoke(name, body)` helper to replace `supabase.functions.invoke`. | `src/hooks/useFreeAgentSession.ts:332, 1103`; `src/lib/freeAgentToolExecutor.ts:564`; full list of `fetch(...functions/v1/...)` sites enumerated in row A2. |
| A4 | Persistent app data | None in Supabase Postgres; only browser storage + user-supplied external Postgres. | **SQLite** (one file under the user's app data dir, e.g. `%APPDATA%\agent-builder-console\app.sqlite`). | `src/integrations/supabase/client.ts:11-15` (localStorage); `src/hooks/useSecretsManager.ts:15-44` (sessionStorage); `supabase/functions/external-db/index.ts:270-491` (caller-supplied Postgres). |
| A5 | Auth & identity | None — `verify_jwt = false` on all functions, anon JWT in `.env`. | None at the boundary (single-user local app); replace the implicit "anyone on the internet" trust with an OS-local trust boundary (loopback only) plus an interactive approval prompt for privileged tool calls. | `supabase/config.toml:1-68`; `.env:1-3`. |
| A6 | Outbound LLM/API calls | Edge function holds the provider key via `Deno.env.get(KEY)`. | Local Node process holds the provider key via `process.env.<KEY>`, loaded from `.env` (gitignored). Same key inventory: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `BRAVE_API_KEY`, `GOOGLE_VISION_API_KEY`, `ELEVENLABS_API_KEY`, `GITHUB_TOKEN` (optional). `RESEND_API_KEY` not migrated (see § 8). | Provider key call-sites: `supabase/functions/run-agent/index.ts:31, 148`; `supabase/functions/run-agent-anthropic/index.ts:18, 125`; `supabase/functions/run-agent-xai/index.ts:23, 102`; `supabase/functions/free-agent/index.ts:901, 905, 920, 923, 940, 943`; `supabase/functions/brave-search/index.ts:24`; `supabase/functions/google-search/index.ts:48`; `supabase/functions/elevenlabs-tts/index.ts:26`; `supabase/functions/get-elevenlabs-voices/index.ts:14`; `supabase/functions/github-fetch/index.ts:8, 33`; `supabase/functions/tool_ocr-handler/index.ts:50`. |
| A7 | CORS | Wildcard `Access-Control-Allow-Origin: *` on every function. | Strict origin allowlist = `http://127.0.0.1:5173` (Vite dev) and `http://127.0.0.1:4173` (vite preview) only; reject all other Origin headers. | All 22 functions; enumerated in `vulnerabilities.md` H1. |
| A8 | Build & dev | `vite` dev server on `:::8080`, `lovable-tagger` injected when `mode==='development'`. | `vite` dev on `127.0.0.1:5173`; **remove `lovable-tagger`** (Lovable Cloud-only integration). `vite.config.ts` simplified. | `vite.config.ts:1-18` (`componentTagger()` + `mode==='development'` gate); `package.json:86`. |
| A9 | Routing | React-Router with `/` and `*` only. | Unchanged. | `src/App.tsx:6-7`; `src/pages/Index.tsx:30-34`; `src/pages/NotFound.tsx:1-22`. |
| A10 | SQLite client | n/a | `better-sqlite3` (synchronous, embedded, MIT) in the local Node process; not used in the browser. | New dependency; no source citation in `agent-builder-console`. |

## 3. Edge function → local handler mapping (all 22)

Each former Supabase Edge Function becomes one route handler on the local server. The handler keeps the same request/response shape so the SPA needs no per-endpoint changes beyond the base URL (A2). "Notes" calls out the migration-specific changes per endpoint.

| # | Path (kept) | Source file | Local handler change | Outbound deps preserved | Notes |
|---|---|---|---|---|---|
| 1 | `POST /functions/v1/run-agent` | `supabase/functions/run-agent/index.ts:1, 31, 51, 66, 77, 88, 101, 148-150` | Port to Node. Keep SSE response. Drop the `BLOCK_NONE` safety overrides at `:163-180` (see `vulnerabilities.md` C5). Strip `stack` field at `:305-320` (`vulnerabilities.md` M4). | Google Gemini (server-side `GEMINI_API_KEY`). | SSE streaming uses Node's `Response` body / `Readable` — straightforward port. |
| 2 | `POST /functions/v1/run-agent-anthropic` | `supabase/functions/run-agent-anthropic/index.ts:1, 18, 125-126` | Port to Node; keep SSE. | Anthropic Claude (`ANTHROPIC_API_KEY`). | — |
| 3 | `POST /functions/v1/run-agent-xai` | `supabase/functions/run-agent-xai/index.ts:1, 23, 47, 102-103` | Port to Node; keep SSE. | xAI Grok (`XAI_API_KEY`). | — |
| 4 | `POST /functions/v1/run-nano` | `supabase/functions/run-nano/index.ts:1, 32, 56-58` | Port to Node. | Google Gemini. | Used by `image_generation` (`src/lib/functionExecutor.ts:581`). |
| 5 | `POST /functions/v1/free-agent` | `supabase/functions/free-agent/index.ts:1-100, 805-944` | Port to Node. Add an **interactive approval gate** in front of privileged tools (`execute_sql`, `send_email`, `spawn`, `write_self`, `pronghorn_post` if retained) — replaces the missing auth boundary (`vulnerabilities.md` H5, H6, M3). | Gemini/Claude/Grok depending on chosen model (`:901, 905, 920, 923, 940, 943`). | The server-side tool-dispatch loop stays; the dispatch switch (`:820-840`) calls the *local* sibling handlers instead of edge-function URLs. |
| 6 | `POST /functions/v1/enhance-prompt` | `supabase/functions/enhance-prompt/index.ts:1-2, 35-99` | Port to Node. | Multi-provider. | — |
| 7 | `POST /functions/v1/brave-search` | `supabase/functions/brave-search/index.ts:1, 24, 42` | Port to Node; secret-source change only. | Brave (`BRAVE_API_KEY`). | — |
| 8 | `POST /functions/v1/google-search` | `supabase/functions/google-search/index.ts:1, 48` | Port to Node. | Google CSE. | — |
| 9 | `POST /functions/v1/web-scrape` | `supabase/functions/web-scrape/index.ts:1, 99-198, 590, 669` | Port to Node. **Apply hostname allowlist** + RFC1918/metadata-IP block (`vulnerabilities.md` H3). Replace jsdelivr `+esm` imports for `unpdf` and `mammoth` with npm packages (`mammoth@1.11.0` already in deps at `package.json:55`; add `unpdf` to deps). | Arbitrary HTTP(S) (now restricted). | The `redirect: "follow"` and UA-rotation behaviour become an authoring choice; for a local dev tool keep the helpful behaviour but mandate the IP allowlist. |
| 10 | `POST /functions/v1/github-fetch` | `supabase/functions/github-fetch/index.ts:1, 8, 33, 117-118, 281-407` | Port to Node. Drop the server-side `GITHUB_TOKEN` (`vulnerabilities.md` H4). User supplies a PAT in the Secrets Manager if they need private-repo access. | GitHub REST + `raw.githubusercontent.com`. | — |
| 11 | `POST /functions/v1/api-call` | `supabase/functions/api-call/index.ts:1, 9-41, 53-113` | Port to Node. **Apply hostname allowlist** + RFC1918/metadata-IP block (`vulnerabilities.md` C3). Set `redirect: "manual"` and re-validate hops. | Arbitrary HTTP(S) (now restricted). | — |
| 12 | `POST /functions/v1/send-email` | `supabase/functions/send-email/index.ts:1-2, 23, 41-52` | **Stub-out by default in local mode** (returns `501 Not Implemented` with a clear message). Optional: route to a user-supplied SMTP relay over `nodemailer` if `LOCAL_SMTP_URL` is set. Drops the Resend integration entirely (no `RESEND_API_KEY` — see § 8). | None (local) / user SMTP (optional). | The `pronghorn-post`-style "anonymous open relay" risk (`vulnerabilities.md` H2) disappears once the loopback boundary is enforced. |
| 13 | `POST /functions/v1/elevenlabs-tts` | `supabase/functions/elevenlabs-tts/index.ts:1-3, 26, 34-35` | Port to Node. | ElevenLabs (`ELEVENLABS_API_KEY`). | — |
| 14 | `GET /functions/v1/get-elevenlabs-voices` | `supabase/functions/get-elevenlabs-voices/index.ts:1, 14, 22-23` | Port to Node. | ElevenLabs. | The only GET endpoint in the surface. |
| 15 | `POST /functions/v1/weather` | `supabase/functions/weather/index.ts:1, 27` | Port to Node. | OpenWeatherMap. | Legacy; kept for compatibility. |
| 16 | `POST /functions/v1/tool_weather` | `supabase/functions/tool_weather/index.ts:1, 24, 44` | Port to Node. | Open-Meteo (no auth). | — |
| 17 | `POST /functions/v1/time` | `supabase/functions/time/index.ts:1` | Port to Node. Pure compute (Intl + `Date`). | None. | — |
| 18 | `POST /functions/v1/tool_pdf-handler` | `supabase/functions/tool_pdf-handler/index.ts:1, 23` | Port to Node; use `pdfjs-dist@5.4.296` (already in deps at `package.json:57`) or `unpdf` directly. | None. | Add explicit body-size cap (`vulnerabilities.md` L4). |
| 19 | `POST /functions/v1/tool_ocr-handler` | `supabase/functions/tool_ocr-handler/index.ts:1, 49-50, 86-88, 158-160` | Port to Node. | Google Cloud Vision primary; Gemini fallback. | — |
| 20 | `POST /functions/v1/tool_zip-handler` | `supabase/functions/tool_zip-handler/index.ts:1-2, 36` | Port to Node; use `jszip@3.10.1` (already in deps at `package.json:53`) in place of the Deno `zipjs` import. | None. | Add ZIP-bomb / declared-size cap (`vulnerabilities.md` L4). |
| 21 | `POST /functions/v1/external-db` | `supabase/functions/external-db/index.ts:1-2, 104-177, 270-491` | **Replace with SQLite handler.** Accept either `{file}` (path to a project-local `.sqlite`) or default to the app's main SQLite file. Implement the same `action: "schemas" \| "query"` contract from `:276-284`. Reject multi-statement queries; reject DDL/DML unless `mode: "write"` (replaces the advisory `isWrite` flag at `:281, 377` — `vulnerabilities.md` C2, M5). | None (local file). | The most invasive port — Postgres semantics → SQLite differ (no `pg_*` catalogs; introspect via `sqlite_master` / `pragma table_info`). The `SCHEMA_INTROSPECTION_QUERY` referenced at `:307` must be rewritten as SQLite SQL. |
| 22 | `POST /functions/v1/pronghorn-post` | `supabase/functions/pronghorn-post/index.ts:1, 22-50, 55-91` | **Drop or stub** per local-only constraint (no Pronghorn/Nexus). Return `501 Not Implemented` and a deprecation message. | n/a | The `pronghorn_post` tool is removed from the agent's tool list (`public/data/toolsManifest.json:817-873`) — see § 8. |

Beyond endpoints, the **33-tool Free-Agent catalogue** (`public/data/toolsManifest.json`) is preserved unchanged; each tool's `edge_function` field maps to the same path on the local server. Frontend-handled tools (`read_self`, `write_self`, `spawn`, `read_blackboard`, etc. — switch arms in `src/lib/freeAgentToolExecutor.ts:60-92`) don't need server porting at all.

## 4. Data-persistence migration → SQLite

The source app's persistence is fragmented across two browser stores plus a user-supplied Postgres. Consolidate into one local SQLite file. Suggested schema:

| Table | Replaces | Source evidence |
|---|---|---|
| `secrets(name TEXT PK, kind TEXT, value_encrypted BLOB, created_at, updated_at)` | `sessionStorage.free_agent_secrets` plaintext JSON. | `src/hooks/useSecretsManager.ts:15-44, 287-289`; `src/types/secrets.ts`; `vulnerabilities.md` M1. |
| `tool_instances(id TEXT PK, base_tool TEXT, label TEXT, config JSON, created_at)` | `useToolInstances` state (today not persisted across page reload). | `src/hooks/useToolInstances.ts`; `src/types/toolInstance.ts`. |
| `sessions(id TEXT PK, created_at, kind TEXT, settings JSON)` and `iterations(session_id, iter INT, payload JSON)` | Free-Agent session export currently written to disk on demand. | `src/utils/sessionExporter.ts`; `src/hooks/useFreeAgentSession.ts`. |
| `workflows(id TEXT PK, name TEXT, blob JSON, updated_at)` | Workflow save/load currently uses a one-off `Blob` download. | `src/pages/Index.tsx:929-954, 1026-1090`. |
| `audit_log(id INTEGER PK, ts, route, tool, args_hash, outcome, user_approved INT)` | No equivalent today — newly created to satisfy `vulnerabilities.md` I5. | New. |
| user-attached `.sqlite` files | Targets of the former `execute_sql` / `read_database_schemas` tools — now plain SQLite files anywhere on the local filesystem. | `supabase/functions/external-db/index.ts:270-491`; manifest `public/data/toolsManifest.json:938-1006`. |

Browser-side, retain `localStorage` only for UI state (theme, panel sizes). The Supabase-anon-session `localStorage` write at `src/integrations/supabase/client.ts:11-15` goes away with the Supabase client.

Secrets at rest: derive a WebCrypto/Node-crypto key from an OS-keyring entry (`keytar`) or a user passphrase on first launch; encrypt the `value_encrypted` column. Closes `vulnerabilities.md` M1 in the local context.

## 5. Frontend integration seam — the chokepoint to refactor

Three call patterns must be redirected from Supabase to the local server. The list is small and bounded:

1. **Direct `fetch` to the edge function URL** — 12 call sites (full list in row A2): `src/lib/functionExecutor.ts:581, 633, 685, 732, 799, 936, 1010, 1061, 1330`; `src/pages/Index.tsx:1373, 2127, 2675`; `src/components/properties/PropertiesPanel.tsx:130`; `src/components/github/GitHubTreeModal.tsx:67, 253`; `src/components/freeAgent/EnhancePromptModal.tsx:224`; `src/components/freeAgent/ReflectModal.tsx:127`. **Mechanical change**: replace `import.meta.env.VITE_SUPABASE_URL` with `import.meta.env.VITE_LOCAL_API_URL` (or hardcode `http://127.0.0.1:<port>`). Drop the `apikey` / `Authorization: Bearer <anon JWT>` headers — the local server doesn't need them.
2. **`supabase.functions.invoke(...)`** — 3 sites: `src/hooks/useFreeAgentSession.ts:332, 1103`; `src/lib/freeAgentToolExecutor.ts:564`. Replace with a thin `localInvoke(name, {body})` helper that does the equivalent `fetch` + JSON parse and mimics the `{data, error}` shape.
3. **Supabase client construction** — `src/integrations/supabase/client.ts:1-17`. Remove entirely; delete `@supabase/supabase-js` from `package.json:42`. The `Database` type import at `:3` becomes unused (no app tables in Supabase anyway — only `auth.*`).

This is the only seam — there is no Supabase Realtime, Supabase Storage, Supabase Auth, or RLS usage in the SPA.

## 6. Build, dev, secrets, and packaging

| Item | Source | Target | Evidence |
|---|---|---|---|
| Dev server bind | `host: "::"` on port 8080. | `host: "127.0.0.1"` (loopback only) on 5173 (Vite default). | `vite.config.ts:7-11`. |
| Build plugin | `lovable-tagger` dev-only `componentTagger()`. | **Removed**. The Lovable Cloud integration is Lovable-platform-specific and unused locally. | `vite.config.ts:4, 12`; `package.json:86`; `vulnerabilities.md` M9. |
| Secrets file | `.env` checked into the repo with the Supabase anon JWT. | `.env` **gitignored**; no anon JWT (no Supabase). Local-server-side `.env.server` (also gitignored) holds provider keys: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `BRAVE_API_KEY` (optional — secrets manager can override), `GOOGLE_VISION_API_KEY` (optional), `ELEVENLABS_API_KEY` (optional). `GITHUB_TOKEN` removed per `vulnerabilities.md` H4. | `.env:1-3`; `vulnerabilities.md` C4 & I4. |
| Process model | Browser ↔ Supabase Edge (multi-tenant cloud). | One local Node process + one local Vite dev server. Launch via a single `pnpm dev` script that spawns both (e.g. via `concurrently` or `npm-run-all`). | New. |
| Distribution | Static site + hosted Supabase project. | Either a directory the user clones + runs, or an Electron/Tauri wrapper around the same two processes. (Out of scope of this migration doc — see `plan.md`.) | — |

## 7. Free-Agent server-side dispatch — the only non-mechanical port

The `free-agent` function's per-iteration loop runs tools by `fetch(${SUPABASE_URL}/functions/v1/<edge_function>, …)` (`supabase/functions/free-agent/index.ts:805-944`). In the local target, this is **the same process** as the tool handlers themselves, so the dispatch path collapses to an in-process function call:

```
// before  (supabase/functions/free-agent/index.ts ~:820-840)
const r = await fetch(`${supabaseUrl}/functions/v1/${tool.edge_function}`, …);

// after   (local Node)
const r = await invokeLocalHandler(tool.edge_function, body);
```

This is the single architectural change in the dispatch path; everything else (tool manifest parsing, message construction, provider routing at `:887-960`) ports unchanged.

## 8. What is *not* migrated (local-only constraint)

These features are explicitly dropped per `[[feedback_local_only]]`. The agent's tool list (`public/data/toolsManifest.json`) is trimmed accordingly:

| Dropped | Why dropped | Evidence |
|---|---|---|
| `send-email` / Resend integration | No outbound transactional email in a local-only build (no Render, no Nexus, no SSO). Email tool returns `501`. | `supabase/functions/send-email/index.ts:1-2, 23` (Resend); `public/data/toolsManifest.json:616-653`. |
| `pronghorn-post` / Pronghorn artifact ingest | Pronghorn is a remote ingest endpoint (`api.pronghorn.red`). Local-only constraint forbids the outbound. Tool removed from manifest. | `supabase/functions/pronghorn-post/index.ts:55-56`; `public/data/toolsManifest.json:817-873`. |
| Supabase Auth / anon JWT | No multi-tenant identity in a single-user local app. Loopback + interactive approval is the security boundary. | `src/integrations/supabase/client.ts:11-15`; `.env:1-3`. |
| Lovable Cloud integration / `lovable-tagger` | Platform-specific to Lovable; not needed locally and leaks file structure into builds. | `package.json:86`; `vite.config.ts:4, 12`; `README.md:354-365, 505-511`; `vulnerabilities.md` M9. |
| Render / Nexus / GitHub PR deploy pipelines | Out of scope per local-only rule. | n/a (no source file ties this to the repo). |

## 9. Migration risks & open issues

| # | Risk | Anchor |
|---|---|---|
| R1 | **`external-db` → SQLite parity is partial.** The `SCHEMA_INTROSPECTION_QUERY` is Postgres-specific (`pg_catalog`, `information_schema`). SQLite introspection uses `sqlite_master` + `pragma`. The `pgErrorMap`-style error normalisation also changes. Agents that have learnt Postgres syntax will need re-prompting. | `supabase/functions/external-db/index.ts:307, 463-491`. |
| R2 | **CDN-loaded Deno deps (`unpdf`, `mammoth` from jsdelivr).** Direct port to npm versions is required; bundle behaviour differs from Deno's `+esm` (e.g., `mammoth` is already in `package.json:55`, but `unpdf` is not). | `supabase/functions/web-scrape/index.ts:590, 669`. |
| R3 | **SSE port to Node.** All three `run-agent*` handlers stream Server-Sent Events to the browser. Node fastify/express SSE patterns differ from Deno's `ReadableStream` — verify back-pressure behaviour matches the existing edge implementation. | `supabase/functions/run-agent/index.ts:51, 66, 77, 88, 101`. |
| R4 | **`spawn` recursion accounting.** Today the only limits are client-side (`maxChildren \|\| 5` at `src/lib/freeAgentToolExecutor.ts:943-947`). Local migration must add a server-side recursion-depth + cumulative-iteration cap to prevent runaway LLM spend, even though the call is local. | `src/lib/freeAgentToolExecutor.ts:899-985`; `vulnerabilities.md` H6. |
| R5 | **Provider keys at rest.** Moving provider keys from Supabase Function Secrets into `.env.server` on the local box widens the local attack surface to anything that can read that file. Use the OS keyring (`keytar`) where available. | `vulnerabilities.md` I4. |
| R6 | **Frontend env-var rename ripple.** The 12 `fetch` sites in row A2 read `import.meta.env.VITE_SUPABASE_URL` directly. A grep-and-replace works, but adding a single `apiBase()` helper avoids future drift. | Sites listed in § 5 item 1. |
| R7 | **`workflows`/`sessions` data shape is not yet defined.** Today they live only in memory and exported JSON; defining a stable SQLite schema requires settling forward-compat for the legacy load format at `src/pages/Index.tsx:1026-1090`. Deferred to `plan.md`. | `src/pages/Index.tsx:929-954, 1026-1090`; `src/utils/sessionExporter.ts`. |

## 10. Evidence index

Files opened (read in full or in part) for this migration analysis, in order of first inspection during this pass:

1. `C:\agent-builder-console\supabase\config.toml` — full re-read for endpoint inventory.
2. `C:\agent-builder-console\vite.config.ts` — build & dev-server config.
3. `C:\agent-builder-console\src\integrations\supabase\client.ts` — Supabase client surface.
4. `C:\agent-builder-console\package.json` — dep inventory for replacement choices.
5. `C:\agent-builder-console\supabase\functions\external-db\index.ts` (partial: lines 270-390) — confirm `action` contract and `isWrite` semantics for SQLite port.
6. Cross-references into `features.md` and `vulnerabilities.md` (this repo, same inspection pass).

Grep evidence reused (no new files opened) to find:
- All SPA → edge-function call sites (`supabase.functions.invoke` and `fetch(${VITE_SUPABASE_URL}/functions/v1/...)`) across `src/**`. Result enumerated in § 2 row A2 and § 5 item 1.

Out of scope for this doc (handled in `plan.md` or `privacy_controls.md`):

- Per-step task ordering, branch/PR strategy, milestone definition (→ `plan.md`).
- Local-only PII redaction, Protected B markings, and ministry detection (→ `privacy_controls.md`).
- The 30+ frontend function-node handlers in `src/lib/functionExecutor.ts` for argument-handling differences once the edge functions move local (→ `plan.md`).
