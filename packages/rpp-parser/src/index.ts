// Public API for rpp-parser.

export { parse } from './parser.js';
export { validate, blocksOfKind } from './validate.js';
export { lex } from './lexer.js';

// Type exports
export type { ParseResult } from './parser.js';
export type { Token, TokenKind, LexResult } from './lexer.js';
export type { Position, Span } from './span.js';
export type { Diagnostic, Severity, DiagnosticCode } from './diagnostic.js';
export type {
  RppDocument,
  Block,
  TargetBlock,
  TokensBlock,
  TokenValue,
  FormatBlock,
  FormatFunction,
  MapBlock,
  MapEntries,
  DataBlock,
  InitBlock,
  InitAssignment,
  StructureBlock,
  StructureNode,
  ComponentBlock,
  ComponentLine,
  BehaviorBlock,
  BehaviorRule,
  ChecklistBlock,
  ChecklistItem,
  ExtensionBlock,
  Comment,
} from './ast.js';
