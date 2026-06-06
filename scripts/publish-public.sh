#!/usr/bin/env bash
#
# publish-public.sh — mirror the monorepo's `main` to the PUBLIC repo
# (origin `public` → runcor-ai/lattice) as a single clean commit.
#
# The public repo is a curated, squashed snapshot — its history does NOT
# share a base with the monorepo, and published commits carry NO AI
# co-authorship trailer. This script reproduces that: it publishes the
# exact tree of `main` as one commit parented on the current public tip,
# with a clean message. Content is identical to `main` (verified: the
# private dirs — abc-port/, data*/ — are gitignored and never in `main`).
#
# Usage:
#   scripts/publish-public.sh ["commit message"]
#
# Preconditions: a `public` git remote, and `main` is the branch to mirror.
set -euo pipefail

if ! git remote get-url public >/dev/null 2>&1; then
  echo "error: no 'public' git remote. Add it with:" >&2
  echo "  git remote add public https://github.com/runcor-ai/lattice.git" >&2
  exit 1
fi

MSG="${1:-Runcor Lattice — sync from monorepo main}"

git fetch public --quiet

TREE="$(git rev-parse main^{tree})"
PARENT="$(git rev-parse public/main)"

# Nothing to do if the public tip already has main's exact tree.
if [ "$(git rev-parse "${PARENT}^{tree}")" = "$TREE" ]; then
  echo "public/main is already in sync with main — nothing to publish."
  exit 0
fi

# commit-tree makes a commit object with main's tree and a clean message —
# no Co-Authored-By, no monorepo history. Fast-forwards public/main.
COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")"

# Safety: the new commit must carry main's exact tree.
if [ "$(git rev-parse "${COMMIT}^{tree}")" != "$TREE" ]; then
  echo "error: composed commit tree != main tree; aborting." >&2
  exit 1
fi

git push public "${COMMIT}:main"
echo "published ${COMMIT} to public/main (tree == main)."
