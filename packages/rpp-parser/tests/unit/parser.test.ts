import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser.js';
import type { TargetBlock, TokensBlock, ComponentBlock, StructureBlock, ChecklistBlock } from '../../src/ast.js';

describe('parse — top-level dispatch', () => {
  it('parses an empty document', () => {
    const { ast, diagnostics } = parse('');
    expect(ast.blocks).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('parses a single TARGET block', () => {
    const { ast, diagnostics } = parse(`
TARGET {
  output: "User dashboard"
  lang: React + TypeScript
  profile: ui
}`);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(ast.blocks.length).toBe(1);
    const target = ast.blocks[0] as TargetBlock;
    expect(target.kind).toBe('target');
    expect(target.output).toBe('User dashboard');
    expect(target.lang).toBe('React + TypeScript');
    expect(target.profiles).toEqual(['ui']);
  });

  it('parses TOKENS block with pipe-separated entries', () => {
    const { ast, diagnostics } = parse(`
TOKENS {
  primary:#0d1117 | gapMd:16px | maxRetries:3
}`);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    const tokens = ast.blocks[0] as TokensBlock;
    expect(tokens.kind).toBe('tokens');
    expect(tokens.tokens.size).toBe(3);
    expect(tokens.tokens.get('primary')?.raw).toBe('#0d1117');
    expect(tokens.tokens.get('primary')?.type).toBe('color');
    expect(tokens.tokens.get('gapMd')?.raw).toBe('16px');
    expect(tokens.tokens.get('gapMd')?.type).toBe('length');
    expect(tokens.tokens.get('maxRetries')?.raw).toBe('3');
    expect(tokens.tokens.get('maxRetries')?.type).toBe('number');
  });

  it('flags duplicate token names', () => {
    const { diagnostics } = parse(`
TOKENS {
  x:1 | x:2
}`);
    expect(diagnostics.some(d => d.code === 'duplicate-token-name')).toBe(true);
  });

  it('flags invalid token syntax (= instead of :)', () => {
    const { diagnostics } = parse(`
TOKENS {
  x = 1
}`);
    expect(diagnostics.some(d => d.code === 'invalid-token-syntax')).toBe(true);
  });

  it('parses COMPONENT block with body lines', () => {
    const { ast, diagnostics } = parse(`
COMPONENT MyComponent {
  title: "Hello"
  border: 1px solid black
}`);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    const comp = ast.blocks[0] as ComponentBlock;
    expect(comp.kind).toBe('component');
    expect(comp.name).toBe('MyComponent');
    expect(comp.keyword).toBe('COMPONENT');
    expect(comp.lines.length).toBeGreaterThan(0);
  });

  it('honors SECTION and VIEW as COMPONENT aliases', () => {
    const sec = parse('SECTION Foo { x: 1 }');
    const view = parse('VIEW Bar { y: 2 }');
    expect((sec.ast.blocks[0] as ComponentBlock).keyword).toBe('SECTION');
    expect((view.ast.blocks[0] as ComponentBlock).keyword).toBe('VIEW');
  });

  it('parses STRUCTURE block with indented tree', () => {
    const { ast, diagnostics } = parse(`
STRUCTURE {
  Root: sequence
    Header
    Body
    Footer
}`);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    const s = ast.blocks[0] as StructureBlock;
    expect(s.kind).toBe('structure');
    expect(s.roots.length).toBe(1);
    expect(s.roots[0]?.name).toBe('Root');
    expect(s.roots[0]?.pattern).toBe('sequence');
    expect(s.roots[0]?.children.length).toBe(3);
    expect(s.roots[0]?.children.map(c => c.name)).toEqual(['Header', 'Body', 'Footer']);
  });

  it('parses STRUCTURE inline-children syntax [Foo] [Bar]', () => {
    const { ast } = parse(`
STRUCTURE {
  KPIRow: group 4
    [Total] [Active] [Revenue] [Errors]
}`);
    const s = ast.blocks[0] as StructureBlock;
    expect(s.roots[0]?.inlineChildren).toEqual(['Total', 'Active', 'Revenue', 'Errors']);
  });

  it('parses CHECKLIST items', () => {
    const { ast } = parse(`
CHECKLIST {
  [ ] first item
  [x] checked item
  [X] also checked
}`);
    const c = ast.blocks[0] as ChecklistBlock;
    expect(c.items.length).toBe(3);
    expect(c.items[0]?.checked).toBe(false);
    expect(c.items[1]?.checked).toBe(true);
    expect(c.items[2]?.checked).toBe(true);
  });

  it('flags malformed checklist items', () => {
    const { diagnostics } = parse(`
CHECKLIST {
  this is not a checklist item
}`);
    expect(diagnostics.some(d => d.code === 'invalid-checklist-item')).toBe(true);
  });

  it('accepts unknown blocks as extensions with warning', () => {
    const { ast, diagnostics } = parse(`
RUNTIME_INPUTS {
  foo: bar
}`);
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.kind).toBe('extension');
    expect(diagnostics.some(d => d.code === 'unknown-block-accepted-as-extension')).toBe(true);
  });

  it('emits unclosed-block on missing closing brace', () => {
    const { diagnostics } = parse('TOKENS {\n  a:1\n');
    expect(diagnostics.some(d => d.code === 'unclosed-block')).toBe(true);
  });

  it('recovers after error and continues parsing subsequent blocks', () => {
    const { ast, diagnostics } = parse(`
TOKENS {
  a = 1
}
TARGET {
  output: "After error"
}`);
    expect(diagnostics.some(d => d.code === 'invalid-token-syntax')).toBe(true);
    // Should still find both blocks
    expect(ast.blocks.length).toBe(2);
    expect(ast.blocks[1]?.kind).toBe('target');
  });
});
