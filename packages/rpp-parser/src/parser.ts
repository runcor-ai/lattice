// Recursive-descent parser for R++ v0.5.
// Constitution Principle IV: never throws on syntax errors; emits Diagnostic[] and recovers.

import type {
  Block,
  ComponentBlock,
  ComponentLine,
  BehaviorBlock,
  BehaviorRule,
  ChecklistBlock,
  ChecklistItem,
  Comment,
  DataBlock,
  ExtensionBlock,
  FormatBlock,
  FormatFunction,
  InitBlock,
  InitAssignment,
  MapBlock,
  MapEntries,
  RppDocument,
  StructureBlock,
  StructureNode,
  TargetBlock,
  TokenValue,
  TokensBlock,
} from './ast.js';
import type { Diagnostic, DiagnosticCode, Severity } from './diagnostic.js';
import { diagnostic } from './diagnostic.js';
import { lex, type Token, type TokenKind } from './lexer.js';
import type { Span } from './span.js';
import { joinSpans, makeSpan } from './span.js';

const KNOWN_BLOCK_KEYWORDS = new Set([
  'TARGET',
  'TOKENS',
  'FORMAT',
  'MAP',
  'DATA',
  'INIT',
  'STRUCTURE',
  'COMPONENT',
  'SECTION', // alias for COMPONENT
  'VIEW',    // alias for COMPONENT
  'BEHAVIOR',
  'CHECKLIST',
]);

export interface ParseResult {
  ast: RppDocument;
  diagnostics: Diagnostic[];
}

export function parse(source: string): ParseResult {
  const lexResult = lex(source);
  const parser = new Parser(lexResult.tokens, source, [...lexResult.diagnostics]);
  const ast = parser.parseDocument();
  return { ast, diagnostics: parser.diagnostics };
}

class Parser {
  diagnostics: Diagnostic[];
  private tokens: Token[];
  private idx = 0;
  private source: string;

