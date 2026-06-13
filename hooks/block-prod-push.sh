#!/usr/bin/env bash
# acorn hook · block-prod-push (CP123 B4)
# Brain source: brain/OPINIONS.md §Migrations · brain/BATTLE-TESTED-SCENARIOS.md #5 (drizzle-kit push → DROP+ADD data loss)
#               · brain/KNOWN-PITFALLS.md P20.
#
# WHAT IT DOES (PreToolUse · matcher Bash): refuses `drizzle-kit push` unless DATABASE_URL is an
# explicitly dev/branch/local URL. `push` auto-applies the schema diff and can silently turn a rename into
# DROP+ADD (data loss) — acorn's house rule is `generate` → review → `migrate`, and `push` ONLY against a
# throwaway dev/branch DB. Block-by-default: if we can't prove the target is dev/local, we refuse.
#
# CONTRACT (Claude Code PreToolUse): reads the tool-call JSON on stdin, inspects .tool_input.command.
#   exit 0  → allow the command
#   exit 2  → BLOCK (stderr is shown to the agent; Claude Code treats exit 2 on PreToolUse as a deny)
#
# STANDALONE TEST: echo '{"tool_input":{"command":"pnpm drizzle-kit push"}}' | DATABASE_URL=postgres://prod ./hooks/block-prod-push.sh ; echo $?
set -euo pipefail

# --- read the tool call (stdin JSON); degrade to empty if no stdin (e.g. manual run) ---
payload=""
if [ ! -t 0 ]; then
  payload="$(cat || true)"
fi

# Extract the bash command from .tool_input.command without requiring jq (portable; falls back to grep).
command_str=""
if [ -n "$payload" ]; then
  if command -v jq >/dev/null 2>&1; then
    command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
  fi
  if [ -z "$command_str" ]; then
    # jq absent or parse failed — fall back to a permissive scan of the raw payload.
    command_str="$payload"
  fi
fi
# Allow an explicit arg form too (so the hook is trivially testable: ./block-prod-push.sh "drizzle-kit push").
if [ -z "$command_str" ] && [ "${1:-}" != "" ]; then
  command_str="$*"
fi

# --- only care about `drizzle-kit push` (any whitespace / flags between) ---
if ! printf '%s' "$command_str" | grep -Eqi 'drizzle-kit[^|;&]*\bpush\b'; then
  exit 0   # not a push command — nothing to gate
fi

db_url="${DATABASE_URL:-}"

# --- is the target an explicitly dev / branch / local DB? (deterministic, no network) ---
# Safe signals (allow push):
#   - localhost / 127.0.0.1 / ::1 / *.local in the URL
#   - an explicit opt-in env: ACORN_DEV_DB or ACORN_ALLOW_PUSH set to a truthy value
#   - an UNAMBIGUOUS branch marker in the URL — a compound token a branch provider emits
#     (`-branch-`, `_branch_`, `/branch_`, or `acorn_branch`), NOT a bare `branch` substring.
# Block-by-default: when in doubt, refuse. A bare `branch` token used to be enough, but a plausible
# production URL (host `branch.acme-prod.com`, db-name `main_branch`) collided with it and was let through
# (adversary finding #2). So: (a) only the compound branch markers below count — a lone `branch` segment is
# no longer a safe signal, and (b) a `prod`/`production` marker ALWAYS wins and forces a block (see below).
is_safe=0
case "$db_url" in
  *localhost*|*127.0.0.1*|*'::1'*|*.local*|*.local:*) is_safe=1 ;;
esac
# Unambiguous branch markers only (compound delimiters), so `*-prod*` hosts/db-names don't match.
if printf '%s' "$db_url" | grep -Eqi '(-branch-|_branch_|/branch_|[/_-]acorn_branch([^a-z]|$))'; then
  is_safe=1
fi
case "${ACORN_DEV_DB:-}" in 1|true|TRUE|yes|YES) is_safe=1 ;; esac
case "${ACORN_ALLOW_PUSH:-}" in 1|true|TRUE|yes|YES) is_safe=1 ;; esac

# A production marker overrides every AUTO-detected safe signal (localhost/branch heuristics). The two
# explicit env opt-ins (ACORN_DEV_DB / ACORN_ALLOW_PUSH) remain the only deliberate way to push past a
# prod-looking URL — they are re-applied here so a deliberate override still wins, but an incidental
# `branch` token in a `*prod*` URL no longer does.
if printf '%s' "$db_url" | grep -Eqi '(^|[^a-z])(prod|production)([^a-z]|$)'; then
  is_safe=0
  case "${ACORN_DEV_DB:-}" in 1|true|TRUE|yes|YES) is_safe=1 ;; esac
  case "${ACORN_ALLOW_PUSH:-}" in 1|true|TRUE|yes|YES) is_safe=1 ;; esac
fi

if [ "$is_safe" -eq 1 ]; then
  exit 0   # dev/branch/local — push is allowed there
fi

# --- block ---
{
  echo "acorn: BLOCKED \`drizzle-kit push\`."
  if [ -z "$db_url" ]; then
    echo "  Reason: DATABASE_URL is unset, so the target cannot be proven to be a dev/branch DB."
  else
    echo "  Reason: DATABASE_URL does not look like a dev/branch/local DB — refusing to push against a shared/prod database."
  fi
  echo "  House rule (brain/OPINIONS.md §Migrations): never \`drizzle-kit push\` past dev — it can silently"
  echo "  turn a rename into DROP+ADD (data loss). Use: drizzle-kit generate → review → drizzle-kit migrate."
  echo "  To push against a throwaway dev/branch DB, point DATABASE_URL at localhost/a branch, or set ACORN_DEV_DB=1."
} >&2
exit 2
