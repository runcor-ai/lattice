# agent-builder-console — Features Inventory

Source repository: `C:\agent-builder-console` (read-only). All paths in the tables below are relative to that repo root.

---

## 1. Pages / Routes

Derived from `src/App.tsx` (the only place `<Route>` is declared).

| Route | Component file | Purpose | Notes |
|---|---|---|---|
| `/` | `src/pages/Index.tsx` | Main application shell — holds workflow state (stages, nodes, connections, notes), drives execution against Supabase edge functions, toggles between `workflow` and `freeAgent` app modes. | ~3200-line component; orchestrates Sidebar, WorkflowCanvas/WorkflowCanvasMode/SimpleView, PropertiesPanel, Toolbar, OutputLog, FreeAgentView via `ResponsiveLayout`. |
| `*` (catch-all) | `src/pages/NotFound.tsx` | 404 page; logs the unknown pathname and links back to `/`. | Declared after the `/` route per the in-file comment. |

Top-level providers wrapping the routes (also in `src/App.tsx`): `QueryClientProvider`, `TooltipProvider`, `Toaster` (shadcn) + `Sonner` (sonner), `BrowserRouter`.

---

## 2. Top-level Features

Each row points to the entry component(s) and the supporting files in the same folder. Cross-cutting helpers in `src/lib/`, `src/hooks/`, and `src/utils/` are listed in the dedicated sections below.

