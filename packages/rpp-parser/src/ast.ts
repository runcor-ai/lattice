// AST node types for R++ v0.5.
// All blocks share { kind, span, name? } and add their own typed body.

import type { Span } from './span.js';

// ── Top-level document ──────────────────────────────────────────────────────

export interface RppDocument {
  blocks: Block[];
  /** Top-level comments not attached to a block. */
  comments: Comment[];
  source: string;
}

export interface Comment {
  kind: 'comment';
  text: string;
  span: Span;
}

// ── Block discriminated union ───────────────────────────────────────────────

export type Block =
  | TargetBlock
  | TokensBlock
  | FormatBlock
  | MapBlock
  | DataBlock
  | InitBlock
  | StructureBlock
  | ComponentBlock
  | BehaviorBlock
  | ChecklistBlock
  | ExtensionBlock;

// ── TARGET ──────────────────────────────────────────────────────────────────

export interface TargetBlock {
  kind: 'target';
  span: Span;
  /** Free-form value of `output: ...` */
  output?: string;
  /** Free-form value of `lang: ...` */
  lang?: string;
  /** Profile names — `profile: ui` or `profile: ui, api` */
  profiles: string[];
  /** Other property assignments not in the standard 3. */
  extraProperties: Record<string, string>;
}

// ── TOKENS ──────────────────────────────────────────────────────────────────

export interface TokensBlock {
  kind: 'tokens';
  span: Span;
  tokens: Map<string, TokenValue>;
}

export interface TokenValue {
  /** Raw text of the value as it appeared in source. */
  raw: string;
  /** Heuristic classification. */
  type: 'color' | 'length' | 'number' | 'string' | 'identifier' | 'unknown';
  span: Span;
}

// ── FORMAT ──────────────────────────────────────────────────────────────────

export interface FormatBlock {
  kind: 'format';
  span: Span;
  functions: FormatFunction[];
}

export interface FormatFunction {
  name: string;
  params: string[];
  /** Raw expression text after `=>`. */
  body: string;
  span: Span;
}

// ── MAP ─────────────────────────────────────────────────────────────────────

export interface MapBlock {
  kind: 'map';
  span: Span;
  /** Named lookup tables: name → entries. */
  maps: Map<string, MapEntries>;
}

export interface MapEntries {
  entries: Map<string, string>;
  span: Span;
}

// ── DATA ────────────────────────────────────────────────────────────────────

export interface DataBlock {
  kind: 'data';
  span: Span;
  /** Optional dataset name (e.g. `ENDPOINTS EXACT:` or `TRANSFORMS:`). */
  name?: string;
  /** True if the EXACT qualifier was present. */
  exact: boolean;
  /** Markdown table parsed into rows. */
  headers: string[];
  rows: string[][];
  /** Free-form description in parens after the name. */
  description?: string;
}

// ── INIT ────────────────────────────────────────────────────────────────────

export interface InitBlock {
  kind: 'init';
  span: Span;
  /** Variable assignments — `name = expression`. */
  assignments: InitAssignment[];
}

export interface InitAssignment {
  name: string;
  /** Raw expression text after `=`. */
  expression: string;
  span: Span;
}

// ── STRUCTURE ───────────────────────────────────────────────────────────────

export interface StructureBlock {
  kind: 'structure';
  span: Span;
  /** Root nodes of the structural tree. */
  roots: StructureNode[];
}

export interface StructureNode {
  /** Component name (e.g. "Header", "KPIRow"). */
  name: string;
  /** Composition pattern — sequence | group N | contains | split | repeat | optional | switch | stack | grid | inline | (none) */
  pattern?: string;
  /** Co-applied properties from the same line (e.g. `bgRaised`, `padding=gapMd`). */
  properties: string[];
  /** Brackets-style children on the next line (`[Foo] [Bar]`). */
  inlineChildren: string[];
  /** Indented children. */
  children: StructureNode[];
  span: Span;
}

// ── COMPONENT ───────────────────────────────────────────────────────────────

export interface ComponentBlock {
  kind: 'component';
  span: Span;
  /** Original keyword used: COMPONENT, SECTION, or VIEW. */
  keyword: 'COMPONENT' | 'SECTION' | 'VIEW';
  /** Component name (required). */
  name: string;
  /** Optional SOURCE= binding. */
  source?: string;
  /** Raw spec lines — body parsing is intentionally lenient per the language ref ("LLM interprets lines in the context of the TARGET"). */
  lines: ComponentLine[];
}

export interface ComponentLine {
  raw: string;
  span: Span;
}

// ── BEHAVIOR ────────────────────────────────────────────────────────────────

export interface BehaviorBlock {
  kind: 'behavior';
  span: Span;
  /** Optional behavior name. */
  name?: string;
  /** Raw rules — body parsing is lenient. */
  rules: BehaviorRule[];
}

export interface BehaviorRule {
  raw: string;
  span: Span;
}

// ── CHECKLIST ───────────────────────────────────────────────────────────────

export interface ChecklistBlock {
  kind: 'checklist';
  span: Span;
  items: ChecklistItem[];
}

export interface ChecklistItem {
  /** Whether the item is checked (`[X]` or `[x]`) or unchecked (`[ ]`). */
  checked: boolean;
  text: string;
  span: Span;
}

// ── Extension (catch-all for unknown blocks like RUNTIME_INPUTS) ────────────

export interface ExtensionBlock {
  kind: 'extension';
  span: Span;
  /** The block keyword that wasn't recognized. */
  keyword: string;
  /** Optional name token. */
  name?: string;
  /** Raw body text. */
  body: string;
}
