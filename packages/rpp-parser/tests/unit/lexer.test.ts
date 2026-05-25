import { describe, it, expect } from 'vitest';
import { lex } from '../../src/lexer.js';

describe('lexer', () => {
  it('tokenizes block keyword + braces', () => {
    const { tokens } = lex('TARGET {\n}');
    const kinds = tokens.filter(t => t.kind !== 'newline').map(t => t.kind);
    expect(kinds).toEqual(['identifier', 'lbrace', 'rbrace', 'eof']);
  });

  it('tokenizes string literals', () => {
    const { tokens } = lex('"hello world"');
    expect(tokens[0]?.kind).toBe('string');
    expect(tokens[0]?.value).toBe('hello world');
  });

  it('handles escape sequences in strings', () => {
    const { tokens } = lex('"a \\"b\\" c"');
    expect(tokens[0]?.value).toBe('a "b" c');
  });

  it('tokenizes color literals', () => {
    const { tokens } = lex('#0d1117');
    expect(tokens[0]?.kind).toBe('color');
    expect(tokens[0]?.text).toBe('#0d1117');
  });

  it('tokenizes length values', () => {
    const { tokens } = lex('16px 50% 1.5em');
    expect(tokens[0]?.kind).toBe('length');
    expect(tokens[0]?.text).toBe('16px');
    expect(tokens[1]?.text).toBe('50%');
    expect(tokens[2]?.text).toBe('1.5em');
  });

  it('tokenizes number literals', () => {
    const { tokens } = lex('42 3.14');
    expect(tokens[0]?.kind).toBe('number');
    expect(tokens[1]?.kind).toBe('number');
  });

  it('tokenizes arrow operators', () => {
    const { tokens } = lex('=> -> →');
    expect(tokens.filter(t => t.kind === 'arrow').map(t => t.text)).toEqual(['=>', '->', '→']);
  });

  it('tokenizes ;; thick arrow for conditional branches', () => {
    const { tokens } = lex(';;');
    expect(tokens[0]?.kind).toBe('thickArrow');
  });

  it('tokenizes pipe and equals', () => {
    const { tokens } = lex('| =');
    expect(tokens[0]?.kind).toBe('pipe');
    expect(tokens[1]?.kind).toBe('equals');
  });

  it('tokenizes line comments', () => {
    const { tokens } = lex('// this is a comment\nTARGET');
    expect(tokens[0]?.kind).toBe('comment');
    expect(tokens[0]?.value).toBe('this is a comment');
  });

  it('emits diagnostic for unterminated string', () => {
    const { diagnostics } = lex('"unterminated');
    expect(diagnostics.some(d => d.code === 'unterminated-string')).toBe(true);
  });

  it('coalesces consecutive newlines', () => {
    const { tokens } = lex('a\n\n\nb');
    const newlines = tokens.filter(t => t.kind === 'newline');
    expect(newlines.length).toBe(1);
  });

  it('tracks span positions across lines', () => {
    const { tokens } = lex('a\nb');
    const a = tokens[0]!;
    const b = tokens[2]!;
    expect(a.span.start.line).toBe(1);
    expect(b.span.start.line).toBe(2);
  });
});