| Feature | Entry component(s) | Supporting files | Description |
|---|---|---|---|
| App shell / routing | `src/App.tsx`, `src/main.tsx` | `src/index.css`, `src/App.css`, `src/vite-env.d.ts` | Mounts React root, sets up React Query, tooltip, both toasters, and BrowserRouter. |
| Main workspace page | `src/pages/Index.tsx` | All feature components below | Holds workflow state, runs stages/nodes, streams SSE deltas from edge functions, save/load JSON workflows. |
| Responsive layout & mobile nav | `src/components/layout/ResponsiveLayout.tsx` | `src/components/layout/MobileNav.tsx` | Resizable 3-pane desktop layout (sidebar / canvas / properties) with collapsible side panels; mobile tabbed nav. |
| Toolbar / global actions | `src/components/toolbar/Toolbar.tsx` | `src/components/help/HelpModal.tsx` | Add stage, run, save, load, clear, view-mode toggle, help. |
| Sidebar (library) | `src/components/sidebar/Sidebar.tsx` | `src/components/AgentSelector.tsx`, `src/components/FunctionSelector.tsx`, `src/components/ExcelSelector.tsx` | Workflow-mode left panel: user input box, custom-agent CRUD, model/response/thinking controls, drag-add of agents and functions, Excel input attach. |
| Properties panel | `src/components/properties/PropertiesPanel.tsx` | `src/types/workflow.ts`, `src/lib/functionDefinitions.ts`, `src/lib/functionExecutor.ts` | Edit the currently selected node (agent prompts, model overrides, tool instances, function config, locks, etc.). Calls `get-elevenlabs-voices` edge fn for voice selectors. |
| Output / execution log | `src/components/output/OutputLog.tsx` | — | Time-stamped, color-coded log of info/success/error/running/warning events appended by `addLog` in `Index.tsx`. |
| Workflow canvas — stacked view | `src/components/workflow/WorkflowCanvas.tsx` | `src/components/workflow/Stage.tsx`, `src/components/workflow/AgentNode.tsx`, `src/components/workflow/FunctionNode.tsx` | Default stacked layout where stages render vertically and host their nodes. |
| Workflow canvas — ReactFlow mode | `src/components/workflow/WorkflowCanvasMode.tsx` | `src/components/workflow/WorkflowNodeComponent.tsx`, `src/components/workflow/StageNode.tsx`, `src/components/workflow/NoteNode.tsx`, `src/components/workflow/EdgeStyles.css` | Free-form ReactFlow canvas with custom node types, edge styling, pan/zoom. |
| Workflow canvas — simple list view | `src/components/workflow/SimpleView.tsx` | — | Linear list rendering for quick edits / mobile. |
| Agent template selector | `src/components/AgentSelector.tsx` | (custom agents passed from `Index.tsx`) | Modal dialog with built-in + user-defined agent templates, search, and category badges. |
| Function template selector | `src/components/FunctionSelector.tsx` | `src/lib/functionDefinitions.ts`, `src/types/functions.ts` | Modal dialog for adding a function node (string ops, http, branching, gates, etc.). |
| Excel data selector | `src/components/ExcelSelector.tsx` | `src/utils/parseExcel.ts` | Sheet/row picker that turns uploaded `.xlsx` into chat-friendly formatted text. |
| GitHub integration | `src/components/github/GitHubTreeModal.tsx` | (edge fn `github-fetch`) | Browse a GitHub repo's tree, multi-select files, pull contents back into the workspace. |
| Help modal | `src/components/help/HelpModal.tsx` | — | Static usage guide for the Agent Builder Console. |
| Theming | `src/components/ui/sonner.tsx`, `src/index.css`, `tailwind.config.ts` | `next-themes` (used by `sonner.tsx`) | Class-based dark mode using CSS variables; toaster picks up theme from `next-themes`. |
| Toaster (shadcn) | `src/components/ui/toaster.tsx` | `src/components/ui/toast.tsx`, `src/hooks/use-toast.ts`, `src/components/ui/use-toast.ts` | Radix-based toast stack driven by the `useToast` hook (`@/hooks/use-toast`). |
| Sonner toasts | `src/components/ui/sonner.tsx` | `sonner` package | Themed sonner toaster used in parallel with shadcn toaster (called as `Sonner` in `App.tsx`). |
| Free Agent mode — container | `src/components/freeAgent/FreeAgentView.tsx` | `src/hooks/useFreeAgentSession.ts`, `src/hooks/usePromptCustomization.ts`, `src/hooks/useSecretsManager.ts`, `src/hooks/useToolInstances.ts` | Top-level view for the autonomous "Free Agent" workflow; fetches `/data/toolsManifest.json`, owns canvas + side panels. |
| Free Agent — control panel | `src/components/freeAgent/FreeAgentPanel.tsx` | `src/components/freeAgent/SecretsMiniPanel.tsx` | Start/stop/monitor agent, model selection, file uploads, secrets mini-view. |
| Free Agent — canvas | `src/components/freeAgent/FreeAgentCanvas.tsx` | `src/components/freeAgent/FreeAgentNode.tsx`, `src/components/freeAgent/ToolNode.tsx`, `src/components/freeAgent/PromptNode.tsx`, `src/components/freeAgent/PromptFileNode.tsx`, `src/components/freeAgent/FileNode.tsx`, `src/components/freeAgent/ScratchpadNode.tsx`, `src/components/freeAgent/ArtifactNode.tsx`, `src/components/freeAgent/AttributeNode.tsx`, `src/components/freeAgent/ChildAgentNode.tsx`, `src/components/freeAgent/CategoryLabelNode.tsx` | Clustered ReactFlow tree showing the agent surrounded by tool clusters, scratchpad, artifacts, attributes, prompts, files, and spawned child agents. |
| Free Agent — blackboard / scratchpad viewers | `src/components/freeAgent/BlackboardViewer.tsx`, `src/components/freeAgent/ScratchpadViewerModal.tsx`, `src/components/freeAgent/RawViewer.tsx` | `src/types/freeAgent.ts` | Inspect categorized memory entries, scratchpad text, and raw iteration data. |
| Free Agent — artifacts | `src/components/freeAgent/ArtifactsPanel.tsx`, `src/components/freeAgent/ArtifactViewerModal.tsx`, `src/components/freeAgent/AttributeViewerModal.tsx` | `src/lib/binaryToolUtils.ts` | List, preview, and view text/image/audio artifacts and tool-result attributes. |
| Free Agent — assistance & interjection | `src/components/freeAgent/AssistanceModal.tsx`, `src/components/freeAgent/InterjectModal.tsx` | — | Mid-run user prompts for clarification or extra context. |
| Free Agent — prompt enhancement | `src/components/freeAgent/EnhancePromptModal.tsx`, `src/components/freeAgent/EnhancePromptSettingsModal.tsx` | (edge fn `run-agent` / `run-agent-anthropic` / `run-agent-xai`, plus `/data/toolsManifest.json`) | LLM-driven planner that expands a short user prompt into an actionable agent plan; settings modal edits the planner template. |
| Free Agent — final report & reflection | `src/components/freeAgent/FinalReportModal.tsx`, `src/components/freeAgent/ReflectModal.tsx` | (edge fn for reflection) | Completion summary and post-session analysis. |
| Free Agent — secrets | `src/components/freeAgent/SecretsManagerModal.tsx`, `src/components/freeAgent/SecretsMiniPanel.tsx` | `src/hooks/useSecretsManager.ts`, `src/types/secrets.ts` | Manage API secrets, tool parameter & header mappings (sessionStorage-backed). |
| Free Agent — tool instances | `src/components/freeAgent/ToolInstancesTab.tsx` | `src/hooks/useToolInstances.ts`, `src/types/toolInstance.ts` | Create and label multiple configured instances of a single tool. |
| Free Agent — child agents | `src/components/freeAgent/ChildAgentDetailModal.tsx`, `src/components/freeAgent/ChildAgentNode.tsx` | `src/hooks/useFreeAgentSession.ts` (orchestration state) | Spawn and inspect child Free Agent sessions. |
| Free Agent — system-prompt viewer | `src/components/freeAgent/SystemPromptViewer.tsx` | `src/lib/systemPromptBuilder.ts`, `src/types/systemPrompt.ts`, `public/data/systemPromptTemplate.json`, `public/data/toolsManifest.json` | Inspect / override the assembled system prompt section-by-section. |
| Notes on canvas | `src/components/workflow/NoteNode.tsx` | `src/types/workflow.ts` (`Note`) | Resizable colored sticky notes positioned on the ReactFlow canvas. |
| Workflow save / load | `src/pages/Index.tsx` (`saveWorkflow`, `loadWorkflow`, `repositionStagesVertically`) | — | Serializes workflow + metadata to a downloadable JSON, restores it, migrates legacy port names. |
| shadcn/ui kit | `src/components/ui/*.tsx` (47 primitives) | `tailwind.config.ts`, `components.json` | Local shadcn-style wrappers around Radix primitives plus chart/sidebar/sonner/toast helpers. |

