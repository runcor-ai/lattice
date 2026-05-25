# ABC Privacy & Information-Management Plan (Local-Only Migration)

Scope: the local-only ABC port living under `C:\runcor-lattice\data-abc\`. Cited
ABC source paths are read-only references to `C:\agent-builder-console\` as it
exists today; nothing under that tree was modified.

Baseline observation: the current upstream ABC has **no privacy, classification,
redaction, or audit layer**. Grepping `src/` for `PII|protected.?b|audit|redact|
ministry|SIN|postal|sensitive` returns only:
- a one-token `sensitive?: boolean` flag on tool parameter metadata at
  `src\types\freeAgent.ts:358`, surfaced as a UI badge at
  `src\components\freeAgent\SecretsManagerModal.tsx:539`;
- the `caseSensitive` search option in `src\lib\functionDefinitions.ts:47-50`
  (unrelated).

No PII detector, no audit log, no classification gate, no policy hook. Every
control below has to be **wired in**, not just configured.

---

## 1. Protected B Handling

### Storage tier (mandatory)

| Tier              | Status   | Reason                                                                          |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| Local SQLite      | REQUIRED | Sole tier for any persisted ABC state in the local port.                        |
| Browser `sessionStorage` | ALLOWED for in-tab ephemera (secrets); MUST be cleared on session end. | Today's secret store at `src\hooks\useSecretsManager.ts:15,23,40`. |
| Browser `localStorage`   | DISALLOWED for content; allowed only for non-content UI prefs.        | Today used for prompt customizations at `src\lib\freeAgentToolExecutor.ts:854-858` and `src\hooks\useFreeAgentSession.ts:38` — must be reviewed and moved to SQLite. |
| Supabase / Render DB / any cloud | **FORBIDDEN**                                                  | Conflicts with local-only rule. See §5 for removal targets. |

### Data classes the local ABC may ingest

Ingestion surface = user prompt textarea + file uploads + Excel selector.
Concretely the entry points are `handleStart` in
`src\components\freeAgent\FreeAgentPanel.tsx:328-340` and the file pipeline at
`src\components\freeAgent\FreeAgentPanel.tsx:200-247` (text/docx/pdf/binary) plus
`src\utils\fileTextExtraction.ts:118-133` and `src\utils\parseExcel.ts` via the
`ExcelSelector` flow at `FreeAgentPanel.tsx:270-304`.

| Class                                  | Allowed? | Conditions                                                                  |
| -------------------------------------- | -------- | --------------------------------------------------------------------------- |
| Public / open data                     | YES      | No restrictions.                                                            |
| Internal / unclassified work product   | YES      | Default tier.                                                               |
| Protected A                            | YES      | Must pass §2 detector; logged per §3.                                       |
| Protected B                            | CONDITIONAL | Only with explicit user acknowledgement (modal); audit entry MUST be written before any tool call fires. |
| Protected C / classified               | **NO**   | Hard block at the classifier (§2).                                          |
| PHI / health record content            | **NO**   | Hard block.                                                                 |
| Live credentials (other than user-entered secrets in the Secrets Manager) | **NO** | Detected via §4 regex set; redacted before submission. |

### Retention defaults

- **Prompt text + uploaded file content**: in-memory for the life of the
  session. Sessions are explicitly *not* persisted today
  (`src\hooks\useFreeAgentSession.ts:38` clears the legacy
  `free_agent_sessions` key, and `updateSession` comment at
  `src\hooks\useFreeAgentSession.ts:134-137` notes "in-memory only — no
  localStorage persistence"). The local port MUST preserve this default.
- **Exported session ZIPs** (`src\utils\sessionExporter.ts:157-258`): retained
  only where the user saves them. The local port writes deliverables under
  `data-abc/out/`; default retention 30 days, rotated by the audit job (§3).
- **Secrets** (`src\hooks\useSecretsManager.ts:23,40`): cleared on tab close
  (sessionStorage). `clearAll` at `src\hooks\useSecretsManager.ts:362-369` must
  be invoked on logout / session end.
- **Audit log** (§3): 90 days, then rotated.

### DO-NOT list

- DO NOT pipe user prompts or file contents to `supabase.functions.invoke(...)`
  — every existing call site
  (`src\hooks\useFreeAgentSession.ts:332-380`,
   `src\hooks\useFreeAgentSession.ts:1103-1143`,
   `src\lib\freeAgentToolExecutor.ts:564`) is a Protected-B leak in the local
  port and must be replaced (see §5).
- DO NOT include secret *values* in any export. Default of
  `exportConfig(includeValues = false)` at
  `src\hooks\useSecretsManager.ts:284-297` MUST stay false; the local port
  must never wire a UI path that flips it to true.
- DO NOT persist the scratchpad, blackboard, artifacts, or tool result
  attributes to disk outside of `data-abc/out/<session>/` and the audit log.
- DO NOT log raw file contents in the audit log (hash + filename + size only;
  see §3).
- DO NOT enable the `send_email` edge function tool
  (`src\lib\freeAgentToolExecutor.ts:522`) until §2 classification has been
  applied to the message body.

---

## 2. Ministry / Sensitive-Context Detection

Triggers on the assembled input bundle (prompt text + extracted file text from
`src\utils\fileTextExtraction.ts:135-144`'s `formatExtractedContent`) before
the bundle is handed to the agent runner.

### Heuristic rule set

Each rule emits a score; total score determines the decision band.

| Rule ID      | Pattern (case-insensitive)                                                                                     | Score |
| ------------ | -------------------------------------------------------------------------------------------------------------- | ----- |
| `gc-domain`  | `\b[\w.+-]+@([\w-]+\.)*(gc\.ca\|canada\.ca\|forces\.gc\.ca\|cra-arc\.gc\.ca\|ssc-spc\.gc\.ca)\b`               | 3     |
| `gc-ministry`| `\b(CRA\|CBSA\|RCMP\|CSIS\|DND\|GAC\|IRCC\|ESDC\|PHAC\|TBS\|PSPC\|Health Canada\|Public Safety)\b`             | 2     |
| `classmark`  | `\b(PROTECTED\s+[ABC]\|CLASSIFIED\|CONFIDENTIAL\|SECRET\|TOP SECRET)\b`                                       | 4     |
| `cabinet`    | `\b(cabinet confidence\|MC\s*\d+\|Memorandum to Cabinet\|TB Submission\|Order in Council)\b`                  | 4     |
| `caveats`    | `\b(NOFORN\|CEO\|CANADIAN EYES ONLY\|FOR OFFICIAL USE ONLY\|FOUO\|ITAR\|CONTROLLED GOODS)\b`                  | 4     |
| `phi`        | `\b(diagnosis\|patient\|medical record\|MRN\b\|health card)\b`                                                | 3     |
| `sin-density`| 2+ matches of the SIN regex (§4) in the same document                                                          | 3     |

### Decision matrix

| Total score | Band     | Action                                                                                                  |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------- |
| 0           | clear    | Proceed. No banner.                                                                                     |
| 1–2         | caution  | Inline warning banner above the prompt textarea, no block.                                              |
| 3–5         | review   | Modal: "This input looks like Protected B material. Continue locally only? Cloud tools will be disabled for this session." User must check `acknowledge` to proceed; audit entry written. |
| 6+ OR any `classmark`/`cabinet`/`caveats` match | block | Hard block at submit; modal explains why. No tool call fires. Audit entry written with the matched rule IDs (NOT the matched text). |

### User-facing warning copy (review band)

> ⚠️ This material looks like Protected B (ministry context detected).
> Continuing keeps everything on this machine — no cloud tools will be called,
> no data will leave `data-abc/out/`. Acknowledge to proceed.

### User-facing warning copy (block band)

> ⛔ Input blocked. The content appears to carry caveats or markings the local
> ABC is not authorized to process (`<rule-id list>`). Remove the marked
> material and resubmit, or escalate through your normal channel.

---

## 3. Audit Logging

### Events that MUST be logged

| Event                      | Trigger site (existing)                                                              | Notes |
| -------------------------- | ------------------------------------------------------------------------------------ | ----- |
| `session.start`            | `handleStart` at `src\components\freeAgent\FreeAgentPanel.tsx:328-340`               | Capture session id, model, file hashes, prompt hash, classifier band (§2). |
| `input.classified`         | New classifier hook (§5)                                                             | Always logged, even on `clear`. |
| `input.blocked`            | New classifier hook (§5)                                                             | Logged with matched rule IDs, never the matched text. |
| `agent.iteration`          | `executeIteration` at `src\hooks\useFreeAgentSession.ts:227-238`                     | Iteration counter, model, tool count. |
| `tool.call`                | `executeFrontendTool` at `src\lib\freeAgentToolExecutor.ts:55-96` and `executeEdgeFunctionTool` at `src\lib\freeAgentToolExecutor.ts:511-576` | Tool name, param keys (NOT values — params may contain secrets via `getSecretOverrides` at `src\hooks\useSecretsManager.ts:219-263`), success/error, duration. |
| `tool.result`              | Same call sites                                                                      | Result size in bytes only. |
| `file.ingested`            | File upload loop at `src\components\freeAgent\FreeAgentPanel.tsx:200-247`            | SHA-256 of bytes + filename + mime + size. |
| `artifact.written`         | `handleArtifactCreated` at `src\hooks\useFreeAgentSession.ts:140-153`; `executeExportWord`/`executeExportPdf` at `src\lib\freeAgentToolExecutor.ts:420-495` | Artifact id, title, mime, size. |
| `file.write` (disk)        | `exportSessionToZip` at `src\utils\sessionExporter.ts:157-258`                       | Output path under `data-abc/out/`, byte count. |
| `secret.read`              | `getSecretValue` / `getSecretOverrides` in `src\hooks\useSecretsManager.ts:103-105,219-263` | Secret key name only, never value. |
| `session.end`              | Completion path at `src\hooks\useFreeAgentSession.ts:955-996`                        | Final status, total iterations, total tool calls. |

The current in-memory `OutputLog` (`src\components\output\OutputLog.tsx:8-95`)
is a UI affordance only — it is React state, lost on reload, and is **not** an
audit log.

### Location

`C:\runcor-lattice\data-abc\out\audit\YYYY-MM-DD.jsonl` (one file per UTC day).

### Format (JSONL)

```
{"ts":"2026-05-25T14:03:11.482Z","event":"tool.call","session":"<uuid>","iter":3,"tool":"web_scrape","param_keys":["url","saveAs"],"ok":true,"ms":842,"result_bytes":18203}
```

Required fields on every line: `ts` (ISO-8601 UTC), `event`, `session`. Extra
fields per event as above. No free-form content; no secret values; file content
appears only as `sha256`.

### Rotation & retention

- One file per UTC day; current day appended in-process with `fs.appendFile`
  (write queue, single writer per session).
- Files older than 90 days → gzip in place; older than 365 days → delete.
- Rotation runs at `session.start` and on a `setInterval` of 1 hour while the
  app is open. No external scheduler.

---

## 4. PII Regex Inventory

All patterns are anchored with `\b` to reduce mid-token false positives. Match
on the assembled input bundle and on outgoing tool call params (after
`resolveReferences` at `src\hooks\useFreeAgentSession.ts:438-470`, before the
tool actually fires).

| Class           | Regex (JS, `i` flag where noted)                                                              | Example matches            | Known false positives |
| --------------- | --------------------------------------------------------------------------------------------- | -------------------------- | --------------------- |
| SIN (CA)        | `\b(?!000)(\d{3})[ -]?(\d{3})[ -]?(\d{3})\b` + Luhn check on the 9 digits                     | `123 456 782` (valid Luhn) | 9-digit order numbers, ISBNs without dashes — Luhn cuts most. |
| Phone (NANP)    | `(?:\+?1[ .-]?)?\(?([2-9]\d{2})\)?[ .-]?([2-9]\d{2})[ .-]?(\d{4})\b`                          | `(613) 555-0142`, `+1-613-555-0142` | Long numeric IDs, version strings like `1.555.0142`. |
| Email           | `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`                                          | `firstname.lastname@gc.ca` | git commit author lines, package author fields. |
| Postal (CA)     | `\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b` (case-insensitive)   | `K1A 0B1`, `M5V3L9`        | Alphanumeric ticket IDs of similar shape. |
| Credit card     | `\b(?:\d[ -]?){13,19}\b` then Luhn check                                                      | `4111 1111 1111 1111`      | Long numeric IDs that happen to pass Luhn (rare but possible). |
| Name-likely     | `\b(Mr|Mrs|Ms|Dr|Hon|Min|Minister|Director|ADM|DM)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b` | `Minister Smith`, `Dr. Tremblay-Côté` (extend `[a-z]` to include `\p{Ll}` for diacritics) | Title-case noun phrases that aren't names (`Director Pattern`, `Minister Of`). Treat as advisory only. |

Pattern usage rules:

- SIN, credit card → Luhn-validate; reject candidates that fail Luhn before
  raising.
- Name-likely is **advisory** (caution band only, never block band) because
  the false-positive surface is too wide for hard enforcement.
- On match in an outgoing tool param, the param value is redacted to
  `<REDACTED:SIN>` / `<REDACTED:EMAIL>` etc. before the tool fires, and the
  redaction is logged as `tool.call.redacted` (event variant of §3's
  `tool.call`).

---

## 5. Enforcement Points in Code

For each control, the file in the upstream ABC where the hook must be wired.
"NEW" means no suitable hook exists today — the smallest new module is named
below.

### A. Block all cloud egress (Protected B storage tier, §1)

- **Replace** `src\integrations\supabase\client.ts:11-17` with a stub that
  throws on `functions.invoke` and `auth` calls.
- **Replace** every `supabase.functions.invoke` call site with a local
  dispatcher:
  - `src\hooks\useFreeAgentSession.ts:332-380` (main iteration)
  - `src\hooks\useFreeAgentSession.ts:1103-1143` (child iteration)
  - `src\lib\freeAgentToolExecutor.ts:564` (`executeEdgeFunctionTool`)
- **NEW** module: `src\integrations\local\runner.ts` — implements the same
  `{ data, error }` shape against the local lattice runtime under
  `C:\runcor-lattice\packages\runtime\`. This is the only systemic fix that
  unblocks every other control.

### B. Input classification (§2)

- **NEW** module: `src\lib\classifier.ts` exporting
  `classifyInput(text: string): { band: 'clear'|'caution'|'review'|'block'; rules: string[] }`.
- **Wire** at `handleStart` in
  `src\components\freeAgent\FreeAgentPanel.tsx:328-340`:
  classify the concatenation of `prompt` + each `pendingFiles[i].content`
  (the `content` field is populated as text/base64 at
  `FreeAgentPanel.tsx:208-226`). Block / modal / proceed per §2 decision
  matrix.
- **Wire** at the child runner too:
  `src\hooks\useFreeAgentSession.ts:1029-1037` builds `child.task` — classify
  it before the first `supabase.functions.invoke` (or local replacement).

### C. Audit logging (§3)

- **NEW** module: `src\lib\audit.ts` exporting
  `audit(event: AuditEvent): void` that queues a JSON line to
  `data-abc/out/audit/<YYYY-MM-DD>.jsonl`. In the browser build this calls a
  thin local IPC; in the Node/Electron host it writes directly with
  `fs.appendFile`.
- **Wire**:
  - `session.start` → `handleStart` at `FreeAgentPanel.tsx:328-340`.
  - `agent.iteration` → top of `executeIteration` at
    `src\hooks\useFreeAgentSession.ts:227-238` (just after
    `iterationRef.current++`).
  - `tool.call` / `tool.result` → entry/exit of
    `executeFrontendTool` (`src\lib\freeAgentToolExecutor.ts:55-96`) and
    `executeEdgeFunctionTool` (`src\lib\freeAgentToolExecutor.ts:511-576`).
  - `file.ingested` → file upload loop at `FreeAgentPanel.tsx:200-247`.
  - `artifact.written` → `handleArtifactCreated` at
    `src\hooks\useFreeAgentSession.ts:140-153`; export paths at
    `src\lib\freeAgentToolExecutor.ts:434-446` (Word) and
    `src\lib\freeAgentToolExecutor.ts:474-486` (PDF).
  - `file.write` → `exportSessionToZip` return path at
    `src\utils\sessionExporter.ts:256-259`.
  - `secret.read` → `getSecretValue` at
    `src\hooks\useSecretsManager.ts:103-105` and
    `getSecretOverrides` at `src\hooks\useSecretsManager.ts:219-263`.
  - `session.end` → completion branch at
    `src\hooks\useFreeAgentSession.ts:955-996`.
- The existing in-memory `OutputLog` (`src\components\output\OutputLog.tsx`)
  stays as a UI mirror; it is not the audit sink.

### D. PII redaction (§4)

- **NEW** module: `src\lib\pii.ts` exporting
  `detect(text: string): Hit[]` and `redact(value: unknown): unknown` (deep
  walk for object params).
- **Wire** the redactor in the param-resolution path at
  `src\hooks\useFreeAgentSession.ts:449-470`. The existing loop already
  calls `resolveReferences(originalParams, resolverContext)` and produces
  `resolvedParams` — insert `redact(resolvedParams)` immediately after, and
  emit a `tool.call.redacted` audit event when any hit fires.
- **Also wire** at the frontend-tool path:
  `src\hooks\useFreeAgentSession.ts:606-607` (`resolveReferences(handler.params, ...)`)
  — same redaction step before `executeFrontendTool` is called.
- **Also wire** at input ingest in §B's `classifier.ts` — name-likely and
  SIN-density rules feed back into the §2 decision band.

### E. Secret storage tier (§1)

- Confirm current behaviour at `src\hooks\useSecretsManager.ts:23,40`
  (`sessionStorage`) is preserved in the local port. Add an
  `onbeforeunload` hook to call `clearAll`
  (`src\hooks\useSecretsManager.ts:362-369`).
- Review `localStorage` writes at
  `src\lib\freeAgentToolExecutor.ts:854-858` (prompt customizations) and
  `src\hooks\useFreeAgentSession.ts:38` (legacy session cleanup) — move
  prompt customizations to SQLite (no content, just structure) or keep in
  `localStorage` only after confirming no Protected B content can land
  there via `write_self` (`src\lib\freeAgentToolExecutor.ts:668-892`).

### F. DO-NOT list enforcement

- `exportConfig` default `includeValues=false` at
  `src\hooks\useSecretsManager.ts:284-297` — add a unit test that fails if
  any UI call passes `true`.
- `send_email` tool at `src\lib\freeAgentToolExecutor.ts:522` — disable in
  the toolsManifest used by the local port until §B classifier has been
  applied to the message body param specifically.
