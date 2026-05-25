# plan.md — agent-builder-console → local-only migration plan

Granular, dependency-ordered, step-by-step plan for porting `C:\agent-builder-console` (Vite + React SPA backed by 22 Supabase Edge Functions) to a **local-only** target stack with no Render DB, no Nexus, no SSO, and no GitHub PR pipeline. Tables go in local SQLite; analysis deliverables stay under `C:\runcor-lattice\data-abc\out\`.

This plan is the operational follow-on to `migration.md` (architecture mapping) and consumes findings from `features.md` (inventory) and `vulnerabilities.md` (security audit). It does **not** modify `C:\agent-builder-console` — that repo is read-only evidence. All edits land in a new working fork at `C:\runcor-lattice\abc-local\` (created in step A1).

## Conventions

- **Source repo** (read-only): `C:\agent-builder-console` — paths beginning with `supabase/`, `src/`, `public/`, `vite.config.ts`, `package.json`, `.env`, `.gitignore` refer to this tree.
- **Target fork** (created here): `C:\runcor-lattice\abc-local\` — paths beginning with `server/`, `web/`, `data/`, `scripts/`, or the same `src/`/`supabase/`/etc. names after step A1 refer to this tree.
- **Deliverables tree**: `C:\runcor-lattice\data-abc\out\` — holds only `*.md` outputs of this analysis pass, never source code.
- Every step has **Preconditions**, **Change**, **Files touched**, **Test**, **Rollback**.
- Steps are numbered `<Phase letter><index>` and ordered so each only depends on lower-numbered steps in earlier phases (or earlier in the same phase). Within a phase, parallel-safe steps are flagged `[P]`.
- “Test” commands assume PowerShell on Windows and that the working directory is `C:\runcor-lattice\abc-local\` unless noted.
- Citations are `path:line` relative to `C:\agent-builder-console` (source) or `C:\runcor-lattice\data-abc\out\<file>:section` (prior deliverables).

---

## Phase A — Workspace bootstrap (isolate the fork)

Goal: stand up an empty, working copy of the SPA on the local box without yet touching backend, persistence, or auth. Exit criterion: `vite dev` serves the existing UI against the old Supabase backend from the new fork directory, proving copy fidelity.

### A1. Create the local fork at `C:\runcor-lattice\abc-local\`

- **Preconditions:** none. `C:\runcor-lattice\` exists (it's the current working tree).
- **Change:** Shallow-clone or `Copy-Item -Recurse` the source repo into the new path, then `Remove-Item .git` so the fork starts a fresh history. Initial commit "import from agent-builder-console @ <SHA of source HEAD>". `data-abc/out/` is **not** copied — it stays only under `C:\runcor-lattice\data-abc\out\`.
- **Files touched (new fork):** all files copied verbatim from source; new `README.md` line "Forked from agent-builder-console for local-only deployment. See `C:\runcor-lattice\data-abc\out\plan.md`." appended.
- **Test:** `Get-ChildItem C:\runcor-lattice\abc-local\src\App.tsx` exists; `git -C C:\runcor-lattice\abc-local log --oneline` shows exactly one commit.
- **Rollback:** `Remove-Item -Recurse -Force C:\runcor-lattice\abc-local\`. Source repo is untouched (read-only constraint).

### A2. Pick one package manager, delete the other lockfile

- **Preconditions:** A1.
- **Change:** Per `vulnerabilities.md` F22 ("dual lockfiles, no documented install command"), keep `package-lock.json` (npm — most portable on Windows without extra installs) and delete `bun.lockb`. Add `"engines": { "node": ">=20" }` to `package.json` (per `migration.md` §1 target: Node ≥ 20).
- **Files touched:** `package.json`, `bun.lockb` (deleted).
- **Test:** `npm ci` completes with no errors; `node -v` ≥ v20.
- **Rollback:** `git checkout -- bun.lockb package.json` in the fork.

### A3. Tighten `.gitignore` and split `.env`

- **Preconditions:** A1.
- **Change:** Per `vulnerabilities.md` F01 (".env committed; gitignore has no .env entry — `.gitignore:1-25`") add the lines `.env`, `.env.*`, `!.env.example`, `data/`, `*.sqlite`, `*.sqlite-journal` to `.gitignore`. `git rm --cached .env`. Create `.env.example` listing only the variables the **frontend** needs (after this migration: `VITE_LOCAL_API_URL=http://127.0.0.1:8787`); the existing browser-shipped Supabase URL/anon JWT (`.env:1-3` in source) are dropped here in anticipation of Phase F. The Supabase JWT in the source file (`migration.md` §6) was already public-by-design but is now also gone from the fork.
- **Files touched:** `.gitignore`, `.env` (removed from index), new `.env.example`.
- **Test:** `git -C C:\runcor-lattice\abc-local check-ignore .env` prints `.env`; `git ls-files | rg "^\.env$"` returns nothing.
- **Rollback:** `git checkout -- .gitignore`, restore `.env` from source.

### A4. Confirm UI boots unchanged against the legacy Supabase backend

- **Preconditions:** A1–A3. Network connectivity to `tkppayricdwsogopxxzp.supabase.co`.
- **Change:** None — sanity check only. Temporarily restore `.env` (not committed) to point at the legacy backend.
- **Files touched:** none (temporary local-only `.env`).
- **Test:** `npm run dev`, open `http://localhost:8080/` (the current `vite.config.ts:9-10` bind), verify the main canvas renders and the Help modal opens. No regressions versus the source repo at this point are expected — this is the “before” baseline.
- **Rollback:** stop `vite`; delete the temporary `.env`.

---

## Phase B — Local server scaffold (no behavior yet, just routing)