  constructor(tokens: Token[], source: string, initialDiagnostics: Diagnostic[]) {
    this.tokens = tokens;
    this.source = source;
    this.diagnostics = initialDiagnostics;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private peek(offset = 0): Token {
    return this.tokens[this.idx + offset] ?? this.eofToken();
  }

  private eofToken(): Token {
    return this.tokens[this.tokens.length - 1] ?? {
      kind: 'eof', text: '', value: '',
      span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } },
    };
  }

  private current(): Token {
    return this.peek(0);
  }

  private advance(): Token {
    const tok = this.tokens[this.idx] ?? this.eofToken();
    if (this.idx < this.tokens.length) this.idx++;
    return tok;
  }

  private match(kind: TokenKind, text?: string): boolean {
    const t = this.current();
    if (t.kind !== kind) return false;
    if (text !== undefined && t.text !== text) return false;
    return true;
  }

  private consume(kind: TokenKind, text?: string): Token | null {
    if (this.match(kind, text)) return this.advance();
    return null;
  }

  private skipNewlinesAndComments(): void {
    while (this.match('newline') || this.match('comment')) {
      this.advance();
    }
  }

  private addDiagnostic(severity: Severity, code: DiagnosticCode, message: string, span: Span, data?: Record<string, unknown>): void {
    this.diagnostics.push(diagnostic(severity, code, message, span, data));
  }

  /** Skip tokens until we hit a likely block boundary (top-level keyword or EOF). Used for error recovery. */
  private recoverToNextBlock(): void {
    while (this.current().kind !== 'eof') {
      if (this.match('identifier') && KNOWN_BLOCK_KEYWORDS.has(this.current().text.toUpperCase())) {
        return;
      }
      // Heuristic: also recover at top-level identifier-followed-by-lbrace
      if (this.match('identifier') && this.peek(1).kind === 'lbrace' && this.peek(0).span.start.column === 1) {
        return;
      }
      this.advance();
    }
  }

  // ── Top-level document ──────────────────────────────────────────────────

  parseDocument(): RppDocument {
    const blocks: Block[] = [];
    const comments: Comment[] = [];

    this.skipNewlinesAndComments();

    while (this.current().kind !== 'eof') {
      // Drift comments at the top level — collect into doc.comments
      if (this.match('comment')) {
        const t = this.advance();
        comments.push({ kind: 'comment', text: t.value, span: t.span });
        this.skipNewlinesAndComments();
        continue;
      }

      const block = this.parseBlock();
      if (block) blocks.push(block);
      this.skipNewlinesAndComments();
    }

    return { blocks, comments, source: this.source };
  }

  // ── Block dispatch ──────────────────────────────────────────────────────

  private parseBlock(): Block | null {
    if (!this.match('identifier')) {
      const t = this.advance();
      this.addDiagnostic('error', 'expected-block-keyword', `Expected block keyword, got ${describeToken(t)}`, t.span);
      this.recoverToNextBlock();
      return null;
    }

    const keywordToken = this.current();
    const keyword = keywordToken.text.toUpperCase();

    // Read optional name
    let nameToken: Token | undefined;
    let nextIdx = this.idx + 1;
    if ((this.tokens[nextIdx]?.kind === 'identifier') && (this.tokens[nextIdx + 1]?.kind === 'lbrace' || this.tokens[nextIdx + 1]?.kind === 'identifier')) {
      // KEYWORD Name { ... }  OR KEYWORD Name SOURCE=foo { ... }
      nameToken = this.tokens[nextIdx];
    }

    // For DATA, the syntax is `DATA EXACT:` or `LABEL:` (markdown table follows) — handled separately
    if (keyword === 'DATA') {
      return this.parseData(keywordToken);
    }
    if (keyword !== 'DATA' && this.tokens[nextIdx]?.kind === 'identifier' && this.tokens[nextIdx + 1]?.kind === 'colon') {
      // e.g. `LABEL EXACT:` — free-floating data block
      return this.parseData(keywordToken);
    }

    // Special: COMPONENT, SECTION, VIEW require a name
    if (keyword === 'COMPONENT' || keyword === 'SECTION' || keyword === 'VIEW') {
      return this.parseComponent(keywordToken, keyword as 'COMPONENT' | 'SECTION' | 'VIEW');
    }

    // Other blocks: optional name + body
    this.advance(); // consume keyword
    if (nameToken && this.match('identifier')) {
      this.advance(); // consume name
    }

    const lbrace = this.consume('lbrace');
    if (!lbrace) {
      this.addDiagnostic('error', 'unclosed-block', `Expected '{' after ${keyword}`, this.current().span);
      this.recoverToNextBlock();
      return null;
    }

    switch (keyword) {
      case 'TARGET':    return this.parseTarget(keywordToken, lbrace);
      case 'TOKENS':    return this.parseTokens(keywordToken, lbrace);
      case 'FORMAT':    return this.parseFormat(keywordToken, lbrace);
      case 'MAP':       return this.parseMap(keywordToken, lbrace);
      case 'INIT':      return this.parseInit(keywordToken, lbrace);
      case 'STRUCTURE': return this.parseStructure(keywordToken, lbrace);
      case 'BEHAVIOR':  return this.parseBehavior(keywordToken, lbrace, nameToken?.value);
      case 'CHECKLIST': return this.parseChecklist(keywordToken, lbrace);
      default: {
        // Extension block — known shape (KEYWORD {...}) but unknown keyword
        const block = this.parseExtension(keywordToken, lbrace, nameToken?.value);
        this.addDiagnostic(
          'extension',
          'unknown-block-accepted-as-extension',
          `Unknown block keyword "${keyword}" — accepted as extension. Add to language reference if intentional.`,
          keywordToken.span,
          { keyword },
        );
        return block;
      }
    }
  }

  // ── Body collectors ─────────────────────────────────────────────────────

  /** Read tokens until matching `}`, tracking brace depth. Returns the rbrace token. */
  private collectBlockBody(): { rawText: string; rbrace: Token | null; lines: { raw: string; span: Span }[] } {
    let depth = 1;
    const lines: { raw: string; span: Span }[] = [];
    let lineTokens: Token[] = [];
    const lineStart = (): Span | null => lineTokens[0]?.span ?? null;

    const emitLine = (): void => {
      if (lineTokens.length === 0) return;
      const start = lineTokens[0]!.span;
      const end = lineTokens[lineTokens.length - 1]!.span;
      const raw = this.source.slice(start.start.offset, end.end.offset).trim();
      if (raw.length > 0) lines.push({ raw, span: joinSpans(start, end) });
      lineTokens = [];
    };

    let lastTok: Token | null = null;
    while (depth > 0 && this.current().kind !== 'eof') {
      const t = this.current();
      if (t.kind === 'lbrace') depth++;
      if (t.kind === 'rbrace') {
        depth--;
        if (depth === 0) {
          emitLine();
          const rbrace = this.advance();
          const startOffset = lastTok?.span.end.offset ?? 0;
          const rawText = this.source.slice(startOffset, rbrace.span.start.offset);
          return { rawText, rbrace, lines };
        }
      }
      if (t.kind === 'newline') {
        emitLine();
      } else if (t.kind !== 'comment') {
        lineTokens.push(t);
      }
      lastTok = t;
      this.advance();
    }
    // Unclosed
    emitLine();
    const startSpan = lineStart() ?? this.current().span;
    this.addDiagnostic('error', 'unclosed-block', `Block missing closing '}'`, startSpan);
    return { rawText: '', rbrace: null, lines };
  }

  // ── TARGET ───────────────────────────────────────────────────────────────

  private parseTarget(keywordToken: Token, lbrace: Token): TargetBlock {
    const block: TargetBlock = {
      kind: 'target',
      span: makeSpan(keywordToken.span.start, lbrace.span.end),
      profiles: [],
      extraProperties: {},
    };
    const body = this.collectBlockBody();
    if (body.rbrace) block.span = makeSpan(keywordToken.span.start, body.rbrace.span.end);

    for (const line of body.lines) {
      // Lines look like: name: value  or  name: value | value
      const colonIdx = line.raw.indexOf(':');
      if (colonIdx === -1) continue;
      const name = line.raw.slice(0, colonIdx).trim();
      const value = line.raw.slice(colonIdx + 1).trim();
      if (name === 'output') block.output = unquote(value);
      else if (name === 'lang') block.lang = unquote(value);
      else if (name === 'profile') {
        block.profiles = value.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        block.extraProperties[name] = value;
      }
    }
    return block;
  }

  // ── TOKENS ───────────────────────────────────────────────────────────────

  private parseTokens(keywordToken: Token, lbrace: Token): TokensBlock {
    const tokens = new Map<string, TokenValue>();
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    for (const line of body.lines) {
      // name:value | name:value | name:value
      const parts = splitOnPipe(line.raw);
      for (const part of parts) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) {
          if (part.trim().length > 0) {
            this.addDiagnostic('error', 'invalid-token-syntax', `Token must use 'name:value' syntax: "${part}"`, line.span);
          }
          continue;
        }
        const name = part.slice(0, colonIdx).trim();
        const raw = part.slice(colonIdx + 1).trim();
        if (!name) continue;
        if (tokens.has(name)) {
          this.addDiagnostic('warning', 'duplicate-token-name', `Duplicate TOKENS name "${name}"`, line.span);
        }
        tokens.set(name, { raw: unquote(raw), type: classifyValue(raw), span: line.span });
      }
    }

    return { kind: 'tokens', span, tokens };
  }

  // ── FORMAT ───────────────────────────────────────────────────────────────

  private parseFormat(keywordToken: Token, lbrace: Token): FormatBlock {
    const fns: FormatFunction[] = [];
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    // FORMAT is documented as `name(args) => expression` per v0.5 reference,
    // but real-world specs (runcor-data, runcor-substrate, runcor-integration)
    // use FORMAT as an OUTPUT template block with JSON-like content. Be lenient:
    // only emit an error when the line clearly INTENDS a function definition but
    // is malformed; otherwise silently capture lines as opaque body text.
    for (const line of body.lines) {
      const arrowIdx = line.raw.indexOf('=>');
      if (arrowIdx === -1) {
        // Not a function definition — capture as raw line for downstream tools.
        // (Heuristic: real-world FORMAT-as-template content goes here.)
        fns.push({ name: '', params: [], body: line.raw, span: line.span });
        continue;
      }
      const left = line.raw.slice(0, arrowIdx).trim();
      const body_ = line.raw.slice(arrowIdx + 2).trim();
      const lparen = left.indexOf('(');
      const rparen = left.lastIndexOf(')');
      if (lparen === -1 || rparen === -1 || rparen < lparen) {
        this.addDiagnostic('warning', 'invalid-format-syntax', `Format function name should include parens: "${line.raw}"`, line.span);
        fns.push({ name: left, params: [], body: body_, span: line.span });
        continue;
      }
      const name = left.slice(0, lparen).trim();
      const params = left.slice(lparen + 1, rparen).split(',').map(s => s.trim()).filter(Boolean);
      fns.push({ name, params, body: body_, span: line.span });
    }
    return { kind: 'format', span, functions: fns };
  }

  // ── MAP ──────────────────────────────────────────────────────────────────

  private parseMap(keywordToken: Token, lbrace: Token): MapBlock {
    const maps = new Map<string, MapEntries>();
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    // MAP body is: NAME { entries }  NAME { entries } ...
    // We re-tokenize lines because of nested braces.
    // Simpler approach: scan body raw text for nested NAME { ... } pairs.
    const text = this.source.slice(lbrace.span.end.offset, body.rbrace?.span.start.offset ?? this.source.length);
    const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]!;
      const entriesText = m[2]!;
      const entries = new Map<string, string>();
      for (const part of splitOnPipe(entriesText)) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const k = part.slice(0, colonIdx).trim();
        const v = part.slice(colonIdx + 1).trim();
        if (!k) continue;
        entries.set(k, unquote(v));
      }
      maps.set(name, { entries, span });
    }
    if (maps.size === 0 && text.trim().length > 0 && body.lines.length > 0) {
      this.addDiagnostic('error', 'invalid-map-syntax', `MAP body must contain named lookup tables: NAME { key:value | ... }`, span);
    }
    return { kind: 'map', span, maps };
  }

  // ── DATA ─────────────────────────────────────────────────────────────────

  private parseData(keywordToken: Token): DataBlock {
    // The form is: KEYWORD [LABEL] [EXACT] [(description)]: \n markdown table
    // OR: LABEL [EXACT]: \n markdown table (where keyword IS the label)
    const startOffset = keywordToken.span.start.offset;
    let end: Span = keywordToken.span;
    let exact = false;
    let label: string | undefined;
    let description: string | undefined;

    // If this was DATA, advance past it. If it was LABEL, we'll keep LABEL as the name.
    const isDataKeyword = keywordToken.text.toUpperCase() === 'DATA';
    if (isDataKeyword) {
      this.advance(); // consume DATA
    } else {
      label = keywordToken.text;
      this.advance(); // consume label
    }

    // Optional EXACT
    if (this.match('identifier', 'EXACT')) {
      exact = true;
      end = this.current().span;
      this.advance();
    }
    // Optional LABEL after DATA
    if (isDataKeyword && this.match('identifier')) {
      label = this.current().text;
      end = this.current().span;
      this.advance();
      if (this.match('identifier', 'EXACT')) {
        exact = true;
        end = this.current().span;
        this.advance();
      }
    }
    // Optional (description)
    if (this.match('lparen')) {
      this.advance();
      let depth = 1;
      let descBuf = '';
      while (depth > 0 && this.current().kind !== 'eof') {
        const t = this.advance();
        if (t.kind === 'lparen') depth++;
        else if (t.kind === 'rparen') {
          depth--;
          if (depth === 0) { end = t.span; break; }
        }
        if (depth > 0) descBuf += t.text + ' ';
      }
      description = descBuf.trim();
    }
    // Expect colon
    const colon = this.consume('colon');
    if (!colon) {
      this.addDiagnostic('error', 'invalid-data-table', `Expected ':' after DATA header`, this.current().span);
    } else {
      end = colon.span;
    }

    // Read markdown table rows from source until next blank line or block boundary
    // Find the source slice from after colon to next double-newline or end
    const tableStart = end.end.offset;
    let tableEnd = tableStart;
    while (tableEnd < this.source.length) {
      const ch = this.source[tableEnd];
      if (ch === '\n' && this.source[tableEnd + 1] === '\n') break;
      tableEnd++;
    }
    const tableText = this.source.slice(tableStart, tableEnd).trim();

    // Skip ahead: re-sync the parser past the table text.
    // Use <= because the last token on the final row has end.offset == tableEnd
    // (tableEnd points at the trailing '\n').
    while (this.current().kind !== 'eof' && this.current().span.end.offset <= tableEnd) {
      this.advance();
    }
    // Also skip any trailing newlines that the table ended on.
    while (this.match('newline')) this.advance();

    const { headers, rows } = parseMarkdownTable(tableText);

    const block: DataBlock = {
      kind: 'data',
      span: { start: keywordToken.span.start, end: { offset: tableEnd, line: end.end.line, column: end.end.column } },
      exact,
      headers,
      rows,
    };
    void startOffset;
    if (label !== undefined) block.name = label;
    if (description !== undefined) block.description = description;
    void startOffset; // silence unused
    return block;
  }

  // ── INIT ─────────────────────────────────────────────────────────────────

  private parseInit(keywordToken: Token, lbrace: Token): InitBlock {
    const assignments: InitAssignment[] = [];
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    for (const line of body.lines) {
      // name = expression  (possibly with trailing // comment, already stripped by lexer)
      const eqIdx = line.raw.indexOf('=');
      if (eqIdx === -1) continue;
      const name = line.raw.slice(0, eqIdx).trim();
      const expression = line.raw.slice(eqIdx + 1).trim();
      if (name) assignments.push({ name, expression, span: line.span });
    }
    return { kind: 'init', span, assignments };
  }

  // ── STRUCTURE ────────────────────────────────────────────────────────────

  private parseStructure(keywordToken: Token, lbrace: Token): StructureBlock {
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    // Re-extract lines with their original indentation from source
    const innerStart = lbrace.span.end.offset;
    const innerEnd = body.rbrace?.span.start.offset ?? this.source.length;
    const innerText = this.source.slice(innerStart, innerEnd);
    const indented = parseIndentedLines(innerText, lbrace.span.end.line + 1);

    const roots: StructureNode[] = [];
    buildStructureTree(indented, 0, roots);

    return { kind: 'structure', span, roots };
  }

  // ── COMPONENT (and SECTION/VIEW) ────────────────────────────────────────

  private parseComponent(keywordToken: Token, keyword: 'COMPONENT' | 'SECTION' | 'VIEW'): ComponentBlock {
    this.advance(); // consume keyword
    const nameTok = this.consume('identifier');
    if (!nameTok) {
      this.addDiagnostic('error', 'expected-identifier', `Expected component name after ${keyword}`, this.current().span);
    }
    const name = nameTok?.value ?? '<unnamed>';

    // Optional SOURCE=identifier
    let source: string | undefined;
    if (this.match('identifier', 'SOURCE')) {
      this.advance(); // SOURCE
      const eq = this.consume('equals');
      if (eq) {
        const valTok = this.consume('identifier');
        if (valTok) source = valTok.value;
      }
    }

    const lbrace = this.consume('lbrace');
    if (!lbrace) {
      this.addDiagnostic('error', 'unclosed-block', `Expected '{' after COMPONENT ${name}`, this.current().span);
      const span = makeSpan(keywordToken.span.start, this.current().span.end);
      const block: ComponentBlock = { kind: 'component', span, keyword, name, lines: [] };
      if (source !== undefined) block.source = source;
      return block;
    }
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    const lines: ComponentLine[] = body.lines.map(l => ({ raw: l.raw, span: l.span }));
    const block: ComponentBlock = { kind: 'component', span, keyword, name, lines };
    if (source !== undefined) block.source = source;
    return block;
  }

  // ── BEHAVIOR ─────────────────────────────────────────────────────────────

  private parseBehavior(keywordToken: Token, lbrace: Token, name?: string): BehaviorBlock {
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);
    const rules: BehaviorRule[] = body.lines.map(l => ({ raw: l.raw, span: l.span }));
    const block: BehaviorBlock = { kind: 'behavior', span, rules };
    if (name !== undefined) block.name = name;
    return block;
  }

  // ── CHECKLIST ────────────────────────────────────────────────────────────

  private parseChecklist(keywordToken: Token, lbrace: Token): ChecklistBlock {
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);

    const items: ChecklistItem[] = [];
    for (const line of body.lines) {
      const m = line.raw.match(/^\[\s*([xX ]?)\s*\]\s*(.*)$/);
      if (!m) {
        this.addDiagnostic('error', 'invalid-checklist-item', `Checklist items must use '[ ] ...' or '[x] ...' syntax: "${line.raw}"`, line.span);
        continue;
      }
      const checkChar = m[1] ?? '';
      const text = (m[2] ?? '').trim();
      items.push({ checked: checkChar === 'x' || checkChar === 'X', text, span: line.span });
    }
    return { kind: 'checklist', span, items };
  }

  // ── Extension (catch-all) ────────────────────────────────────────────────

  private parseExtension(keywordToken: Token, lbrace: Token, name?: string): ExtensionBlock {
    const body = this.collectBlockBody();
    const span = body.rbrace
      ? makeSpan(keywordToken.span.start, body.rbrace.span.end)
      : makeSpan(keywordToken.span.start, lbrace.span.end);
    const block: ExtensionBlock = {
      kind: 'extension',
      span,
      keyword: keywordToken.text,
      body: body.rawText.trim(),
    };
    if (name !== undefined) block.name = name;
    return block;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function describeToken(t: Token): string {
  if (t.kind === 'eof') return 'end of input';
  return `${t.kind} "${t.text.length > 40 ? t.text.slice(0, 40) + '…' : t.text}"`;
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function classifyValue(raw: string): TokenValue['type'] {
  const t = raw.trim();
  if (t.startsWith('"')) return 'string';
  if (/^#[0-9a-fA-F]+$/.test(t)) return 'color';
  if (/^[0-9.]+(px|em|rem|vh|vw|%|fr|ms|s)$/.test(t)) return 'length';
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^[A-Za-z_][\w-]*$/.test(t)) return 'identifier';
  return 'unknown';
}

function splitOnPipe(s: string): string[] {
  // Split on `|` but preserve `||` (logical OR — though R++ doesn't really use it)
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '|' && s[i + 1] !== '|') {
      parts.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  parts.push(buf);
  return parts;
}

function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  if (lines.length < 2) return { headers: [], rows: [] };
  const headerLine = lines[0]!;
  const headers = headerLine.split('|').slice(1, -1).map(h => h.trim());
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i]!.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length > 0) rows.push(cells);
  }
  return { headers, rows };
}

