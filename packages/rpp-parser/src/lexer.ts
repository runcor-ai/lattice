// Hand-written lexer for R++ v0.5.
// Tokenizes source into a Token[] with span tracking.
// Constitution Principle V: zero runtime deps. Constitution FR-004: hand-written
// tokenizer (no regex shortcuts that miss edge cases).

import type { Diagnostic } from './diagnostic.js';
import { diagnostic } from './diagnostic.js';
import type { Position, Span } from './span.js';
import { advance, ORIGIN, makeSpan } from './span.js';

export type TokenKind =
  | 'identifier'    // Block keywords + names + variables
  | 'string'        // Quoted "..." literals (with escape handling)
  | 'number'        // Plain integers and floats
  | 'color'         // #rrggbb / #rgb (treated as a single token)
  | 'length'        // 16px / 50% / 1.5em
  | 'lbrace'        // {
  | 'rbrace'        // }
  | 'lparen'        // (
  | 'rparen'        // )
  | 'lbracket'      // [
  | 'rbracket'      // ]
  | 'colon'         // :
  | 'comma'         // ,
  | 'pipe'          // |  (co-apply or table separator)
  | 'arrow'         // =>  (FORMAT body) or ->  (rare) or →
  | 'thickArrow'    // ;;  (conditional branch separator)
  | 'equals'        // =
  | 'newline'       // significant for line-oriented blocks
  | 'comment'       // // ...
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** The verbatim text of the token (for strings, the unquoted/unescaped value is in `value`). */
  text: string;
  /** Decoded value for strings (unquoted, unescaped). For other kinds, equals text. */
  value: string;
  span: Span;
}

const SINGLE_CHAR_TOKENS: Record<string, TokenKind> = {
  '{': 'lbrace',
  '}': 'rbrace',
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  ':': 'colon',
  ',': 'comma',
  '|': 'pipe',
  '=': 'equals',
};

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isAlnum(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch);
}
function isHex(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let pos: Position = { ...ORIGIN };

  function peek(offset = 0): string {
    return source[pos.offset + offset] ?? '';
  }

  function consume(): string {
    const ch = source[pos.offset] ?? '';
    pos = advance(pos, ch);
    return ch;
  }

  function pushSimple(kind: TokenKind, text: string, start: Position): void {
    tokens.push({ kind, text, value: text, span: makeSpan(start, pos) });
  }

  function readString(start: Position): void {
    consume(); // opening "
    let value = '';
    let closed = false;
    while (pos.offset < source.length) {
      const ch = peek();
      if (ch === '"') {
        consume();
        closed = true;
        break;
      }
      if (ch === '\\' && pos.offset + 1 < source.length) {
        consume();
        const esc = consume();
        switch (esc) {
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          case 'r': value += '\r'; break;
          case '"': value += '"'; break;
          case '\\': value += '\\'; break;
          default: value += esc;
        }
        continue;
      }
      if (ch === '\n') {
        // Unclosed string at newline — emit diagnostic, treat as terminated
        break;
      }
      value += ch;
      consume();
    }
    if (!closed) {
      diagnostics.push(diagnostic('error', 'unterminated-string', `Unterminated string literal`, makeSpan(start, pos)));
    }
    tokens.push({ kind: 'string', text: source.slice(start.offset, pos.offset), value, span: makeSpan(start, pos) });
  }

  function readNumberOrLength(start: Position): void {
    let raw = '';
    while (isDigit(peek()) || peek() === '.') {
      raw += consume();
    }
    // Length unit suffix? (px, em, rem, vh, vw, %, fr, ms, s)
    let unit = '';
    while (isAlpha(peek()) || peek() === '%') {
      unit += consume();
    }
    if (unit) {
      tokens.push({ kind: 'length', text: raw + unit, value: raw + unit, span: makeSpan(start, pos) });
    } else {
      tokens.push({ kind: 'number', text: raw, value: raw, span: makeSpan(start, pos) });
    }
  }

  function readColor(start: Position): void {
    let raw = consume(); // #
    while (isHex(peek())) raw += consume();
    tokens.push({ kind: 'color', text: raw, value: raw, span: makeSpan(start, pos) });
  }

  function readIdentifier(start: Position): void {
    let raw = '';
    while (isAlnum(peek()) || peek() === '-') {
      raw += consume();
    }
    tokens.push({ kind: 'identifier', text: raw, value: raw, span: makeSpan(start, pos) });
  }

  function readLineComment(start: Position): void {
    let raw = '';
    while (pos.offset < source.length && peek() !== '\n') {
      raw += consume();
    }
    tokens.push({ kind: 'comment', text: raw, value: raw.slice(2).trim(), span: makeSpan(start, pos) });
  }

  while (pos.offset < source.length) {
    const ch = peek();
    const start = { ...pos };

    // Whitespace (not newline)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      consume();
      continue;
    }

    // Newline (significant for line-oriented blocks)
    if (ch === '\n') {
      consume();
      // Coalesce consecutive newlines into a single token
      while (peek() === '\n' || peek() === ' ' || peek() === '\t' || peek() === '\r') {
        if (peek() === '\n') consume();
        else consume();
      }
      tokens.push({ kind: 'newline', text: '\n', value: '\n', span: makeSpan(start, pos) });
      continue;
    }

    // Comments — // ...
    if (ch === '/' && peek(1) === '/') {
      readLineComment(start);
      continue;
    }

    // Strings
    if (ch === '"') {
      readString(start);
      continue;
    }

    // Numbers / lengths
    if (isDigit(ch)) {
      readNumberOrLength(start);
      continue;
    }

    // Color hex
    if (ch === '#' && isHex(peek(1))) {
      readColor(start);
      continue;
    }

    // Conditional branch separator ;;
    if (ch === ';' && peek(1) === ';') {
      consume();
      consume();
      tokens.push({ kind: 'thickArrow', text: ';;', value: ';;', span: makeSpan(start, pos) });
      continue;
    }

    // Arrow => (and -> as alias)
    if (ch === '=' && peek(1) === '>') {
      consume();
      consume();
      tokens.push({ kind: 'arrow', text: '=>', value: '=>', span: makeSpan(start, pos) });
      continue;
    }
    if (ch === '-' && peek(1) === '>') {
      consume();
      consume();
      tokens.push({ kind: 'arrow', text: '->', value: '->', span: makeSpan(start, pos) });
      continue;
    }
    // Unicode arrow → (used in BEHAVIOR `on event → action`)
    if (ch === '\u2192') {
      consume();
      tokens.push({ kind: 'arrow', text: '→', value: '→', span: makeSpan(start, pos) });
      continue;
    }

    // Single-char tokens
    const single = SINGLE_CHAR_TOKENS[ch];
    if (single) {
      consume();
      pushSimple(single, ch, start);
      continue;
    }

    // Identifier (block keyword, name, variable)
    if (isAlpha(ch)) {
      readIdentifier(start);
      continue;
    }

    // Unknown character — emit diagnostic, skip
    consume();
    diagnostics.push(diagnostic('warning', 'invalid-character', `Unexpected character: ${JSON.stringify(ch)}`, makeSpan(start, pos)));
  }

  tokens.push({ kind: 'eof', text: '', value: '', span: makeSpan(pos, pos) });
  return { tokens, diagnostics };
}