Goal: a Node process listening on `127.0.0.1:8787` that exposes the same `/functions/v1/<name>` URL shape used by every SPA call site (`migration.md` §2 row A2), but returns `501 Not Implemented` for every route. Exit criterion: the SPA can be pointed at this server via env var and every UI call gets a structured `501` without throwing — proving the seam works before any logic moves.

### B1. Add the `server/` subtree and a route registry

- **Preconditions:** A2.
- **Change:** Create `server/package.json` (a workspace member; see B2), `server/src/index.ts`, `server/src/routes.ts`. Use `fastify` + `@fastify/cors` (chosen because `fastify` has first-class SSE support per `migration.md` R3 risk, and a smaller dependency surface than Express + body-parser + cors). The route registry exports a single array `routes: Array<{ method, path, handler }>` with one entry per former edge function (22 routes, names from `supabase/config.toml:1-68`, listed in `migration.md` §3); each handler is `(_req, reply) => reply.code(501).send({ error: "not implemented" })`.
- **Files touched:** `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`, `server/src/routes.ts`.
- **Test:** `npm --workspace server run dev`, then `Invoke-RestMethod -Method Post http://127.0.0.1:8787/functions/v1/time` returns `{ error: "not implemented" }` with status 501.
- **Rollback:** `Remove-Item -Recurse server/`.

### B2. Promote the repo to an npm workspace

- **Preconditions:** A2, B1.
- **Change:** In root `package.json` add `"workspaces": ["server", "web"]` and rename the top-level SPA dir to `web/` (`Move-Item src web/src`, `Move-Item public web/public`, `Move-Item index.html web/index.html`, `Move-Item vite.config.ts web/vite.config.ts`, `Move-Item tsconfig*.json web/`, plus tailwind/postcss/eslint configs). The SPA's import alias `@/* → ./src/*` (`tsconfig.json:7` in source, per `features.md` §9) is preserved relative to `web/`. Create `web/package.json` carved from the original `package.json` (UI deps only). Keep root `package.json` for shared scripts and `engines`.
- **Files touched:** `package.json`, `web/**` (moved), `server/**` (already exists), `tsconfig.json` references.
- **Test:** `npm install` from root resolves both workspaces; `npm --workspace web run dev` boots Vite; `npm --workspace server run dev` boots Fastify.
- **Rollback:** `git reset --hard` to the post-A3 commit.

### B3. Add a `dev` orchestrator that boots web + server together [P]

- **Preconditions:** B2.
- **Change:** Per `migration.md` §6 ("Launch via a single `pnpm dev` script that spawns both"), add `concurrently` as a root dev-dep and a root `npm run dev` script: `concurrently -k -n server,web "npm --workspace server run dev" "npm --workspace web run dev"`. Keep separate scripts for isolated runs.
- **Files touched:** root `package.json`.
- **Test:** `npm run dev` from the fork root starts both processes; Ctrl+C cleanly tears down both.
- **Rollback:** delete the script and dep.

### B4. Restrict CORS to loopback origins only

- **Preconditions:** B1, B2.
- **Change:** Per `vulnerabilities.md` F08 ("Wildcard CORS on every function") and `migration.md` §2 row A7 ("Strict origin allowlist = `http://127.0.0.1:5173` and `http://127.0.0.1:4173`"), register `@fastify/cors` with `origin: ['http://127.0.0.1:5173', 'http://127.0.0.1:4173']` and `credentials: false`. Reject any `Origin` header outside the list (Fastify returns 500 by default on disallowed origin — convert to 403 via the plugin's `onError`).
- **Files touched:** `server/src/index.ts`.
- **Test:** `curl -i -H "Origin: http://evil.example" http://127.0.0.1:8787/functions/v1/time` returns no `Access-Control-Allow-Origin` header; same request with `Origin: http://127.0.0.1:5173` includes the header echoed back.
- **Rollback:** remove the CORS plugin registration.

### B5. Migrate Vite dev server bind to loopback + new port [P]

- **Preconditions:** B2.
- **Change:** Per `migration.md` §6 ("`host: "127.0.0.1"` (loopback only) on 5173") and `vite.config.ts:7-11` source-side, edit `web/vite.config.ts` to set `server.host = '127.0.0.1'` and `server.port = 5173`. **Defer** the `lovable-tagger` removal until G2 — this step changes binding only so B4 can be validated.
- **Files touched:** `web/vite.config.ts`.
- **Test:** `npm --workspace web run dev`; only `http://127.0.0.1:5173` responds (not `http://[::]:8080`).
- **Rollback:** revert `web/vite.config.ts`.

---

## Phase C — SQLite swap (persistence + the `external-db` handler)

Goal: replace the three fragmented persistence layers (browser localStorage Supabase session, sessionStorage secrets, user-supplied Postgres for `external-db`) with one local SQLite file. Done before the wholesale endpoint port (Phase D) because (a) several endpoints will need DB access during port (`free-agent` audit log, `external-db` itself), and (b) it's the highest-risk port per `migration.md` R1 — getting it right first de-risks the rest. Exit criterion: `external-db` route, alone among the 22, returns real schema introspection from a SQLite file and rejects multi-statement / DDL-without-write-mode payloads.

### C1. Pick the SQLite file location

- **Preconditions:** B2.
- **Change:** Per `migration.md` §2 row A4 ("one file under the user's app data dir, e.g. `%APPDATA%\agent-builder-console\app.sqlite`"), the app SQLite path is computed at runtime as `path.join(os.homedir(), '.abc-local', 'app.sqlite')` (cross-platform; on Windows this resolves under `%USERPROFILE%`). Override via `ABC_DB_PATH` env var. **Document** that the working repo's `data/` directory (gitignored by A3) is reserved for **user-attached** `.sqlite` files only (the new shape of `external-db`'s target), not for the app DB.
- **Files touched:** `server/src/db/path.ts` (new).
- **Test:** `node -e "require('./server/dist/db/path').dbPath()"` prints an absolute path under the home directory; setting `$env:ABC_DB_PATH = 'C:\tmp\t.sqlite'` overrides it.
- **Rollback:** delete `server/src/db/path.ts`.