---

## 3. Workflow Node Types

The user-supplied spec mentions `src/components/workflow/nodes/`, but that subfolder does **not** exist in the repo (searched: `Get-ChildItem C:\agent-builder-console\src\components\workflow -Recurse`). Node components live directly under `src/components/workflow/`. Free Agent has its own set of ReactFlow node components under `src/components/freeAgent/` (listed in the second sub-table).

### 3a. `src/components/workflow/`

| Node type | File | Role |
|---|---|---|
| Agent node (stacked view) | `src/components/workflow/AgentNode.tsx` | Renders an agent card inside `Stage.tsx`; icons per agent type, status pill, lock/minimize/run buttons, port click handlers. |
| Function node (stacked view) | `src/components/workflow/FunctionNode.tsx` | Renders a function card with input/output ports for multi-port functions (logic gate, pronghorn, etc.). |
| Stage container (stacked) | `src/components/workflow/Stage.tsx` | Wraps a row of agent/function nodes inside the stacked view; rename, reorder, run-stage UI. |
| Stage container (ReactFlow) | `src/components/workflow/StageNode.tsx` | ReactFlow custom node that acts as the stage frame in canvas mode. |
| Generic workflow node (ReactFlow) | `src/components/workflow/WorkflowNodeComponent.tsx` | Single ReactFlow node that dispatches on `nodeType` (`agent` / `function`) inside `WorkflowCanvasMode`. |
| Sticky note | `src/components/workflow/NoteNode.tsx` | Resizable, colored note placed on the ReactFlow canvas. |
| Stacked canvas | `src/components/workflow/WorkflowCanvas.tsx` | Renders stages and their nodes vertically; the default `viewMode === "stacked"` view. |
| ReactFlow canvas | `src/components/workflow/WorkflowCanvasMode.tsx` | Full free-form canvas, registers `nodeTypes` for the components above. |
| Simple list view | `src/components/workflow/SimpleView.tsx` | Linear list rendering; alternative `viewMode === "simple"`. |
| Edge styling | `src/components/workflow/EdgeStyles.css` | CSS for ReactFlow edges (colors, dashes). |

### 3b. `src/components/freeAgent/` (Free-Agent ReactFlow nodes)

| Node type | File | Role |
|---|---|---|
| Central agent | `src/components/freeAgent/FreeAgentNode.tsx` | The Free Agent itself at canvas center. |
| Tool | `src/components/freeAgent/ToolNode.tsx` | One per available tool, colored by category, supports instances. |
| Category label | `src/components/freeAgent/CategoryLabelNode.tsx` | Group header above each tool cluster. |
| Prompt | `src/components/freeAgent/PromptNode.tsx` | Shows the user's prompt; resizable. |
| Prompt file | `src/components/freeAgent/PromptFileNode.tsx` | User-uploaded file attached to the prompt. |
| Session file | `src/components/freeAgent/FileNode.tsx` | Other session files. |
| Scratchpad | `src/components/freeAgent/ScratchpadNode.tsx` | Live scratchpad area written to by the agent. |
| Artifact | `src/components/freeAgent/ArtifactNode.tsx` | Created artifacts (image/audio/text/file). |
| Attribute | `src/components/freeAgent/AttributeNode.tsx` | Named tool-result attributes. |
| Child agent | `src/components/freeAgent/ChildAgentNode.tsx` | Spawned child Free Agent (round visualization). |

