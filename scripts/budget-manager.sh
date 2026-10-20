#!/bin/bash
# Budget Manager — Adaptive Model Routing for Claude Code Max Plan
# Determines the optimal model tier based on weekly cycle position and usage warnings.
#
# Usage:
#   scripts/budget-manager.sh status        — show current tier and reasoning
#   scripts/budget-manager.sh env           — output env vars for current tier (for hooks)
#   scripts/budget-manager.sh warn <level>  — record a usage warning (75, 90, 95)
#   scripts/budget-manager.sh set <1-4>     — manual tier override
#   scripts/budget-manager.sh auto          — clear manual override, return to adaptive
#   scripts/budget-manager.sh reset         — new weekly cycle detected (clear warnings)
#   scripts/budget-manager.sh apply         — write env vars into settings.local.json

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude/budget-state.json"
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.local.json"

# --- Tier Definitions ---
# Tier 1: FULL POWER — Opus everywhere, max effort
# Tier 2: BALANCED   — opusplan (Opus plans, Sonnet executes), high effort, Sonnet subagents
# Tier 3: CONSERVE   — Sonnet main, high effort, Haiku subagents
# Tier 4: EMERGENCY  — Sonnet main, medium effort, Haiku subagents

tier_name() {
  case "$1" in
    1) echo "FULL POWER (CP123: Fable-5 1M main + Opus-4.8 1M subagents, max effort)" ;;
    2) echo "BALANCED (opusplan + high effort)" ;;
    3) echo "CONSERVE (Sonnet + high effort)" ;;
    4) echo "EMERGENCY (Sonnet + medium effort)" ;;
    *) echo "UNKNOWN" ;;
  esac
}

tier_env_model() {
  case "$1" in
    1) echo "claude-fable-5[1m]" ;; # CP123 (2026-06-10): tier-1 pinned to Fable 5 1M for the employee-fleet mission; revert to "opus" at CP123 close
    2) echo "opusplan" ;;
    3) echo "sonnet" ;;
    4) echo "sonnet" ;;
  esac
}

tier_env_effort() {
  case "$1" in
    1) echo "max" ;;
    2) echo "high" ;;
    3) echo "high" ;;
    4) echo "medium" ;;
  esac
}

tier_env_subagent() {
  case "$1" in
    1) echo "claude-opus-4-8[1m]" ;; # CP123: subagent default = Opus 4.8 1M (was "" inherit); revert at CP123 close
    2) echo "sonnet" ;; # Sonnet subagents
    3) echo "haiku" ;;  # Haiku subagents
    4) echo "haiku" ;;  # Haiku subagents
  esac
}

# --- State Management ---
read_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo '{"current_tier":2,"last_warning":null,"last_warning_ts":null,"cycle_start_estimate":null,"manual_override":null,"history":[]}' > "$STATE_FILE"
  fi
  cat "$STATE_FILE"
}

write_state() {
  local state="$1"
  echo "$state" | python3 -m json.tool > "$STATE_FILE" 2>/dev/null || echo "$state" > "$STATE_FILE"
}

get_field() {
  local state="$1" field="$2"
  echo "$state" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$field','') or '')" 2>/dev/null
}

# --- Cycle Position ---
# Estimates days into the weekly cycle. Uses cycle_start_estimate if set,
# otherwise uses Monday as default reset day.
days_into_cycle() {
  local state="$1"
  local cycle_start
  cycle_start=$(get_field "$state" "cycle_start_estimate")

  if [ -n "$cycle_start" ] && [ "$cycle_start" != "None" ] && [ "$cycle_start" != "null" ]; then
    local start_epoch now_epoch
    start_epoch=$(date -j -f "%Y-%m-%d" "$cycle_start" "+%s" 2>/dev/null || date -d "$cycle_start" "+%s" 2>/dev/null || echo "0")
    now_epoch=$(date "+%s")
    if [ "$start_epoch" -gt 0 ]; then
      echo $(( (now_epoch - start_epoch) / 86400 ))
      return
    fi
  fi

  # Weekly reset: Friday 1am PST. Calculate days since last Friday 1am.
  # Friday = dow 5. We measure from Friday 01:00 PST.
  local now_epoch dow hours_today
  now_epoch=$(date "+%s")
  dow=$(date "+%u") # 1=Mon ... 5=Fri ... 7=Sun
  hours_today=$(date "+%H")

  # Days since Friday: Fri=0, Sat=1, Sun=2, Mon=3, Tue=4, Wed=5, Thu=6
  local days_since_friday
  if [ "$dow" -ge 5 ]; then
    days_since_friday=$(( dow - 5 ))
  else
    days_since_friday=$(( dow + 2 ))
  fi
  # If it's Friday but before 1am, we're still in the previous cycle's day 6
  if [ "$dow" -eq 5 ] && [ "$hours_today" -lt 1 ]; then
    days_since_friday=6
  fi
  echo "$days_since_friday"
}

