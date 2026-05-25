// Source position tracking — used throughout the parser for span-accurate diagnostics.

export interface Position {
  /** Zero-based byte offset into the source string. */
  offset: number;
  /** One-based line number. */
  line: number;
  /** One-based column number. */
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export const ORIGIN: Position = { offset: 0, line: 1, column: 1 };

export function makeSpan(start: Position, end: Position): Span {
  return { start, end };
}

/** Span covering a single position (zero-length). */
export function pointSpan(at: Position): Span {
  return { start: at, end: at };
}

/** Span from `a` start to `b` end. */
export function joinSpans(a: Span, b: Span): Span {
  return { start: a.start, end: b.end };
}

/** Advance a position by reading one character. */
export function advance(pos: Position, ch: string): Position {
  if (ch === '\n') {
    return { offset: pos.offset + 1, line: pos.line + 1, column: 1 };
  }
  return { offset: pos.offset + 1, line: pos.line, column: pos.column + 1 };
}