### C2. Add `better-sqlite3` and a connection module

- **Preconditions:** C1.
- **Change:** Per `migration.md` §1 ("SQLite (`better-sqlite3`) as the sole persistent store") and §2 row A10, `npm --workspace server install better-sqlite3 @types/better-sqlite3`. Create `server/src/db/index.ts` that opens the DB at C1's path with `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`. Export a singleton `db`.
- **Files touched:** `server/package.json`, `server/src/db/index.ts`.
- **Test:** `node -e "require('./server/dist/db').default.prepare('select 1 as one').get()"` prints `{ one: 1 }`.
- **Rollback:** uninstall the deps, delete the file.

### C3. Author the initial schema migration

- **Preconditions:** C2.
- **Change:** Per `migration.md` §4 schema table, create `server/src/db/migrations/0001_init.sql` with `secrets`, `tool_instances`, `sessions`, `iterations`, `workflows`, `audit_log` tables. Apply on startup if `PRAGMA user_version = 0`. **Do not** carry over the source Supabase migrations (`supabase/migrations/20260103043037_*.sql`, `20260103043934_*.sql`) — `vulnerabilities.md` F02 documents those as fully open RLS, and `migration.md` §2 row A4 confirms the SPA never relied on Supabase Postgres for app data.
- **Files touched:** `server/src/db/migrations/0001_init.sql`, `server/src/db/migrate.ts`.
- **Test:** Start server with a fresh `ABC_DB_PATH`; `sqlite3 <db> ".tables"` lists all six tables; `PRAGMA user_version` returns `1`.
- **Rollback:** `Remove-Item $env:ABC_DB_PATH`; the next start re-creates from scratch.

### C4. Build the per-table repository modules [P after C3]

- **Preconditions:** C3.
- **Change:** Create `server/src/db/repos/{secrets,toolInstances,sessions,workflows,audit}.ts`. Each exposes only the named operations that an actual SPA caller needs — derived by grepping `src/hooks/useSecretsManager.ts:15-44`, `src/hooks/useToolInstances.ts`, `src/utils/sessionExporter.ts`, `src/pages/Index.tsx:929-954, 1026-1090` (call sites enumerated in `migration.md` §4). No generic CRUD endpoints.
- **Files touched:** `server/src/db/repos/*.ts`.
- **Test:** `npm --workspace server test -- repos` (vitest) covers a happy-path read/write/delete for each repo against a tmp DB.
- **Rollback:** delete the directory.

### C5. Port the `external-db` handler (Postgres → SQLite)

- **Preconditions:** C2, C3.
- **Change:** Replace `supabase/functions/external-db/index.ts:270-491` with a Fastify handler at `POST /functions/v1/external-db`. Contract preserved from source `:276-284`: `{ action: "schemas" | "query", file?: string, query?: string, params?: any[], mode?: "read" | "write" }`. Differences from the Postgres original:
  - `file` is a path on the local filesystem; default = the app DB (C1). Reject paths that escape `os.homedir()` unless `ABC_ALLOW_ANY_SQLITE=1`.
  - `action: "schemas"` introspects via `sqlite_master` + `PRAGMA table_info(<name>)` (replaces the Postgres `SCHEMA_INTROSPECTION_QUERY` at source `:307`, called out as the highest porting risk in `migration.md` R1).
  - `action: "query"` enforces a **single statement** (count `;` after trimming trailing whitespace; reject ≥2). Rejects any statement starting with `BEGIN|COMMIT|ROLLBACK|PRAGMA|ATTACH|DETACH|VACUUM` unless `mode === "write"`. Statements starting with `INSERT|UPDATE|DELETE|CREATE|DROP|ALTER` require `mode: "write"` — closes `vulnerabilities.md` C2/F06 ("`isWrite` is descriptive, not enforced").
  - Wraps non-`SELECT` writes in `BEGIN IMMEDIATE; … ; COMMIT;`.
  - No multi-result-set support (Postgres-specific).
- **Files touched:** `server/src/routes/external-db.ts`, `server/src/routes.ts` (wire it up).
- **Test:** `curl -X POST http://127.0.0.1:8787/functions/v1/external-db -d '{"action":"schemas"}'` returns the six tables from C3; `curl -d '{"action":"query","query":"select 1; select 2;"}'` returns a 400 (multi-statement); `curl -d '{"action":"query","query":"delete from secrets"}'` returns a 403 (writes without `mode: "write"`).
- **Rollback:** revert `routes.ts` registration; the source endpoint never existed in this repo, so the fallback is "no external-db endpoint at all".

### C6. Mark `pronghorn-post` and `send-email` as `501 not migrated` (placeholder stubs)

- **Preconditions:** B1.
- **Change:** Per `migration.md` §8 ("Pronghorn / Resend — Dropped per local-only constraint") and the user's local-only rule, leave the auto-generated 501 from B1 in place for `/functions/v1/send-email` and `/functions/v1/pronghorn-post`, but customize the response body to `{ error: "not_in_local_only_build", doc: "see data-abc/out/migration.md §8" }`. Done here (not in Phase J) so the toolsManifest trim in J1 has stable error contracts to test against.
- **Files touched:** `server/src/routes/send-email.ts`, `server/src/routes/pronghorn-post.ts`, `server/src/routes.ts`.
- **Test:** `curl -X POST http://127.0.0.1:8787/functions/v1/send-email -d '{}'` returns `{ error: "not_in_local_only_build", ... }` and status 501.
- **Rollback:** revert both files to the generic 501 stub.

