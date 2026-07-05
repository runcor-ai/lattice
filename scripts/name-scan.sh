#!/usr/bin/env bash
#
# name-scan.sh — pre-push safety gate for the PUBLIC repo (runcor-ai/lattice).
#
# Two independent checks over the commits being pushed:
#   1. IDENTITY ALLOWLIST — every commit's author AND committer email must
#      equal the single allowed publishing identity. Any other identity is
#      rejected. (Allowlist by design: we never enumerate forbidden
#      addresses, so no private address is ever written into this repo.)
#   2. CONTENT SCAN — the added diff must not contain any blocklisted token
#      (internal codenames, employer references, personal handle, key
#      prefixes).
#
# Modes:
#   - Hook mode (default): invoked by .git/hooks/pre-push. Git passes the
#     remote name + URL as $1 $2 and feeds ref updates on stdin as
#     "<local ref> <local oid> <remote ref> <remote oid>". Each updated ref
#     is scanned over the range (remote oid)..(local oid); a brand-new ref
#     (remote oid all-zero) scans the full history reachable from local oid.
#   - Test mode: `name-scan.sh --range <gitrange>` scans an explicit range
#     and prints PASS/FAIL. Used by the self-test; safe to run by hand.
#
# Exit 0 = clean (allow push). Exit non-zero = a check failed (block push).

set -uo pipefail

ALLOWED_EMAIL="hello@runcor.ai"
ZERO="0000000000000000000000000000000000000000"

# Blocklisted content patterns (extended regex, case-insensitive).
# Each sensitive token carries a one-character [bracket] class so this file
# never contains the literal token contiguously. That keeps the scanner from
# (a) matching itself, (b) being clobbered by a history-rewrite replace pass,
# and (c) showing up as a hit in a plain grep for the token — while the regex
# still matches the real token in scanned diffs. Word boundaries guard short
# tokens so ordinary words don't trip the gate.
CONTENT_PATTERNS='abc[-]port|data[-]abc|Government of Albert[a]|\bGo[A]\b|albert[a]\.ca|go[v]\.ab\.ca|\bjsun[d]\b|sk[-]ant|gh[p]_|github[_]pat_'

fail=0

scan_range() {
  # $1 = git revision range (e.g. "A..B") or a single rev (full history)
  local range="$1"
  [ -z "$range" ] && return 0

  # ---- Check 1: identity allowlist ----
  # List author+committer email for every commit in the range.
  local bad_ids
  bad_ids="$(git log --no-color --format='%H%x09%ae%x09%ce' "$range" 2>/dev/null \
    | awk -F'\t' -v ok="$ALLOWED_EMAIL" '$2 != ok || $3 != ok {print "  " $1 "  author=" $2 "  committer=" $3}')"
  if [ -n "$bad_ids" ]; then
    echo "IDENTITY CHECK FAILED — commits with a non-allowed identity (must be $ALLOWED_EMAIL):" >&2
    echo "$bad_ids" >&2
    fail=1
  fi

  # ---- Check 2: content scan of the added diff ----
  local hits
  hits="$(git log -p --no-color "$range" 2>/dev/null \
    | grep -E '^\+' \
    | grep -inE "$CONTENT_PATTERNS")"
  if [ -n "$hits" ]; then
    echo "CONTENT SCAN FAILED — blocklisted token(s) in added lines over $range:" >&2
    echo "$hits" | sed 's/^/  /' >&2
    fail=1
  fi
}

if [ "${1:-}" = "--range" ]; then
  # Test mode.
  scan_range "${2:-}"
else
  # Hook mode: read ref updates from stdin.
  while read -r _local_ref local_oid _remote_ref remote_oid; do
    [ -z "${local_oid:-}" ] && continue
    [ "$local_oid" = "$ZERO" ] && continue          # deleting a ref — nothing to scan
    if [ "${remote_oid:-$ZERO}" = "$ZERO" ]; then
      scan_range "$local_oid"                        # new ref: scan full reachable history
    else
      scan_range "${remote_oid}..${local_oid}"       # update: scan only new commits
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "PUSH BLOCKED by scripts/name-scan.sh. Fix the above before pushing." >&2
  exit 1
fi
echo "name-scan: OK (identity + content clean)."
exit 0