# --- Adaptive Tier Calculation ---
# The core logic: determines tier based on cycle position + warnings
calculate_tier() {
  local state="$1"
  local manual_override last_warning last_warning_ts day_in_cycle hours_since_warning

  manual_override=$(get_field "$state" "manual_override")
  last_warning=$(get_field "$state" "last_warning")
  last_warning_ts=$(get_field "$state" "last_warning_ts")
  day_in_cycle=$(days_into_cycle "$state")

  # Manual override takes precedence
  if [ -n "$manual_override" ] && [ "$manual_override" != "None" ] && [ "$manual_override" != "null" ]; then
    echo "$manual_override"
    return
  fi

  # If we have a recent warning, react to it
  if [ -n "$last_warning" ] && [ "$last_warning" != "None" ] && [ "$last_warning" != "null" ] && [ -n "$last_warning_ts" ] && [ "$last_warning_ts" != "None" ] && [ "$last_warning_ts" != "null" ]; then
    local warn_epoch now_epoch
    warn_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$last_warning_ts" "+%s" 2>/dev/null || date -d "$last_warning_ts" "+%s" 2>/dev/null || echo "0")
    now_epoch=$(date "+%s")
    hours_since_warning=$(( (now_epoch - warn_epoch) / 3600 ))

    case "$last_warning" in
      95)
        # 95% warning: emergency mode until cycle resets (~48h)
        if [ "$hours_since_warning" -lt 48 ]; then
          echo 4; return
        fi
        ;;
      90)
        # 90% warning: conserve for 72h, then allow upgrade
        if [ "$hours_since_warning" -lt 72 ]; then
          echo 4; return
        fi
        ;;
      75)
        # 75% warning: balanced conservation for 48h
        if [ "$hours_since_warning" -lt 24 ]; then
          echo 3; return
        elif [ "$hours_since_warning" -lt 48 ]; then
          # After 24h at tier 3, allow back to tier 2
          echo 2; return
        fi
        ;;
    esac
  fi

  # No active warnings — use day-based schedule
  # Weekly reset: Friday 1am PST. 7-day cycle starts Friday.
  # Goal: front-load Opus, conserve mid-week, surplus-burn before reset.
  #
  # Day 0-1 (Fri-Sat): Tier 1 — FULL POWER. Fresh budget, go hard.
  # Day 2-3 (Sun-Mon): Tier 2 — BALANCED. opusplan saves ~60-70%.
  # Day 4-5 (Tue-Wed): Tier 2 — BALANCED. Still productive.
  # Day 6   (Thu):     Tier 1 — SURPLUS BURN. Last day before reset,
  #                              burn remaining budget at full Opus.

  case "$day_in_cycle" in
    0|1)  echo 1 ;;  # Fri-Sat: Full power (fresh budget)
    2|3)  echo 2 ;;  # Sun-Mon: Balanced
    4|5)  echo 2 ;;  # Tue-Wed: Balanced
    6)    echo 1 ;;  # Thu: Surplus burn (last day before reset)
    *)    echo 2 ;;  # Fallback: balanced
  esac
}