---

## Phase D — Edge function port (20 routes; the two stubs are already done)

Goal: replace each of the remaining 20 Supabase Edge Function bodies with a Fastify handler. Each step keeps the request/response shape from the source so the SPA needs **no per-endpoint frontend change** beyond the base URL swap in Phase E. Per `migration.md` §3, each handler is mechanical except where called out.

Order rule inside the phase: pure-compute first (`time`), then read-only upstream calls (`tool_weather`, `weather`, `get-elevenlabs-voices`, `tool_pdf-handler`, `tool_zip-handler`), then keyed-API calls (`brave-search`, `google-search`, `elevenlabs-tts`, `run-nano`, `tool_ocr-handler`), then SSE streamers (`run-agent`, `run-agent-anthropic`, `run-agent-xai`), then the risky outbound multiplexers (`web-scrape`, `api-call`, `github-fetch`, `enhance-prompt`), then `free-agent` last because it dispatches into every other route (see Phase G).

Each step in this phase follows the same shape — to avoid repetition, the table below has one row per route, and the universal preconditions / test pattern is stated once.

**Universal preconditions for D1–D20:** B1 (route registry exists), B2 (workspace), and the keyed routes additionally require F1 (`.env.server` with provider keys).

**Universal test pattern:** ad-hoc `curl` against the new route returns the same JSON shape the source function returned; for SSE routes, `curl -N` shows the same `data: {...}\n\n` framing.

**Universal rollback:** revert the new handler file + `routes.ts` entry; the route reverts to the 501 stub from B1.

| Step | Route | Source file | Migration-specific changes (citing `migration.md` §3 and `vulnerabilities.md`) | Touched files |
|---|---|---|---|---|
| D1 | `POST /functions/v1/time` | `supabase/functions/time/index.ts:1` | Pure compute (`Intl` + `Date`). No upstream. (`migration.md` §3 row 17) | `server/src/routes/time.ts` |
| D2 | `POST /functions/v1/tool_weather` | `supabase/functions/tool_weather/index.ts:1, 24, 44` | Open-Meteo, no auth. (`migration.md` §3 row 16) | `server/src/routes/tool_weather.ts` |
| D3 [P] | `POST /functions/v1/weather` | `supabase/functions/weather/index.ts:1, 27` | Legacy; keep for compat. Per `vulnerabilities.md` F24, **before merging:** grep `web/src/**` for callers and delete this route if no caller is found. | `server/src/routes/weather.ts` |
| D4 | `GET /functions/v1/get-elevenlabs-voices` | `supabase/functions/get-elevenlabs-voices/index.ts:1, 14, 22-23` | Only GET endpoint. (`migration.md` §3 row 14) | `server/src/routes/get-elevenlabs-voices.ts` |
| D5 | `POST /functions/v1/tool_pdf-handler` | `supabase/functions/tool_pdf-handler/index.ts:1, 23` | Use existing `pdfjs-dist@5.4.296` (already in source `package.json:57`). Add 25 MB body cap per `vulnerabilities.md` L4. | `server/src/routes/tool_pdf-handler.ts` |
| D6 | `POST /functions/v1/tool_zip-handler` | `supabase/functions/tool_zip-handler/index.ts:1-2, 36` | Use existing `jszip@3.10.1` (source `package.json:53`) instead of Deno zipjs. Add declared-size cap per `vulnerabilities.md` L4 (ZIP bomb mitigation). | `server/src/routes/tool_zip-handler.ts` |
| D7 [P] | `POST /functions/v1/brave-search` | `supabase/functions/brave-search/index.ts:1, 24, 42` | Secret-source change only (`process.env.BRAVE_API_KEY`). | `server/src/routes/brave-search.ts` |
| D8 [P] | `POST /functions/v1/google-search` | `supabase/functions/google-search/index.ts:1, 48` | Secret-source change only. | `server/src/routes/google-search.ts` |
| D9 [P] | `POST /functions/v1/elevenlabs-tts` | `supabase/functions/elevenlabs-tts/index.ts:1-3, 26, 34-35` | Secret-source change only. | `server/src/routes/elevenlabs-tts.ts` |
| D10 | `POST /functions/v1/run-nano` | `supabase/functions/run-nano/index.ts:1, 32, 56-58` | Gemini call, used by `image_generation` per source `src/lib/functionExecutor.ts:581`. | `server/src/routes/run-nano.ts` |
| D11 | `POST /functions/v1/tool_ocr-handler` | `supabase/functions/tool_ocr-handler/index.ts:1, 49-50, 86-88, 158-160` | Google Vision primary; Gemini fallback. Two provider keys. | `server/src/routes/tool_ocr-handler.ts` |
| D12 | `POST /functions/v1/run-agent` (SSE) | `supabase/functions/run-agent/index.ts:1, 31, 51, 66, 77, 88, 101, 148-180, 305-320` | SSE port via Fastify reply.raw (per `migration.md` R3 risk). **Drop the `BLOCK_NONE` safety override at source `:163-180`** (`vulnerabilities.md` C5/F09 — default to `BLOCK_MEDIUM_AND_ABOVE`). **Strip the `stack` field at source `:305-320`** (`vulnerabilities.md` M4/F11). | `server/src/routes/run-agent.ts` |
| D13 [P] | `POST /functions/v1/run-agent-anthropic` (SSE) | `supabase/functions/run-agent-anthropic/index.ts:1, 18, 125-126, 236-244` | SSE port. Strip stack from error response (source `:236-244`, `vulnerabilities.md` F11). | `server/src/routes/run-agent-anthropic.ts` |
| D14 [P] | `POST /functions/v1/run-agent-xai` (SSE) | `supabase/functions/run-agent-xai/index.ts:1, 23, 47, 102-103` | SSE port. | `server/src/routes/run-agent-xai.ts` |
| D15 | `POST /functions/v1/web-scrape` | `supabase/functions/web-scrape/index.ts:1, 99-198, 590, 669` | Apply hostname allowlist + RFC1918/metadata-IP block (`vulnerabilities.md` C3/F05). Replace `unpdf` jsdelivr import with `npm:unpdf` (new dep, per `migration.md` R2). `mammoth` already in `package.json:55`. **Remove UA-spoofing / faked `Referer: https://www.google.com/`** (source `:99-130`, `vulnerabilities.md` F05). | `server/src/routes/web-scrape.ts`, `server/package.json` (add `unpdf`) |
| D16 | `POST /functions/v1/api-call` | `supabase/functions/api-call/index.ts:1, 9-41, 53-113` | Apply hostname allowlist + RFC1918/metadata-IP block (`vulnerabilities.md` C3/F04). Set `redirect: "manual"` and re-validate each hop. | `server/src/routes/api-call.ts` |
| D17 | `POST /functions/v1/github-fetch` | `supabase/functions/github-fetch/index.ts:1, 8, 33, 117-118, 281-407` | **Drop the server-side `GITHUB_TOKEN`** (`vulnerabilities.md` H4). User supplies a PAT via the local Secrets Manager (Phase F) if private-repo access is needed. | `server/src/routes/github-fetch.ts` |
| D18 [P] | `POST /functions/v1/enhance-prompt` | `supabase/functions/enhance-prompt/index.ts:1-2, 35-99` | Multi-provider; same secret pattern as D12–D14. | `server/src/routes/enhance-prompt.ts` |
| D19 | `POST /functions/v1/free-agent` (dispatch) | `supabase/functions/free-agent/index.ts:1-100, 805-944` | **Port the tool-dispatch loop but keep `fetch`-based dispatch in this step** — the in-process collapse is its own step (G1). Add interactive approval gate in front of privileged tools (`execute_sql`, `spawn`, `write_self`, anything the user opts into) per `migration.md` §3 row 5 / `vulnerabilities.md` H5, H6, M3. Add server-side recursion-depth + cumulative-iteration cap per `migration.md` R4 (today only `maxChildren ?? 5` enforced client-side at source `src/lib/freeAgentToolExecutor.ts:943-947`). | `server/src/routes/free-agent.ts`, `server/src/lib/approvalGate.ts` (new) |
| D20 | Body validation sweep across D1–D19 | n/a | Add a Zod `schema.parse(req.body)` at the top of every D-route per `vulnerabilities.md` M7/F17 (zod already in source `package.json:72`, never imported by any function). One PR-worth of mechanical edits. | every `server/src/routes/*.ts` |

