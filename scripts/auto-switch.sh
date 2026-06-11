#!/bin/bash
# Energy Platform — Auto Chat-Switch Wrapper
# Chairman Directive #19: Auto-create new chats when context degrades
#
# This script wraps Claude Code in a session loop. When Claude exits
# (due to context degradation, rate limits, or completion), it captures
# the session state and starts a fresh session with full context injection.
#
# Usage:
#   ./scripts/auto-switch.sh              # Interactive mode (daytime)
#   ./scripts/auto-switch.sh --overnight  # Autonomous overnight mode
#   ./scripts/auto-switch.sh --dry-run    # Show what would happen
#
# The key innovation: last-session-output.md captures the final state
# and gets injected into the next session's context via /start.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/.claude/overnight-logs"
SIGNAL_FILE="/tmp/claude-session-signal"
LAST_OUTPUT_FILE="$PROJECT_DIR/.claude/last-session-output.md"
HANDOFF_FILE="$PROJECT_DIR/.claude/handoff.md"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
LOG_FILE="$LOG_DIR/auto-switch-$TIMESTAMP.log"
MAX_SESSIONS=20
SESSION_COUNT=0
MODE="${1:---interactive}"

log() {
  local msg="[$(date '+%H:%M:%S')] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

# Clean up signal files from previous runs
cleanup() {
  rm -f "$SIGNAL_FILE"
  rm -f "/tmp/claude-compact-session-count"
}

# Build the resume prompt for a fresh session
build_resume_prompt() {
  local prompt="/start"
  prompt+=$'\n\n'

  # Inject last session's final output if it exists
  if [ -f "$LAST_OUTPUT_FILE" ]; then
    prompt+="## Last Session Final State"
    prompt+=$'\n'
    prompt+="$(cat "$LAST_OUTPUT_FILE")"
    prompt+=$'\n\n'
  fi

  # Add handoff context
  if [ -f "$HANDOFF_FILE" ]; then
    local handoff_age
    handoff_age=$(( ($(date +%s) - $(stat -f %m "$HANDOFF_FILE" 2>/dev/null || stat -c %Y "$HANDOFF_FILE" 2>/dev/null || echo 0)) / 60 ))
    if [ "$handoff_age" -lt 30 ]; then
      prompt+="Handoff doc was written ${handoff_age}m ago. Resume from it."
      prompt+=$'\n'
    fi
  fi

  # Memory context injection — persist across chat migrations
  prompt+=$'\n'
  prompt+="## Memory System"
  prompt+=$'\n'
  prompt+="Memory MCP servers are enabled: memory, memory-enhanced (59 tools, semantic search), mem0."
  prompt+=$'\n'
  prompt+="Run /memory search with mission keywords BEFORE starting any work."
  prompt+=$'\n'
  prompt+="Use create_entities to store critical facts that MUST survive across chats."
  prompt+=$'\n'
  prompt+="The MCP knowledge graph persists between sessions — use it."
  prompt+=$'\n\n'

  # Mode-specific instructions
  if [ "$MODE" = "--overnight" ]; then
    prompt+=$'\n'
    prompt+="Resume autonomous overnight work. Chairman is sleeping."
    prompt+=$'\n'
    prompt+="Read .claude/handoff.md for exact state. Continue from where we left off."
    prompt+=$'\n'
    prompt+="Run /ceo-launch and paste: 'Continue from handoff. Read .claude/handoff.md.'"
    prompt+=$'\n'
    prompt+="If context compaction hits, write handoff and exit, write handoff and exit cleanly."
    prompt+=$'\n'
    prompt+="Work autonomously — use agent teams, sub-agents, skills, MCPs, full force."
    prompt+=$'\n'
    prompt+="AUTOCOMPACT at 60% (research: quality degrades at 40-50% of 1M). Hard stop at 1 compaction — migrate immediately."
  else
    prompt+=$'\n'
    prompt+="Auto-switched from previous session due to context degradation."
    prompt+=$'\n'
    prompt+="Read .claude/handoff.md for exact state. Resume from where we left off."
    prompt+=$'\n'
    prompt+="All context has been persisted to: handoff.md, daily log, anchor-state.md, LEARNINGS.md."
    prompt+=$'\n'
    prompt+="AUTOCOMPACT at 60% (research: quality degrades at 40-50% of 1M). Hard stop at 1 compaction — migrate immediately."
  fi

  echo "$prompt"
}

# Detect why Claude exited
detect_exit_reason() {
  local session_log="$1"
  local exit_code="$2"

  # Check signal file from pre-compact hook
  if [ -f "$SIGNAL_FILE" ]; then
    local signal
    signal=$(cat "$SIGNAL_FILE")
    rm -f "$SIGNAL_FILE"
    echo "$signal"
    return
  fi

  # Check for rate limit in output
  if grep -qi "hit your limit\|rate limit\|usage limit\|token limit" "$session_log" 2>/dev/null; then
    echo "rate-limited"
    return
  fi

  # Check for handoff written (clean exit)
  if grep -qi "handoff written\|starting new chat\|context compacted" "$session_log" 2>/dev/null; then
    echo "context-degraded"
    return
  fi

  # Crash
  if [ "$exit_code" -ne 0 ]; then
    echo "crash:$exit_code"
    return
  fi

  echo "normal"
}

# Parse rate limit wait time
parse_rate_limit_wait() {
  local output_file="$1"
  if grep -qi "hit your limit\|rate limit\|usage limit\|token limit" "$output_file" 2>/dev/null; then
    local reset_hour
    reset_hour=$(grep -oi 'resets\s*\(at\s*\)\?[0-9]\+\s*[ap]m' "$output_file" | grep -oi '[0-9]\+\s*[ap]m' | head -1)
    if [ -n "$reset_hour" ]; then
      local hour ampm now_epoch target
      hour=$(echo "$reset_hour" | grep -o '[0-9]\+')
      ampm=$(echo "$reset_hour" | grep -oi '[ap]m')
      if [[ "$ampm" == "pm" || "$ampm" == "PM" ]] && [ "$hour" -ne 12 ]; then
        hour=$((hour + 12))
      elif [[ "$ampm" == "am" || "$ampm" == "AM" ]] && [ "$hour" -eq 12 ]; then
        hour=0
      fi
      now_epoch=$(date +%s)
      target=$(date -v"${hour}H" -v0M -v0S +%s 2>/dev/null || date -d "today ${hour}:00" +%s 2>/dev/null)
      if [ "$target" -le "$now_epoch" ]; then
        target=$((target + 86400))
      fi
      echo $((target - now_epoch))
      return
    fi
    echo "3600"
    return
  fi
  echo "0"
}

# ============ Main Loop ============

log "=== Energy Auto-Switch Started (mode: $MODE) ==="
log "Project: $PROJECT_DIR"
log "Log: $LOG_FILE"

if [ "$MODE" = "--dry-run" ]; then
  log "DRY RUN — would start Claude Code in session loop"
  PROMPT=$(build_resume_prompt)
  log "Resume prompt:"
  log "$PROMPT"
  exit 0
fi

cleanup

while [ $SESSION_COUNT -lt $MAX_SESSIONS ]; do
  SESSION_COUNT=$((SESSION_COUNT + 1))
  SESSION_LOG="$LOG_DIR/session-${SESSION_COUNT}-$(date +%H%M%S).log"

  log "--- Session $SESSION_COUNT / $MAX_SESSIONS ---"

  PROMPT=$(build_resume_prompt)

  log "Starting Claude Code session..."

  set +e
  if [ "$MODE" = "--overnight" ]; then
    # Non-interactive: use -p (print mode)
    claude -p "$PROMPT" \
      --permission-mode bypassPermissions \
      --model opus \
      --effort max \
      2>&1 | tee "$SESSION_LOG"
  else
    # Interactive: use --resume or --continue for seamless experience
    # First session uses the prompt, subsequent use --continue
    if [ "$SESSION_COUNT" -eq 1 ]; then
      claude -p "$PROMPT" \
        --model opus \
        --effort max \
        2>&1 | tee "$SESSION_LOG"
    else
      claude -p "$PROMPT" \
        --model opus \
        --effort max \
        2>&1 | tee "$SESSION_LOG"
    fi
  fi
  EXIT_CODE=$?
  set -e

  log "Session $SESSION_COUNT exited with code $EXIT_CODE"

  # Detect exit reason
  REASON=$(detect_exit_reason "$SESSION_LOG" "$EXIT_CODE")
  log "Exit reason: $REASON"

  case "$REASON" in
    "context-degraded")
      log "Context degraded — starting fresh session with full context..."
      # Reset compaction counter for new session
      rm -f "/tmp/claude-compact-session-count"
      sleep 3
      continue
      ;;

    "rate-limited")
      WAIT_SECS=$(parse_rate_limit_wait "$SESSION_LOG")
      WAIT_MINS=$((WAIT_SECS / 60))
      log "RATE LIMITED — waiting ${WAIT_MINS} minutes..."
      sleep "$WAIT_SECS"
      sleep 60  # Buffer
      log "Rate limit reset. Resuming..."
      continue
      ;;

    crash:*)
      log "Unexpected crash — waiting 30s before retry..."
      sleep 30
      continue
      ;;

    "normal")
      # Check for active task
      if [ -f "$PROJECT_DIR/.claude/active-task.md" ]; then
        if grep -q "status: done" "$PROJECT_DIR/.claude/active-task.md"; then
          log "Active task complete. Stopping."
          break
        else
          log "Active task still in progress. Starting next session..."
          sleep 5
          continue
        fi
      fi
      log "Session completed normally. No active task. Stopping."
      break
      ;;

    *)
      log "Unknown exit reason: $REASON. Stopping."
      break
      ;;
  esac
done

log "=== Auto-Switch Finished ==="
log "Total sessions: $SESSION_COUNT"
log "Log: $LOG_FILE"
