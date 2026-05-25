#!/usr/bin/env bash
# One-shot scaffolder for the monorepo's package skeletons.
# Idempotent: re-running does not overwrite existing files.
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(substrate memory identity goals drives temporal decider dialectic watchdog skills trace engine capabilities jobs collaboration snapshot runtime slowclock bridge-shared)

for pkg in "${PKGS[@]}"; do
  dir="packages/$pkg"
  mkdir -p "$dir/src"
  if [ ! -f "$dir/package.json" ]; then
    cat > "$dir/package.json" <<JSON
{
  "name": "@runcor/$pkg",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
JSON
  fi
  if [ ! -f "$dir/tsconfig.json" ]; then
    cat > "$dir/tsconfig.json" <<JSON
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "dist"]
}
JSON
  fi
  if [ ! -f "$dir/src/index.ts" ]; then
    cat > "$dir/src/index.ts" <<TS
/**
 * @runcor/$pkg
 *
 * Skeleton — real implementation lands in its assigned slice (see
 * specs/001-lattice-core/tasks.md). The empty export keeps TypeScript
 * happy as an ES module.
 */
export {};
TS
  fi
  if [ ! -f "$dir/src/index.test.ts" ]; then
    cat > "$dir/src/index.test.ts" <<TS
import { describe, it, expect } from 'vitest';

describe('@runcor/$pkg skeleton', () => {
  it('package loads', () => {
    expect(true).toBe(true);
  });
});
TS
  fi
done

echo "Scaffolded \${#PKGS[@]} packages."