# --- Apply to Settings ---
apply_to_settings() {
  local tier="$1"
  local model effort subagent

  model=$(tier_env_model "$tier")
  effort=$(tier_env_effort "$tier")
  subagent=$(tier_env_subagent "$tier")

  if [ ! -f "$SETTINGS_FILE" ]; then
    echo "ERROR: $SETTINGS_FILE not found"
    return 1
  fi

  # Use python3 to update the env section in settings.local.json
  python3 << PYEOF
import json

with open("$SETTINGS_FILE", "r") as f:
    settings = json.load(f)

env = settings.get("env", {})

# Never pin a model and never lower effort (chairman, 2026-09-22). Claude Code's default is the
# recommended frontier model and it upgrades itself; the ID this used to write froze every session.
# The budget tiers are disabled, so apply only cleans up.
env.pop("ANTHROPIC_MODEL", None)
env.pop("CLAUDE_CODE_SUBAGENT_MODEL", None)

settings["env"] = env

with open("$SETTINGS_FILE", "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print("Model left to the Claude Code default (no pin written); effort untouched.")
PYEOF
}

# --- Commands ---
cmd="${1:-status}"

case "$cmd" in
  status)
    state=$(read_state)
    tier=$(calculate_tier "$state")
    day=$(days_into_cycle "$state")
    warning=$(get_field "$state" "last_warning")
    override=$(get_field "$state" "manual_override")
    echo "=== Budget Manager Status ==="
    echo "Current tier: $tier — $(tier_name "$tier")"
    echo "Day in cycle: $day/7"
    echo "Last warning: ${warning:-none}"
    echo "Manual override: ${override:-none}"
    echo ""
    echo "Model:     $(tier_env_model "$tier")"
    echo "Effort:    $(tier_env_effort "$tier")"
    echo "Subagents: $(tier_env_subagent "$tier" || echo 'inherit')"
    ;;

  env)
    state=$(read_state)
    tier=$(calculate_tier "$state")
    model=$(tier_env_model "$tier")
    effort=$(tier_env_effort "$tier")
    subagent=$(tier_env_subagent "$tier")
    # Output as environment exports (for sourcing)
    echo "export ANTHROPIC_MODEL=$model"
    echo "export CLAUDE_CODE_EFFORT_LEVEL=$effort"
    if [ -n "$subagent" ]; then
      echo "export CLAUDE_CODE_SUBAGENT_MODEL=$subagent"
    fi
    echo "# Tier $tier: $(tier_name "$tier")"
    ;;

  warn)
    level="${2:-75}"
    state=$(read_state)
    now=$(date "+%Y-%m-%dT%H:%M:%S")
    # Update state
    new_state=$(echo "$state" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['last_warning'] = '$level'
d['last_warning_ts'] = '$now'
d['history'].append({'event': 'warning', 'level': '$level', 'ts': '$now'})
# Keep last 20 history entries
d['history'] = d['history'][-20:]
json.dump(d, sys.stdout)
")
    write_state "$new_state"
    tier=$(calculate_tier "$(read_state)")
    echo "Warning $level% recorded at $now"
    echo "New tier: $tier — $(tier_name "$tier")"
    ;;

  set)
    tier="${2:-2}"
    if [ "$tier" -lt 1 ] || [ "$tier" -gt 4 ]; then
      echo "ERROR: Tier must be 1-4"
      exit 1
    fi
    state=$(read_state)
    now=$(date "+%Y-%m-%dT%H:%M:%S")
    new_state=$(echo "$state" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['manual_override'] = $tier
d['history'].append({'event': 'manual_set', 'tier': $tier, 'ts': '$now'})
d['history'] = d['history'][-20:]
json.dump(d, sys.stdout)
")
    write_state "$new_state"
    echo "Manual override set to tier $tier — $(tier_name "$tier")"
    echo "Run 'scripts/budget-manager.sh auto' to return to adaptive mode."
    ;;

  auto)
    state=$(read_state)
    now=$(date "+%Y-%m-%dT%H:%M:%S")
    new_state=$(echo "$state" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['manual_override'] = None
d['history'].append({'event': 'auto_mode', 'ts': '$now'})
d['history'] = d['history'][-20:]
json.dump(d, sys.stdout)
")
    write_state "$new_state"
    tier=$(calculate_tier "$(read_state)")
    echo "Returned to adaptive mode. Current tier: $tier — $(tier_name "$tier")"
    ;;

  reset)
    now=$(date "+%Y-%m-%d")
    new_state=$(python3 -c "
import json, sys
d = {
    'current_tier': 1,
    'last_warning': None,
    'last_warning_ts': None,
    'cycle_start_estimate': '$now',
    'manual_override': None,
    'history': [{'event': 'cycle_reset', 'ts': '$now'}]
}
json.dump(d, sys.stdout)
")
    write_state "$new_state"
    echo "Budget cycle reset. Start date: $now. Tier 1 — FULL POWER."
    ;;

  apply)
    state=$(read_state)
    tier=$(calculate_tier "$state")
    apply_to_settings "$tier"
    # Also update the current_tier in state
    new_state=$(echo "$state" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d['current_tier'] = $tier
json.dump(d, sys.stdout)
")
    write_state "$new_state"
    ;;

  *)
    echo "Usage: budget-manager.sh {status|env|warn <75|90|95>|set <1-4>|auto|reset|apply}"
    exit 1
    ;;
esac