After D20, all 22 endpoints exist on the local server with parity behaviour plus the migration-mandated hardening. The legacy Supabase backend is still reachable, but not used by anything local once Phase E lands.

---

## Phase E — Frontend integration seam (point the SPA at the local server)

Goal: redirect the SPA's network surface from Supabase to the local server with a **single config flip**, then prove no Supabase call sites remain. Exit criterion: the SPA, with the Supabase JS client uninstalled and `VITE_SUPABASE_URL` removed, can drive every workflow against the local server.

### E1. Introduce a single `apiBase()` helper

- **Preconditions:** D20.
- **Change:** Per `migration.md` R6 ("a single `apiBase()` helper avoids future drift"), create `web/src/lib/apiBase.ts` exporting `apiBase()` that returns `import.meta.env.VITE_LOCAL_API_URL ?? 'http://127.0.0.1:8787'`. Refactor the 12 direct-`fetch` sites enumerated in `migration.md` §5 item 1 (`src/lib/functionExecutor.ts:581, 633, 685, 732, 799, 936, 1010, 1061, 1330`; `src/pages/Index.tsx:1373, 2127, 2675`; `src/components/properties/PropertiesPanel.tsx:130`; `src/components/github/GitHubTreeModal.tsx:67, 253`; `src/components/freeAgent/EnhancePromptModal.tsx:224`; `src/components/freeAgent/ReflectModal.tsx:127`) to use `${apiBase()}/functions/v1/<name>` instead of `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/<name>`. Also drop the `apikey`/`Authorization: Bearer <anon JWT>` headers (per `migration.md` §5 item 1).
- **Files touched:** `web/src/lib/apiBase.ts` (new) + 7 callers above.
- **Test:** `grep -r "VITE_SUPABASE_URL" web/src/` returns nothing; `grep -r "apiBase()" web/src/` returns at least 17 matches (12 + the 5 listed in the helper rollout).
- **Rollback:** `git checkout -- web/src/`.

### E2. Replace `supabase.functions.invoke(...)` with `localInvoke(...)`

- **Preconditions:** E1.
- **Change:** Per `migration.md` §5 item 2, create `web/src/lib/localInvoke.ts` that does `fetch + JSON parse` and returns `{ data, error }` mimicking the Supabase shape. Rewrite the three callers: `src/hooks/useFreeAgentSession.ts:332, 1103`; `src/lib/freeAgentToolExecutor.ts:564`.
- **Files touched:** `web/src/lib/localInvoke.ts` (new), `web/src/hooks/useFreeAgentSession.ts`, `web/src/lib/freeAgentToolExecutor.ts`.
- **Test:** `grep -r "supabase\.functions\.invoke" web/src/` returns nothing. Run the SPA, trigger one Free Agent iteration that calls a tool — log should show a `POST` to `http://127.0.0.1:8787/functions/v1/<tool>`.
- **Rollback:** revert the three files; the helper file becomes orphan but harmless.

