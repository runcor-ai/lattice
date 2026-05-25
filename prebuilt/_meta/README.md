# Prebuilt lattices

Each subdirectory of `prebuilt/` is a ready-made role bundle. The
Bridge instantiates these via `POST /api/companies` (spec FR-053,
US13).

## Adding a new role

Drop three files into a new `prebuilt/<role>/` directory:

| File | Purpose |
|---|---|
| `seed-prompt.rpp` | R++ identity block — who this lattice IS in this role |
| `starting-knowledge.json` | Memories loaded at instantiation: identity rows + semantic rules |
| `defaults.json` | Dial defaults + starting `tool_manifest` |

That's it. The runtime does not change. The Bridge picks the new
role up the next time it reads the prebuilt directory.

## Schemas

See `packages/bridge-shared/src/bundle.ts` for `BundleDefaults` and
`StartingKnowledge` zod schemas. They validate at load time; an
invalid bundle is rejected before any lattice spawns.

## Current roles

- **`ceo`** — direction, attention allocation; high planStability, medium autonomy, depth-1 dialectic
- **`cfo`** — financial picture; risk-averse; low autonomy, depth-1 dialectic
- **`marketing`** — external voice; exploration-leaning
- **`sales`** — service role; peers may engage; listens to customers, reports back

## The lattice doesn't know it's "in a company"

Intent §19.1: a company is purely a Bridge-layer packaging
convenience. Each member is an ordinary lattice with its own
SQLite file, its own loop, and its own memory. The runtime never
sees the word "company". Adding a new role here is metadata only.
