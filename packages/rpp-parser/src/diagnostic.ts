// Structured diagnostics — Constitution Principle IV.
// Parser never throws on syntax errors; emits Diagnostic[] and recovers.

import type { Span } from './span.js';

export type Severity = 'error' | 'warning' | 'extension' | 'info';

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  /** Stable diagnostic code — see DiagnosticCode for the enumeration. */
  code: DiagnosticCode;
  /** Optional structured data attached to specific codes. */
  data?: Record<string, unknown>;
}

/**
 * Stable diagnostic codes. Consumers (e.g. the writing skill's Step 10)
 * dispatch on these to apply targeted fixes.
 */
export type DiagnosticCode =
  // Lexer-level
  | 'unterminated-string'
  | 'unterminated-comment'
  | 'invalid-character'
  // Block-level structural
  | 'unclosed-block'
  | 'unexpected-token'
  | 'unknown-block'
  | 'expected-block-keyword'
  | 'expected-identifier'
  | 'expected-string'
  | 'expected-value'
  // TOKENS
  | 'invalid-token-syntax'
  | 'duplicate-token-name'
  // FORMAT
  | 'invalid-format-syntax'
  // MAP
  | 'invalid-map-syntax'
  // DATA
  | 'invalid-data-table'
  // STRUCTURE / COMPONENT
  | 'undefined-component'
  | 'duplicate-component-name'
  // BEHAVIOR
  | 'invalid-behavior-rule'
  // CHECKLIST
  | 'invalid-checklist-item'
  // Cross-block reference
  | 'undeclared-token-reference'
  | 'undeclared-map-reference'
  | 'undeclared-format-reference'
  // Extension (not in v0.5 spec but accepted)
  | 'unknown-block-accepted-as-extension';

export function diagnostic(
  severity: Severity,
  code: DiagnosticCode,
  message: string,
  span: Span,
  data?: Record<string, unknown>,
): Diagnostic {
  return data === undefined ? { severity, code, message, span } : { severity, code, message, span, data };
}