### E3. Delete the Supabase client construction

- **Preconditions:** E2.
- **Change:** Per `migration.md` §5 item 3, delete `web/src/integrations/supabase/client.ts:1-17` and the now-unused `web/src/integrations/supabase/types.ts`. Remove `@supabase/supabase-js` from `web/package.json:42` (`npm --workspace web uninstall @supabase/supabase-js`). Search-and-fix any straggler imports of `@/integrations/supabase/client` (none expected after E2; if found, replace with `localInvoke`).
- **Files touched:** `web/src/integrations/supabase/**` (deleted), `web/package.json`.
- **Test:** `npm --workspace web run build` succeeds; `grep -r "@supabase" web/src/` returns nothing; the resulting bundle has no `supabase-js` chunk.
- **Rollback:** `git checkout` the deleted files; reinstall the dep.

### E4. Update `.env.example` to declare only the frontend's new surface

- **Preconditions:** E3.
- **Change:** Rewrite `web/.env.example` (and the root `.env.example` from A3) to a single line: `VITE_LOCAL_API_URL=http://127.0.0.1:8787`. The browser-shipped Supabase URL/anon JWT (source `.env:1-3`) are gone.
- **Files touched:** `web/.env.example`, `.env.example`.
- **Test:** `npm --workspace web run dev` boots with no env file present (uses the helper default).
- **Rollback:** restore the previous file contents.

---

## Phase F — Auth strip & server-side secret relocation

Goal: explicitly remove every Supabase-auth-shaped artefact from the SPA and codify the server-side secret model. Exit criterion: `git ls-files | rg "supabase"` returns only deleted (tombstone) entries in the history; provider keys live in a single gitignored `.env.server` outside the SPA bundle.

### F1. Establish `.env.server` and load it on server start

- **Preconditions:** B2, A3 (gitignore covers `.env*`).
- **Change:** Per `migration.md` §6 ("Local-server-side `.env.server` (also gitignored) holds provider keys"), add `dotenv` to `server/package.json` and `import 'dotenv/config'` at the top of `server/src/index.ts`, configured to read `.env.server` from the fork root. Document the full key inventory from `migration.md` §2 row A6 in `.env.server.example`: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `BRAVE_API_KEY` (optional), `GOOGLE_VISION_API_KEY` (optional), `ELEVENLABS_API_KEY` (optional). Per F17/D17, **`GITHUB_TOKEN` is intentionally omitted** (`vulnerabilities.md` H4 / source `supabase/functions/github-fetch/index.ts:8`).
- **Files touched:** `server/src/index.ts`, `.env.server.example`, `.gitignore` (confirm `.env.server` is covered by the `.env.*` rule from A3).
- **Test:** Start the server with `.env.server` containing `GEMINI_API_KEY=test`; the server logs the **presence** (not the value) of each known key at startup.
- **Rollback:** revert the loader; keys would have to be set in the environment directly.

### F2. Move secret storage to encrypted SQLite (`secrets` table from C3)

- **Preconditions:** C4 (`secrets` repo exists), F1.
- **Change:** Per `migration.md` §4 + `vulnerabilities.md` M1/F13 ("API keys stored unencrypted in sessionStorage"), add `keytar` (or fallback to a passphrase prompt) to `server/`. Derive a key on first run, store the secret material `value_encrypted BLOB` in the `secrets` table. Add two server routes (not under `/functions/v1/` — these are local-only management ops): `POST /api/secrets` (set), `GET /api/secrets` (list names only — never values), `DELETE /api/secrets/:name`. Frontend's `src/hooks/useSecretsManager.ts:15-44, 38-44` switches from `sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config))` to calling those routes.
- **Files touched:** `server/src/routes/secrets.ts`, `server/src/lib/secretsCrypto.ts`, `web/src/hooks/useSecretsManager.ts`.
- **Test:** Set a secret via the UI, restart the server, restart the SPA → secret persists; the SQLite row's `value_encrypted` column shows ciphertext (not the plaintext value).
- **Rollback:** revert the hook + delete the routes. SessionStorage path is still in git history.

### F3. Delete `supabase/` directory tree from the fork