---

## 4. Hooks

From `src/hooks/`.

| Hook | File | Purpose |
|---|---|---|
| `useIsMobile` | `src/hooks/use-mobile.tsx` | Returns boolean for `window.innerWidth < 1024`; listens on a media-query for changes. |
| `useToast`, `toast` | `src/hooks/use-toast.ts` | Reducer-backed shadcn toast manager (`ADD_TOAST` / `UPDATE_TOAST` / `DISMISS_TOAST` / `REMOVE_TOAST`). Re-exported by `src/components/ui/use-toast.ts`. |
| `useFreeAgentSession` | `src/hooks/useFreeAgentSession.ts` | Owns Free Agent session state (blackboard, scratchpad, artifacts, files, iterations, child agents, orchestration); invokes Supabase `free-agent` edge function; integrates reference resolver, loop detector, binary-tool utils, tool fallbacks. |
| `usePromptCustomization` | `src/hooks/usePromptCustomization.ts` | localStorage-backed editor for Free Agent system-prompt sections, including tool overrides and additional custom sections (validates against template v1.1.0 section IDs). |
| `useSecretsManager` | `src/hooks/useSecretsManager.ts` | sessionStorage-backed CRUD for secrets, tool parameter mappings, header mappings; supports import/export. |
| `useToolInstances` | `src/hooks/useToolInstances.ts` | sessionStorage-backed CRUD for tool instances (multiple configured copies of a single base tool). |

---

## 5. Libraries / Utilities

From `src/lib/`.

| Module | File | Purpose |
|---|---|---|
| `cn` | `src/lib/utils.ts` | clsx + tailwind-merge helper for conditional class strings. |
| Binary tool utils | `src/lib/binaryToolUtils.ts` | Detects which tools produce binary output (`image_generation`, `elevenlabs_tts`), detects binary content, sanitizes it before re-feeding into context. |
| Free Agent tool executor | `src/lib/freeAgentToolExecutor.ts` | Front-end-side tool execution layer; dispatches to Supabase edge functions and processes results, including spawn-child requests. |
| Function definitions | `src/lib/functionDefinitions.ts` | Static catalog of all function-node templates (string ops, web, branching, gates, file outputs, etc.) with icons. |
| Function executor | `src/lib/functionExecutor.ts` | Runtime for function nodes (string_contains, string_concat, http, web-scrape, search, send-email, github-fetch, elevenlabs-tts, pronghorn-post, etc.); calls Supabase edge functions. |
| Loop detector | `src/lib/loopDetector.ts` | Detects repetitive agent behavior across blackboard entries and tool calls; emits `warning` / `suggest` / `force_break` levels. |
| Reference resolver | `src/lib/referenceResolver.ts` | Expands `{{scratchpad}}`, `{{blackboard}}`, `{{attribute:name}}`, `{{artifact:name}}`, etc. placeholders inside tool parameters. |
| Safe render | `src/lib/safeRender.ts` | `safeStringify` to avoid the "Objects are not valid as a React child" runtime error. |
| System prompt builder | `src/lib/systemPromptBuilder.ts` | Loads `/data/systemPromptTemplate.json` + `/data/toolsManifest.json` and assembles the prompt payload sent to the edge function, including section overrides. |
| Tool fallbacks | `src/lib/toolFallbacks.ts` | `TOOL_FALLBACKS` map (e.g. `brave_search → google_search`, `read_github_repo → web_scrape`) used when a primary tool fails. |

---

## 6. External Integrations / Endpoints

All HTTP calls leave the browser via either `import.meta.env.VITE_SUPABASE_URL` + `/functions/v1/<name>` or via `supabase.functions.invoke(<name>)`. Two static JSON assets are also fetched from `/data/*` (served from `public/data/`). No other external hosts are reached directly from the front end.

