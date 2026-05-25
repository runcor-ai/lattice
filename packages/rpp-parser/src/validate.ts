// Semantic validation pass — runs over a parsed AST and checks cross-block references.

import type {
  Block,
  ChecklistBlock,
  ComponentBlock,
  RppDocument,
  StructureBlock,
  StructureNode,
} from './ast.js';
import type { Diagnostic, Severity } from './diagnostic.js';
import { diagnostic } from './diagnostic.js';

export interface ValidateOptions {
  /**
   * Names that are allowed in STRUCTURE without a corresponding COMPONENT/SECTION/VIEW
   * definition — typically engine-provided primitives like AuthMiddleware, RateLimiter,
   * ErrorHandler, Router, etc. Suppresses the `undefined-component` warning for these.
   */
  externalNames?: ReadonlySet<string> | readonly string[];

  /**
   * If true, undefined-component diagnostics are emitted as 'error' severity
   * (fatal — the writing skill must regenerate). Default false: undefined components
   * are 'warning' severity, because R++ specs commonly reference engine-provided
   * primitives that don't need user-defined COMPONENT blocks.
   */
  strictComponentResolution?: boolean;
}

/**
 * Validate cross-block constraints on an AST. Returns diagnostics array
 * (empty if everything is well-formed).
 *
 * **Note on undefined components:** by default this emits `warning` severity for
 * names referenced in STRUCTURE that have no COMPONENT block. R++ STRUCTURE
 * commonly references engine-provided infrastructure (AuthMiddleware, RateLimiter,
 * ErrorHandler, Router, EventLoop, etc.) that the user's spec doesn't define.
 * Pass `externalNames` to suppress warnings for known primitives, or
 * `strictComponentResolution: true` to elevate to errors.
 */
export function validate(ast: RppDocument, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const external = new Set(options.externalNames ?? []);
  const undefinedSeverity: Severity = options.strictComponentResolution ? 'error' : 'warning';

  const componentNames = new Set<string>();
  const seenComponentNames = new Map<string, ComponentBlock>();
  for (const block of ast.blocks) {
    if (block.kind === 'component') {
      if (seenComponentNames.has(block.name)) {
        diagnostics.push(
          diagnostic(
            'warning',
            'duplicate-component-name',
            `Duplicate ${block.keyword} name "${block.name}" — only the first will be referenced by STRUCTURE`,
            block.span,
          ),
        );
      } else {
        seenComponentNames.set(block.name, block);
      }
      componentNames.add(block.name);
    }
  }

  // Walk STRUCTURE blocks and check every referenced component exists
  for (const block of ast.blocks) {
    if (block.kind === 'structure') {
      checkStructureReferences(block, componentNames, external, undefinedSeverity, diagnostics);
    }
    if (block.kind === 'checklist') {
      checkChecklistQuality(block, diagnostics);
    }
  }

  return diagnostics;
}

function checkStructureReferences(
  block: StructureBlock,
  defined: Set<string>,
  external: Set<string>,
  severity: Severity,
  diagnostics: Diagnostic[],
): void {
  const visit = (node: StructureNode): void => {
    if (!defined.has(node.name) && !external.has(node.name)) {
      diagnostics.push(
        diagnostic(
          severity,
          'undefined-component',
          `STRUCTURE references "${node.name}" but no COMPONENT/SECTION/VIEW block defines it. ` +
            `If "${node.name}" is an engine-provided primitive, pass it via validate(ast, { externalNames: [...] }).`,
          node.span,
          { name: node.name },
        ),
      );
    }
    for (const child of node.inlineChildren) {
      if (!defined.has(child) && !external.has(child)) {
        diagnostics.push(
          diagnostic(
            severity,
            'undefined-component',
            `STRUCTURE references "${child}" (inline) but no COMPONENT/SECTION/VIEW block defines it. ` +
              `If "${child}" is an engine-provided primitive, pass it via validate(ast, { externalNames: [...] }).`,
            node.span,
            { name: child },
          ),
        );
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const root of block.roots) visit(root);
}

const VAGUE_PHRASES = [
  /\bworks correctly\b/i,
  /\bhandles errors\b/i,
  /\bvalidation works\b/i,
  /\b(is|be) good\b/i,
  /\bproperly\b/i,
];

function checkChecklistQuality(
  block: ChecklistBlock,
  diagnostics: Diagnostic[],
): void {
  for (const item of block.items) {
    for (const re of VAGUE_PHRASES) {
      if (re.test(item.text)) {
        diagnostics.push(
          diagnostic(
            'warning',
            'invalid-checklist-item',
            `CHECKLIST item is vague — should be specific and falsifiable: "${item.text}"`,
            item.span,
          ),
        );
        break;
      }
    }
  }
}

/** Convenience: collect all blocks of a given kind. */
export function blocksOfKind<K extends Block['kind']>(
  ast: RppDocument,
  kind: K,
): Extract<Block, { kind: K }>[] {
  return ast.blocks.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind);
}