- **Preconditions:** D1–D20 complete (every route ported), E3 (no SPA-side references to Supabase).
- **Change:** `Remove-Item -Recurse -Force C:\runcor-lattice\abc-local\supabase\`. This removes the 22 edge-function source files, both SQL migrations (`supabase/migrations/20260103043037_*.sql`, `20260103043934_*.sql` — confirmed unused by `migration.md` §2 row A4), and `supabase/config.toml`.
- **Files touched:** `supabase/**` (deleted).
- **Test:** `Get-ChildItem C:\runcor-lattice\abc-local\supabase` errors with "path not found"; `npm --workspace web run build` still succeeds; `npm --workspace server run dev` still serves all 22 routes.
- **Rollback:** `git checkout HEAD~1 -- supabase/` from the prior commit.

### F4. Strip `supabase` references from build configs and docs

- **Preconditions:** F3.
- **Change:** Remove any `supabase` mentions from `web/vite.config.ts`, `web/tsconfig*.json`, `README.md`. Update root `README.md` to point at `data-abc/out/plan.md` for setup instructions.
- **Files touched:** `README.md`, `web/README.md` if present.
- **Test:** `grep -r "supabase" .` in the fork (excluding `node_modules` and `.git`) returns nothing.
- **Rollback:** `git checkout -- README.md`.

---

## Phase G — Free-Agent in-process dispatch (the one non-mechanical port)

Goal: collapse `free-agent`'s per-iteration outbound `fetch` to sibling routes into in-process function calls, per `migration.md` §7. Exit criterion: a Free Agent iteration that triggers a tool call shows zero loopback HTTP requests in the server log (because the dispatch is in-process), while preserving identical observable behaviour to D19.

### G1. Introduce `invokeLocalHandler(name, body)` and rewire `free-agent`

- **Preconditions:** D19 (free-agent route exists with outbound fetch), D1–D18 (every callee exists in-process).
- **Change:** Per `migration.md` §7 code sketch, refactor each `server/src/routes/<route>.ts` to export not just the Fastify handler but also a pure `runHandler(body, ctx)` function. The Fastify wrapper becomes `(req, reply) => reply.send(await runHandler(req.body, ctx))`. In `server/src/routes/free-agent.ts`, replace `fetch(\`${supabaseUrl}/functions/v1/${tool.edge_function}\`, …)` (source `supabase/functions/free-agent/index.ts:805-944`, especially the dispatch around `:820-840`) with `await invokeLocalHandler(tool.edge_function, body)` where `invokeLocalHandler` looks up the handler in a `Map<string, Handler>` built at server boot.
- **Files touched:** all `server/src/routes/*.ts`, new `server/src/lib/invokeLocalHandler.ts`.
- **Test:** Start server with `npm --workspace server run dev`, trigger a Free Agent run that calls `tool_weather`; the server access log shows `POST /functions/v1/free-agent` but **no** `POST /functions/v1/tool_weather` (the inner call is in-process). The Free Agent output is identical to a pre-G1 snapshot recorded against D19.
- **Rollback:** revert `free-agent.ts` to the `fetch`-based dispatch from D19; in-process map becomes unused but harmless.

---

## Phase H — Build & dev-tooling cleanup

Goal: remove vendor-specific tooling that no longer fits a local-only build. Independent of D/E/F/G — can run in parallel with any of them once B2 lands.

### H1. Remove `lovable-tagger`

- **Preconditions:** B2.
- **Change:** Per `migration.md` §6 + `vulnerabilities.md` M9, delete `lovable-tagger` from `web/package.json` (source `package.json:86`) and remove its registration in `web/vite.config.ts` (source `vite.config.ts:4, 12` — the `mode === "development" && componentTagger()` clause).
- **Files touched:** `web/package.json`, `web/vite.config.ts`.
- **Test:** `npm --workspace web run dev` boots without errors; `npm --workspace web run build` succeeds; grep confirms `lovable-tagger` is gone from `package-lock.json`.
- **Rollback:** `npm --workspace web install lovable-tagger`, revert `vite.config.ts`.

### H2. Tighten `tsconfig`

- **Preconditions:** B2.
- **Change:** The source `tsconfig.json:1-15` (per `features.md` §9) has `noImplicitAny: false`, `strictNullChecks: false` — flagged by `vulnerabilities.md` L8/F23 ("`error: any` catch blocks defeat narrowing"). Flip to `"strict": true` + `"noImplicitAny": true` in `web/tsconfig.app.json`; mark this step **scope-limited** to surfacing errors only — fixes that the type-check raises are filed as a follow-up backlog file `data-abc/out/typecheck-followups.md` rather than blocking the migration.
- **Files touched:** `web/tsconfig.app.json`, new `data-abc/out/typecheck-followups.md`.
- **Test:** `npm --workspace web run build` either passes or fails with a captured error list; either outcome is acceptable for this step (only the documentation deliverable is required).
- **Rollback:** revert `tsconfig.app.json`; delete `typecheck-followups.md`.

### H3. Add a minimal Content-Security-Policy meta tag

- **Preconditions:** B2.
- **Change:** Per `vulnerabilities.md` M8/F18, add `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://127.0.0.1:8787; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'">` to `web/index.html`. The `connect-src` whitelists only the local server.
- **Files touched:** `web/index.html`.
- **Test:** Load `http://127.0.0.1:5173/` with devtools open → no CSP violations in console for normal usage.
- **Rollback:** delete the meta tag.

---

## Phase I — Artefact relocation & dropped-feature cleanup

Goal: trim the tool manifest and other in-repo artefacts to match the local-only feature set per `migration.md` §8. Done after Phase G so the in-process dispatch can be tested against the trimmed manifest.

### I1. Trim `toolsManifest.json` to remove dropped tools

- **Preconditions:** G1, C6.
- **Change:** Per `migration.md` §8, edit `web/public/data/toolsManifest.json` to remove the entries for `send_email` (source `public/data/toolsManifest.json:616-653`) and `pronghorn_post` (source `:817-873`). The 33-tool catalog drops to 31. Keep the `execute_sql` / `read_database_schemas` entries (source `:938-1006`) — they now point at the SQLite `external-db` route (C5).
- **Files touched:** `web/public/data/toolsManifest.json`.
- **Test:** Open the Free Agent canvas; tool clusters render without "send email" and "pronghorn post" tools; existing sessions that referenced them surface a clear error rather than silently retrying.
- **Rollback:** restore the manifest from git history.

### I2. Adjust the system-prompt template wording

- **Preconditions:** I1.
- **Change:** `web/public/data/systemPromptTemplate.json` references "the email tool" / "the Pronghorn relay" in prose sections (grep before editing). Remove those references; add a short prose pointer to `external-db` as the SQLite-backed query/persistence tool. Versioning per `features.md` §4 (`usePromptCustomization` "validates against template v1.1.0 section IDs") — bump to `1.2.0` and document the change in a `CHANGELOG.md` paragraph in `web/public/data/`.
- **Files touched:** `web/public/data/systemPromptTemplate.json`, `web/public/data/CHANGELOG.md` (new).
- **Test:** Open the system-prompt viewer; no broken section IDs in the validator; new wording is visible.
- **Rollback:** revert the JSON; delete the changelog file.

### I3. Move analysis deliverables out of any docs-rooted location

- **Preconditions:** A1.
- **Change:** Sanity-confirm the deliverables tree is `C:\runcor-lattice\data-abc\out\` (already in place — `features.md`, `migration.md`, `vulnerabilities.md`, `plan.md`, `_meta-status.md`, `_run-analysis.md`). The fork's own `README.md` links to `C:\runcor-lattice\data-abc\out\plan.md` but holds no copies of these files (per `[[feedback_local_only]]` — deliverables stay under `data-abc/out/`).
- **Files touched:** none new; verification only.
- **Test:** `Get-ChildItem C:\runcor-lattice\abc-local -Recurse -Filter "*.md" | Select-String "Source repository: \`C:\\agent-builder-console\`"` returns no matches inside the fork (deliverables are not duplicated there).
- **Rollback:** n/a (no change).

---

## Phase J — Verification & smoke tests

Goal: end-to-end proof that the migrated app passes the major user workflows enumerated in `features.md` §2. Exit criterion: a single checklist in this section can be walked top-to-bottom by anyone and signed off.

### J1. Compose a `data-abc/out/quickstart.md` against the fork

- **Preconditions:** F4 (no Supabase references left in the fork).
- **Change:** Write `data-abc/out/quickstart.md` (a new deliverable file) with the four commands:
  1. `git clone <fork> && cd abc-local && npm ci`
  2. `Copy-Item .env.server.example .env.server` and fill in provider keys.
  3. `npm run dev` (boots both server on `:8787` and web on `:5173`).
  4. Browse to `http://127.0.0.1:5173/`.
- **Files touched:** `data-abc/out/quickstart.md` (new).
- **Test:** Walk a clean Windows shell through the four steps from scratch on the same machine; the UI loads in under 30 s and one Free Agent iteration with `time` + `tool_weather` succeeds.
- **Rollback:** delete the file.

### J2. Smoke matrix: one call per route through the SPA

- **Preconditions:** G1, J1.
- **Change:** Build a one-page checklist in `data-abc/out/smoke.md` listing each of the 22 routes with a trigger (which UI control fires it) and an expected result. Routes intentionally returning 501 (`send-email`, `pronghorn-post` from C6) show a clear UI error per I1's manifest trim.
- **Files touched:** `data-abc/out/smoke.md` (new).
- **Test:** Walk every row in the checklist; every "expected" cell observed.
- **Rollback:** delete the file.

### J3. Capture residual-risk register

- **Preconditions:** J2.
- **Change:** Cross-check `migration.md` §9 (R1–R7) and `vulnerabilities.md` triage list against what each plan step closed. Write `data-abc/out/residual-risks.md` listing every finding **not** addressed (today, anticipated set: F02/F10 are moot once Supabase is gone; F09/F11/F12/F13/F22 closed by D12/F2/H1; F04–F07 closed by D15/D16/C5/C6/I1; F18 closed by H3; F14/F17 closed by D20 + redaction in D12). Track explicitly which `vulnerabilities.md` IDs remain open and why.
- **Files touched:** `data-abc/out/residual-risks.md` (new).
- **Test:** Every `vulnerabilities.md` finding appears either in the "closed" or "open" list. No findings unaccounted for.
- **Rollback:** delete the file.

---

## Cross-phase dependency graph (one-line view)

```
A1 → A2 → A3 → A4
A2 → B1 → B2 → {B3, B4, B5}
B2 → C1 → C2 → C3 → C4
B1, C3 → C5
B1 → C6
B1, B2, (F1 for keyed) → D1..D18
D19 needs B1+B2+F1; D20 sweeps D1..D19
D20 → E1 → E2 → E3 → E4
C4, F1 → F2; D1..D20, E3 → F3 → F4
D1..D19 → G1
B2 → {H1, H2, H3}
G1, C6 → I1 → I2; A1 → I3
F4 → J1 → J2 → J3
```

Phases A–C are strictly serial. Phases D–H can pipeline once their preconditions land. Phases I and J are the final two serial steps.

## Evidence index (files newly opened during this plan-authoring pass)

- `C:\runcor-lattice\data-abc\out\features.md` (full read) — feature inventory, dependency list, build/tooling table.
- `C:\runcor-lattice\data-abc\out\migration.md` (full read) — source→target architecture mapping and per-endpoint plan rows.
- `C:\runcor-lattice\data-abc\out\vulnerabilities.md` (full read) — F01–F25 audit findings cited by ID throughout.
- `C:\agent-builder-console\.env` (full read) — to confirm what to gitignore in A3.
- `C:\agent-builder-console\.gitignore` (full read) — to confirm what's missing.
- `C:\agent-builder-console\vite.config.ts` (full read) — to confirm `lovable-tagger` reference + dev-server bind.
- `C:\agent-builder-console\package.json` (full read) — to confirm dep inventory & scripts.
- `C:\agent-builder-console\supabase\functions\` directory listing — to confirm the 22-function count and names against `migration.md` §3.
- `C:\agent-builder-console\supabase\migrations\` directory listing — to confirm only the two SQL files exist and can be dropped (F3).

No file under `C:\agent-builder-console\` was modified by this pass (read-only constraint).
