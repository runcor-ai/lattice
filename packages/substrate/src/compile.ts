import { LAWS } from './laws.js';

/**
 * compileLaws — compiles the eleven laws as the laws-block that sits
 * at the TOP of every model call's prompt.
 *
 * Format is intentionally terse so the laws cost few tokens. R++
 * tightening lands in slice 8 alongside the parser; for slice 5 the
 * block is well-structured plain text that downstream parsers can
 * already recognise.
 */
export function compileLaws(): string {
  const lines: string[] = ['<laws>'];
  for (const l of LAWS) {
    lines.push(`${l.index}. ${l.id}: ${l.statement}`);
  }
  lines.push('</laws>');
  return lines.join('\n');
}

/**
 * The byte-equal canonical text used by the laws-at-the-top test
 * (T126). Frozen string; do not reorder.
 */
export const CANONICAL_LAWS_BLOCK = compileLaws();
