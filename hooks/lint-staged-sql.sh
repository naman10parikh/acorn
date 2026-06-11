#!/usr/bin/env bash
# acorn hook · lint-staged-sql (CP123 B4)
# Brain source: brain/EXPERTISE-MAP.md §3d ("automate it in the harness — acorn IS that automation")
#               · brain/KNOWN-PITFALLS.md §Migrations P10-P15 · brain/OPINIONS.md §Migrations.
#
# WHAT IT DOES: runs `acorn migration lint` on every staged *.sql file (the 5 outage-makers: bare
# CHECK/NOT NULL/FK, ALTER TYPE on a big table, CREATE INDEX w/o CONCURRENTLY, bare RENAME/DROP, missing
# lock_timeout). Intended as a pre-commit entrypoint AND as the lint half of acorn's house-rule automation.
#   exit 0  → all staged SQL lints clean (or none staged)
#   exit 1  → at least one staged migration trips an outage-maker (the violation is printed)
#
# USAGE
#   Pre-commit (real):   ./hooks/lint-staged-sql.sh            # lints `git diff --cached --name-only '*.sql'`
#   Standalone (test):   ./hooks/lint-staged-sql.sh path/to/file.sql [more.sql ...]   # lints the given files
set -euo pipefail

# --- locate the repo root + the acorn binary (portable: resolve relative to this script) ---
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd)"
acorn_bin="$repo_root/dist/index.js"

if [ ! -f "$acorn_bin" ]; then
  echo "acorn: hook skipped — $acorn_bin not built yet (run \`pnpm build\`)." >&2
  exit 0   # don't block a commit just because the CLI isn't built; the CI lint still gates
fi

# --- collect the SQL files to lint ---
files=()
if [ "$#" -gt 0 ]; then
  # explicit args → standalone test / manual invocation
  for f in "$@"; do
    [ -f "$f" ] && files+=("$f")
  done
else
  # pre-commit mode → staged *.sql (Added/Copied/Modified/Renamed)
  if command -v git >/dev/null 2>&1 && git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$repo_root/$f" ] && files+=("$repo_root/$f")
    done < <(git -C "$repo_root" diff --cached --name-only --diff-filter=ACMR -- '*.sql' 2>/dev/null || true)
  fi
fi

if [ "${#files[@]}" -eq 0 ]; then
  exit 0   # nothing to lint
fi

# --- lint each; aggregate the verdict ---
failed=0
for f in "${files[@]}"; do
  if ! node "$acorn_bin" migration lint "$f"; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "acorn: staged SQL has migration outage-makers (see above). Commit blocked." >&2
  echo "  Fix with: acorn migration safe <file.sql>  (auto-rewrites to NOT VALID/VALIDATE + lock_timeout + CONCURRENTLY)." >&2
  exit 1
fi
exit 0
