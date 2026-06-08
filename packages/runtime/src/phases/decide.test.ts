import type { TokenValue } from '@runcor/rpp-parser';
import { describe, it, expect } from 'vitest';

import { coerceTokenValue, unescapeRppString } from './decide.js';

const sv = (raw: string): TokenValue => ({ raw, type: 'string' }) as unknown as TokenValue;

/**
 * Item 14 / Bug 1 — R++ string tokens must have their escape sequences
 * unescaped. The 2026-06-06 live run wrote literal `\n` / `\"` into every
 * file (breaking the deliverables AND the plan gate's checkbox regex).
 */
describe('unescapeRppString', () => {
  it('unescapes \\n \\t \\r \\" \\\\', () => {
    expect(unescapeRppString('a\\nb')).toBe('a\nb');
    expect(unescapeRppString('x\\ty')).toBe('x\ty');
    expect(unescapeRppString('say \\"hi\\"')).toBe('say "hi"');
    expect(unescapeRppString('a\\\\b')).toBe('a\\b');
  });
  it('leaves already-clean text untouched and supports \\uXXXX', () => {
    expect(unescapeRppString('plain text')).toBe('plain text');
    expect(unescapeRppString('\\u0041')).toBe('A');
  });
});

describe('coerceTokenValue — string tokens (Item 14)', () => {
  it('turns a literal \\n into a real newline', () => {
    expect(coerceTokenValue(sv('"a\\nb"'))).toBe('a\nb');
  });

  it('the plan-gate case: a checkbox line gets a real line break the gate regex can match', () => {
    const body = coerceTokenValue(sv('"# Plan\\n\\n- [ ] step one\\n- [ ] step two"')) as string;
    expect(/^\s*- \[[ xX]\]/m.test(body)).toBe(true);
    expect(body.split('\n').length).toBeGreaterThan(2);
  });

  it('does NOT unescape non-string tokens', () => {
    expect(coerceTokenValue({ raw: 'foo\\nbar', type: 'identifier' } as unknown as TokenValue)).toBe('foo\\nbar');
  });

  it('numbers still coerce', () => {
    expect(coerceTokenValue({ raw: '42', type: 'number' } as unknown as TokenValue)).toBe(42);
  });
});
