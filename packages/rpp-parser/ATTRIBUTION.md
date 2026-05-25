# Attribution — rpp-parser

This package is **vendored** from the upstream `runcor-ai/rpp-parser`
repository per constitution Principle IX and intent spec §11:

> The R++ parser is pure TypeScript with zero runtime dependencies — bring
> it in whole; do not redesign it.

## Source

- **Upstream**: https://github.com/runcor-ai/rpp-parser
- **License**: MIT (see `LICENSE.upstream` in this directory, and root
  `LICENSE` of this monorepo)
- **Vendored at commit**: `980db39baa3cc865f265e8e0a89d03e82383b963`
- **Vendored on**: 2026-05-24
- **Tag/version**: v0.1.1

## Adaptations made

- Renamed package name from `rpp-parser` to `@runcor/rpp-parser` to fit
  the monorepo's `@runcor/*` namespace.
- Replaced `tsup` build with `tsc -b` to integrate with the monorepo's
  TypeScript project references and turborepo task graph.
- Removed publish-related fields; this package is workspace-private.
- Removed devDependencies that conflict with the monorepo root.

## Re-syncing from upstream

To pull a new version of the parser:

```sh
git clone https://github.com/runcor-ai/rpp-parser.git /tmp/rpp-parser-src
rm -rf packages/rpp-parser/src packages/rpp-parser/tests
cp -r /tmp/rpp-parser-src/src packages/rpp-parser/
cp -r /tmp/rpp-parser-src/tests packages/rpp-parser/
# Update the commit SHA above
# Run: pnpm --filter @runcor/rpp-parser test
```

DO NOT modify `src/` files in this package directly — keep them
upstream-pure so re-sync is trivial.
