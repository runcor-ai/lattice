# rpp-parser

> Pure-TypeScript parser, validator, and formatter for the R++ structured-spec language.
> Zero runtime dependencies.

`rpp-parser` mechanically reads R++ source — the structured specification language used across the runcor AI runtime family — and produces a typed AST. It also validates semantic constraints and pretty-prints ASTs back to source.

It exists because R++ today is LLM-read (the model self-verifies the CHECKLIST). To unlock mechanical enforcement — substrate validating specs at install time, `runcor-skills` synthesizing new specs from observed outcomes, IDE tooling — you need a real parser.

## Install

```bash
npm install rpp-parser
```

## Quickstart

```ts
import { parse, validate, format } from 'rpp-parser';

const source = `
  TARGET {
    output: "User dashboard"
    lang: React + TypeScript
    profile: ui
  }
  TOKENS { primary:#0d1117 | gapMd:16px }
`;

const { ast, diagnostics } = parse(source);

if (diagnostics.some(d => d.severity === 'error')) {
  for (const d of diagnostics) {
    console.error(\`\${d.severity}: \${d.message} at \${d.span.start.line}:\${d.span.start.column}\`);
  }
}

console.log(ast.target?.output); // "User dashboard"
console.log(ast.tokens.get('primary')); // "#0d1117"

// Semantic validation (separate pass)
const semanticErrors = validate(ast);

// Pretty-print back to canonical R++
const canonical = format(ast);
```

## Zero deps

`dependencies: {}` in package.json. Pure TypeScript, hand-written lexer + recursive-descent parser. No regex shortcuts that miss edge cases.

## Status

v0.1.0 — see [`specs/001-rpp-parser-core/spec.md`](./specs/001-rpp-parser-core/spec.md) for the full feature specification, [`.specify/memory/constitution.md`](./.specify/memory/constitution.md) for the project's governing principles.

## Part of the runcor family

- [runcor](https://github.com/runcor-ai/runcor) — AI runtime engine
- [runcor-substrate](https://github.com/runcor-ai/runcor-substrate) — Laws + Reality + discernment gate
- [runcor-memory](https://github.com/runcor-ai/runcor-memory) — Long Chain Memory
- [runcor-data](https://github.com/runcor-ai/runcor-data) — Data Fabric
- [runcor-integration](https://github.com/runcor-ai/runcor-integration) — Schema discovery + dynamic tools
- [runcor-dialectic](https://github.com/runcor-ai/runcor-dialectic) — Player/Coach/Judge deliberation
- [rpp](https://github.com/runcor-ai/rpp) — R++ language specification
- **rpp-parser** — Parser/validator/formatter for R++ (this repo)

## License

MIT — see [`LICENSE`](./LICENSE).
