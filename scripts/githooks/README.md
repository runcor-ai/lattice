# Git hooks (tracked)

This directory holds version-controlled git hooks so every contributor runs the
same checks. Git does **not** install hooks on clone, so each clone must opt in
once:

```bash
git config core.hooksPath scripts/githooks
```

That points git at this directory instead of `.git/hooks/`. Run it from the repo
root after cloning. To disable, run `git config --unset core.hooksPath`.

## Hooks

- **`pre-push`** — a thin wrapper that execs [`scripts/name-scan.sh`](../name-scan.sh),
  the pre-push safety gate. It runs two independent checks over the commits being
  pushed and blocks the push if either fails:
  1. **Identity allowlist** — every commit's author *and* committer email must be
     the project's single publishing identity (`hello@runcor.ai`). Any other
     identity is rejected. It is an allowlist by design, so no other address is
     ever named in the repo.
  2. **Content scan** — the added diff must not contain blocklisted tokens
     (internal codenames, personal identifiers, or credential/key prefixes). The
     exact patterns live in `scripts/name-scan.sh`, written so the scanner never
     contains the literal tokens it matches.

You can run the scanner by hand against any range without pushing:

```bash
scripts/name-scan.sh --range origin/main..HEAD
```

Exit `0` means clean; non-zero means a check failed (and prints what and where).