interface IndentedLine {
  indent: number;
  text: string;
  line: number;
}

function parseIndentedLines(text: string, baseLine: number): IndentedLine[] {
  const result: IndentedLine[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    let indent = 0;
    for (const ch of line) {
      if (ch === ' ') indent++;
      else if (ch === '\t') indent += 4;
      else break;
    }
    // Strip line comments
    const commentIdx = line.indexOf('//');
    const stripped = (commentIdx >= 0 ? line.slice(0, commentIdx) : line).trim();
    if (stripped.length === 0) continue;
    result.push({ indent, text: stripped, line: baseLine + i });
  }
  return result;
}

function buildStructureTree(lines: IndentedLine[], startIndex: number, into: StructureNode[]): number {
  let i = startIndex;
  if (i >= lines.length) return i;
  const baseIndent = lines[i]!.indent;
  while (i < lines.length && lines[i]!.indent === baseIndent) {
    const line = lines[i]!;
    const node = parseStructureLine(line.text, line.line);
    i++;
    // Inline-children line (next line's first chars are `[` and indent > baseIndent)
    if (i < lines.length && lines[i]!.indent > baseIndent && lines[i]!.text.startsWith('[')) {
      node.inlineChildren = parseInlineChildren(lines[i]!.text);
      i++;
    }
    // Indented children
    if (i < lines.length && lines[i]!.indent > baseIndent) {
      const childIndent = lines[i]!.indent;
      while (i < lines.length && lines[i]!.indent >= childIndent) {
        if (lines[i]!.indent === childIndent) {
          const beforeRecurse = i;
          i = buildStructureTree(lines, beforeRecurse, node.children);
          if (i === beforeRecurse) i++; // safety against infinite loop
        } else {
          i++;
        }
      }
    }
    into.push(node);
  }
  return i;
}

function parseStructureLine(text: string, lineNum: number): StructureNode {
  // Forms:
  //   Name
  //   Name: pattern args | property | property
  //   [Foo] [Bar]   ← but those are inline-children, handled separately
  const colonIdx = text.indexOf(':');
  let name: string;
  let pattern: string | undefined;
  let properties: string[] = [];

  if (colonIdx === -1) {
    name = text.trim();
  } else {
    name = text.slice(0, colonIdx).trim();
    const after = text.slice(colonIdx + 1).trim();
    const parts = splitOnPipe(after).map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      pattern = parts[0];
      properties = parts.slice(1);
    }
  }

  const span: Span = {
    start: { offset: 0, line: lineNum, column: 1 },
    end: { offset: 0, line: lineNum, column: text.length + 1 },
  };

  const node: StructureNode = {
    name,
    properties,
    inlineChildren: [],
    children: [],
    span,
  };
  if (pattern !== undefined) node.pattern = pattern;
  return node;
}

function parseInlineChildren(text: string): string[] {
  const result: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    result.push(m[1]!.trim());
  }
  return result;
}