| Integration | File | Surface (URL / SDK / endpoint) | Notes |
|---|---|---|---|
| Supabase client (anon JWT) | `src/integrations/supabase/client.ts` | `createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { storage: localStorage, persistSession: true, autoRefreshToken: true } })` | URL and anon key read from `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. `.env` ships project id `tkppayricdwsogopxxzp` and the anon JWT. |
| Supabase DB types | `src/integrations/supabase/types.ts` | Generated `Database` type (`PostgrestVersion: "13.0.5"`). | Auto-generated typing for the Supabase project. |
| Free Agent edge function | `src/hooks/useFreeAgentSession.ts` (lines 332, 1103) | `supabase.functions.invoke("free-agent", …)` | Main agent loop endpoint. |
| Free Agent tool dispatcher | `src/lib/freeAgentToolExecutor.ts` (line 564) | `supabase.functions.invoke(<functionName>, …)` | Generic dispatch from Free Agent tool calls to a Supabase edge function chosen at runtime. |
| Run agent — Gemini family | `src/pages/Index.tsx` (lines 1373, 2127) | `POST {VITE_SUPABASE_URL}/functions/v1/run-agent` (SSE response) | Default branch when model is not Claude/Grok. |
| Run agent — Anthropic | `src/pages/Index.tsx` (selector line 1367 → fetch 1373) | `POST {VITE_SUPABASE_URL}/functions/v1/run-agent-anthropic` | Selected when `model.startsWith("claude-")`. |
| Run agent — xAI | `src/pages/Index.tsx` (selector line 1367 → fetch 1373) | `POST {VITE_SUPABASE_URL}/functions/v1/run-agent-xai` | Selected when `model.startsWith("grok-")`. |
| Run-agent (auth header) | `src/pages/Index.tsx` (lines 2675–2679) | `POST {VITE_SUPABASE_URL}/functions/v1/run-agent` with `Authorization: Bearer ${VITE_SUPABASE_PUBLISHABLE_KEY}` | One call site explicitly attaches the anon key as a Bearer token. |
| Enhance-prompt (LLM planner) | `src/components/freeAgent/EnhancePromptModal.tsx` (lines 122, 222–224) | `GET /data/toolsManifest.json`; `POST {VITE_SUPABASE_URL}/functions/v1/${edgeFunction}` (one of `run-agent`, `run-agent-anthropic`, `run-agent-xai`) | LLM-assisted prompt expansion. |
| Reflect | `src/components/freeAgent/ReflectModal.tsx` (lines 125–127) | `POST {VITE_SUPABASE_URL}/functions/v1/${edgeFunction}` (run-agent variant) | Post-session reflection. |
| GitHub fetch | `src/components/github/GitHubTreeModal.tsx` (lines 67, 253); `src/lib/functionExecutor.ts` (line 1061) | `POST {VITE_SUPABASE_URL}/functions/v1/github-fetch` | Repo tree browse + file fetch (function node also reuses it). |
| Run-nano | `src/lib/functionExecutor.ts` (line 581) | `POST {VITE_SUPABASE_URL}/functions/v1/run-nano` | Lightweight LLM call from a function node. |
| ElevenLabs TTS | `src/lib/functionExecutor.ts` (line 633) | `POST {VITE_SUPABASE_URL}/functions/v1/elevenlabs-tts` | Text-to-speech function node. |
| ElevenLabs voice list | `src/components/properties/PropertiesPanel.tsx` (line 130) | `POST {VITE_SUPABASE_URL}/functions/v1/get-elevenlabs-voices` | Populates voice dropdowns in the properties panel. |
| Google Search | `src/lib/functionExecutor.ts` (line 685) | `POST {VITE_SUPABASE_URL}/functions/v1/google-search` | Search function node. |
| Brave Search | `src/lib/functionExecutor.ts` (line 732) | `POST {VITE_SUPABASE_URL}/functions/v1/brave-search` | Search function node. |
| Web scrape | `src/lib/functionExecutor.ts` (line 799) | `POST {VITE_SUPABASE_URL}/functions/v1/web-scrape` | Scrape function node + fallback for GitHub tools. |
| Generic API call | `src/lib/functionExecutor.ts` (line 936) | `POST {VITE_SUPABASE_URL}/functions/v1/api-call` | Configurable HTTP request from a function node. |
| Send email | `src/lib/functionExecutor.ts` (line 1010) | `POST {VITE_SUPABASE_URL}/functions/v1/send-email` | Email function node. |
| Pronghorn post | `src/lib/functionExecutor.ts` (line 1330) | `POST {VITE_SUPABASE_URL}/functions/v1/pronghorn-post` | Pronghorn-specific outbound call. |
| System-prompt template (static) | `src/lib/systemPromptBuilder.ts` (line 79); `src/components/freeAgent/SystemPromptViewer.tsx` (line 831) | `GET /data/systemPromptTemplate.json` | Static JSON served from `public/data/`. |
| Tools manifest (static) | `src/lib/systemPromptBuilder.ts` (line 96); `src/components/freeAgent/SystemPromptViewer.tsx` (line 832); `src/components/freeAgent/FreeAgentView.tsx` (line 67); `src/components/freeAgent/EnhancePromptModal.tsx` (line 122) | `GET /data/toolsManifest.json` | Static JSON served from `public/data/`. |

Search recap (used to populate this section): `Grep "fetch\(|supabase\.|VITE_"` across `src/`.

Supabase URL/key origin: `.env` at the repo root contains

```
VITE_SUPABASE_PROJECT_ID="tkppayricdwsogopxxzp"
VITE_SUPABASE_URL="https://tkppayricdwsogopxxzp.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon JWT>"
```

These are read via `import.meta.env.*` (Vite). The anon JWT is exposed to the browser by design (it is the `anon` role); access is gated by Supabase RLS / edge-function logic on the server side. `src/integrations/supabase/client.ts` reads URL + publishable key; other call sites embed the URL directly via `import.meta.env.VITE_SUPABASE_URL`.

---

## 7. Runtime Dependencies

From `package.json` → `dependencies`. "Used for" inferred from imports.

| Package | Version | Used for |
|---|---|---|
| `@hookform/resolvers` | `^3.10.0` | Bridges `react-hook-form` with Zod schemas (`src/components/ui/form.tsx`). |
| `@radix-ui/react-accordion` | `^1.2.11` | Headless accordion primitive (`src/components/ui/accordion.tsx`). |
| `@radix-ui/react-alert-dialog` | `^1.1.14` | Confirm/alert dialogs (`src/components/ui/alert-dialog.tsx`, used in Toolbar/MobileNav). |
| `@radix-ui/react-aspect-ratio` | `^1.1.7` | Aspect-ratio container (`src/components/ui/aspect-ratio.tsx`). |
| `@radix-ui/react-avatar` | `^1.1.10` | Avatar primitive (`src/components/ui/avatar.tsx`). |
| `@radix-ui/react-checkbox` | `^1.3.2` | Checkbox (`src/components/ui/checkbox.tsx`). |
| `@radix-ui/react-collapsible` | `^1.1.11` | Collapsible (`src/components/ui/collapsible.tsx`). |
| `@radix-ui/react-context-menu` | `^2.2.15` | Context menu (`src/components/ui/context-menu.tsx`). |
| `@radix-ui/react-dialog` | `^1.1.14` | Modal dialogs used throughout (selectors, modals, sheets). |
| `@radix-ui/react-dropdown-menu` | `^2.1.15` | Dropdown menus in Toolbar, MobileNav, properties. |
| `@radix-ui/react-hover-card` | `^1.1.14` | Hover card (`src/components/ui/hover-card.tsx`). |
| `@radix-ui/react-label` | `^2.1.7` | Form labels (`src/components/ui/label.tsx`). |
| `@radix-ui/react-menubar` | `^1.1.15` | Menubar (`src/components/ui/menubar.tsx`). |
| `@radix-ui/react-navigation-menu` | `^1.2.13` | Navigation menu (`src/components/ui/navigation-menu.tsx`). |
| `@radix-ui/react-popover` | `^1.1.14` | Popovers (`src/components/ui/popover.tsx`). |
| `@radix-ui/react-progress` | `^1.1.7` | Progress bar (`src/components/ui/progress.tsx`). |
| `@radix-ui/react-radio-group` | `^1.3.7` | Radio group (`src/components/ui/radio-group.tsx`). |
| `@radix-ui/react-scroll-area` | `^1.2.9` | Scroll area used in Sidebar, panels, OutputLog. |
| `@radix-ui/react-select` | `^2.2.5` | Selects used in PropertiesPanel and Sidebar. |
| `@radix-ui/react-separator` | `^1.1.7` | Separator (`src/components/ui/separator.tsx`). |
| `@radix-ui/react-slider` | `^1.3.5` | Slider (`src/components/ui/slider.tsx`). |
| `@radix-ui/react-slot` | `^1.2.3` | Slot polymorphism used by shadcn `Button` and friends. |
| `@radix-ui/react-switch` | `^1.2.5` | Switch (`src/components/ui/switch.tsx`, used in PropertiesPanel/Sidebar). |
| `@radix-ui/react-tabs` | `^1.1.12` | Tabs (`src/components/ui/tabs.tsx`, used in Sidebar/PropertiesPanel/FreeAgent panels). |
| `@radix-ui/react-toast` | `^1.2.14` | shadcn toast primitive (`src/components/ui/toast.tsx`). |
| `@radix-ui/react-toggle` | `^1.1.9` | Toggle (`src/components/ui/toggle.tsx`). |
| `@radix-ui/react-toggle-group` | `^1.1.10` | Toggle group (`src/components/ui/toggle-group.tsx`). |
| `@radix-ui/react-tooltip` | `^1.2.7` | Tooltip provider (`src/App.tsx`, `src/components/ui/tooltip.tsx`). |
| `@supabase/supabase-js` | `^2.58.0` | Supabase client + edge function invoker (`src/integrations/supabase/client.ts`). |
| `@tanstack/react-query` | `^5.83.0` | `QueryClient` set up in `src/App.tsx`. |
| `class-variance-authority` | `^0.7.1` | Variant-based class utilities for shadcn primitives (e.g. `src/components/ui/button.tsx`). |
| `clsx` | `^2.1.1` | Class string composition inside `src/lib/utils.ts`. |
| `cmdk` | `^1.1.1` | Command palette / combobox (`src/components/ui/command.tsx`). |
| `date-fns` | `^3.6.0` | Date formatting (`src/components/ui/calendar.tsx`, etc.). |
| `docx` | `^9.5.1` | DOCX export support in `src/utils/sessionExporter.ts`. |
| `embla-carousel-react` | `^8.6.0` | Carousel primitive (`src/components/ui/carousel.tsx`). |
| `exceljs` | `^4.4.0` | Excel parsing for `src/utils/parseExcel.ts` (used by `ExcelSelector`). |
| `input-otp` | `^1.4.2` | OTP input primitive (`src/components/ui/input-otp.tsx`). |
| `jspdf` | `^3.0.3` | PDF generation in `src/utils/sessionExporter.ts`. |
| `jszip` | `^3.10.1` | ZIP packaging in `src/utils/sessionExporter.ts`. |
| `lucide-react` | `^0.462.0` | Icons used across every component (Toolbar, Sidebar, nodes, modals, etc.). |
| `mammoth` | `^1.11.0` | DOCX → text extraction in `src/utils/fileTextExtraction.ts`. |
| `next-themes` | `^0.3.0` | Theme awareness for the sonner toaster (`src/components/ui/sonner.tsx`). |
| `pdfjs-dist` | `^5.4.296` | PDF text extraction in `src/utils/fileTextExtraction.ts`. |
| `react` | `^18.3.1` | UI framework. |
| `react-day-picker` | `^8.10.1` | Calendar (`src/components/ui/calendar.tsx`). |
| `react-dom` | `^18.3.1` | React DOM renderer (`src/main.tsx`). |
| `react-hook-form` | `^7.61.1` | Forms (`src/components/ui/form.tsx`). |
| `react-markdown` | `^10.1.0` | Renders markdown in Sidebar previews and FreeAgent modals. |
| `react-resizable-panels` | `^2.1.9` | Resizable panes in `src/components/layout/ResponsiveLayout.tsx` and `src/components/ui/resizable.tsx`. |
| `react-router-dom` | `^6.30.1` | `BrowserRouter`/`Routes` in `src/App.tsx`; `useLocation` in `src/pages/NotFound.tsx`. |
| `reactflow` | `^11.11.4` | Canvas for both workflow and Free Agent modes (`WorkflowCanvasMode.tsx`, `FreeAgentCanvas.tsx`, and all node components). |
| `recharts` | `^2.15.4` | Chart helpers in `src/components/ui/chart.tsx`. |
| `remark-gfm` | `^4.0.1` | GitHub-flavored markdown plugin used alongside `react-markdown`. |
| `sonner` | `^1.7.4` | Sonner toaster (`src/components/ui/sonner.tsx`, used in `App.tsx` and `useFreeAgentSession.ts`). |
| `tailwind-merge` | `^2.6.0` | De-duplicates Tailwind classes inside `cn` helper (`src/lib/utils.ts`). |
| `tailwindcss-animate` | `^1.0.7` | Tailwind animations plugin (`tailwind.config.ts`). |
| `vaul` | `^0.9.9` | Drawer primitive (`src/components/ui/drawer.tsx`). |
| `zod` | `^3.25.76` | Schema validation paired with `react-hook-form`/`@hookform/resolvers`. |

---

## 8. Dev Dependencies

From `package.json` → `devDependencies`.

| Package | Version | Used for |
|---|---|---|
| `@eslint/js` | `^9.32.0` | ESLint flat-config base rules (`eslint.config.js`). |
| `@tailwindcss/typography` | `^0.5.16` | Typography plugin (installed but not registered in `tailwind.config.ts`'s `plugins` array). |
| `@types/node` | `^22.16.5` | Node typings for `vite.config.ts` (`path`, `__dirname`). |
| `@types/react` | `^18.3.23` | React typings. |
| `@types/react-dom` | `^18.3.7` | React DOM typings. |
| `@vitejs/plugin-react-swc` | `^3.11.0` | Vite plugin used in `vite.config.ts` (SWC-based React fast refresh). |
| `autoprefixer` | `^10.4.21` | PostCSS plugin (`postcss.config.js`). |
| `eslint` | `^9.32.0` | Linter runner (`npm run lint`). |
| `eslint-plugin-react-hooks` | `^5.2.0` | React hooks rules in `eslint.config.js`. |
| `eslint-plugin-react-refresh` | `^0.4.20` | React Refresh hygiene rule (`eslint.config.js`). |
| `globals` | `^15.15.0` | Browser globals set for ESLint (`eslint.config.js`). |
| `lovable-tagger` | `^1.1.10` | Vite plugin enabled in `development` mode in `vite.config.ts` — annotates components for the Lovable editor. |
| `postcss` | `^8.5.6` | PostCSS runner (`postcss.config.js`). |
| `tailwindcss` | `^3.4.17` | Tailwind compiler (`tailwind.config.ts`, `postcss.config.js`, `src/index.css`). |
| `typescript` | `^5.8.3` | TypeScript compiler. |
| `typescript-eslint` | `^8.38.0` | TS-aware ESLint config (`eslint.config.js`). |
| `vite` | `^5.4.19` | Dev server and bundler (`npm run dev` / `build`). |

---

## 9. Build / Tooling

| File | Controls |
|---|---|
| `vite.config.ts` | Vite dev server (host `::`, port `8080`); registers `@vitejs/plugin-react-swc`; adds `lovable-tagger` only in development; declares the `@ → ./src` path alias. |
| `tailwind.config.ts` | Tailwind config: `darkMode: ["class"]`; `content` globs cover `./pages`, `./components`, `./app`, `./src`; container preset; HSL CSS-variable-based color palette (border, input, ring, background, foreground, primary, secondary, destructive, muted, accent, popover, card, sidebar.*, success, warning); border-radius tokens; accordion keyframes/animations; plugin `tailwindcss-animate`. |
| `tsconfig.json` | Root TS project that references `tsconfig.app.json` and `tsconfig.node.json`; sets `baseUrl: "."`, `paths: { "@/*": ["./src/*"] }`, and relaxed flags (`noImplicitAny: false`, `strictNullChecks: false`, `allowJs: true`, `skipLibCheck: true`). |
| `tsconfig.app.json` | App-side compile: `target: ES2020`, `lib: [ES2020, DOM, DOM.Iterable]`, bundler module resolution, `jsx: "react-jsx"`, `noEmit: true`, includes `src`; relaxed lint flags. |
| `tsconfig.node.json` | Compile settings for `vite.config.ts` only: `target: ES2022`, `lib: [ES2023]`, `strict: true`. |
| `eslint.config.js` | ESLint flat config: extends `js.configs.recommended` + `typescript-eslint.configs.recommended`; ignores `dist`; enables `react-hooks` + `react-refresh` plugins; turns `@typescript-eslint/no-unused-vars` off; warns on `react-refresh/only-export-components`. |
| `postcss.config.js` | PostCSS plugins: `tailwindcss` and `autoprefixer`. |
| `components.json` | shadcn/ui config: `style: "default"`, `rsc: false`, `tsx: true`; Tailwind config + CSS path; `baseColor: "slate"`, CSS variables enabled; aliases: `components → @/components`, `utils → @/lib/utils`, `ui → @/components/ui`, `lib → @/lib`, `hooks → @/hooks`. |
