// Real-source validation — Constitution Principle III.
// Parse every .rpp fixture (sourced from runcor-ai org) and verify no error diagnostics.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith('.rpp'));

describe('real-source .rpp fixtures from runcor-ai org', () => {
  for (const fixture of fixtures) {
    it(`parses ${fixture} without errors`, () => {
      const source = readFileSync(join(fixturesDir, fixture), 'utf8');
      const { ast, diagnostics } = parse(source);
      const errors = diagnostics.filter(d => d.severity === 'error');
      if (errors.length > 0) {
        console.error(`${fixture} errors:`, errors);
      }
      expect(errors).toEqual([]);
      expect(ast.blocks.length).toBeGreaterThan(0);
    });
  }
});
