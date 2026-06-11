#!/bin/bash
# brain-search.sh — BM25-style search over acorn's expertise brain (brain/*.md).
# Usage: ./scripts/brain-search.sh "query" [--limit N] [--verbose]
#
# The Memory component backing (PLAN §3 · HARNESS-OVERRIDES §2): the queryable layer indexes the
# EXPERTISE BRAIN, not code history. This is the $0/tokenless shell twin of src/brain/search.ts — same
# scoring philosophy as the inherited scripts/memory-search.sh (term-frequency × source-weight), corpus
# pointed at brain/. The `acorn brain search` CLI verb (B2) is the canonical entry; this script lets the
# cockpit/hooks/RSI loop query the brain without a TS build.
#
# Canonical probe: ./scripts/brain-search.sh "filtered ANN over-filter"
#   → surfaces brain/BATTLE-TESTED-SCENARIOS.md (Scenario #9, golden task G10).

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN_DIR="$PROJECT_DIR/brain"

QUERY=""
LIMIT=5
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)   LIMIT="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --help|-h)
      echo "Usage: brain-search.sh \"query\" [--limit N] [--verbose]"
      echo ""
      echo "Searches acorn's expertise brain (brain/*.md):"
      echo "  OPINIONS · KNOWN-PITFALLS · BATTLE-TESTED-SCENARIOS · EXPERTISE-MAP · TOOL-MATRIX · GAPS · MOC"
      echo ""
      echo "Options:"
      echo "  --limit N    Return top N results (default: 5)"
      echo "  --verbose    Show scoring details"
      exit 0
      ;;
    *) QUERY="$1"; shift ;;
  esac
done

if [ -z "$QUERY" ]; then
  echo "Error: No query provided"
  echo "Usage: brain-search.sh \"query\" [--limit N] [--verbose]"
  exit 1
fi

IFS=' ' read -ra TERMS <<< "$QUERY"

RESULTS_FILE=$(mktemp)
trap "rm -f $RESULTS_FILE" EXIT

# Source weight map — load-bearing brain artifacts rank above org/MOC scaffolding
# (mirrors src/brain/search.ts sourceWeight()).
weight_for_source() {
  case "$(basename "$1")" in
    OPINIONS.md)                 echo 5 ;;
    KNOWN-PITFALLS.md)           echo 5 ;;
    BATTLE-TESTED-SCENARIOS.md)  echo 5 ;;
    EXPERTISE-MAP.md)            echo 4 ;;
    TOOL-MATRIX.md)              echo 4 ;;
    GAPS-AND-DISPUTES.md)        echo 4 ;;
    "MOC - acorn.md")            echo 2 ;;
    *)                           echo 1 ;;
  esac
}

# Term-frequency score: count case-insensitive matches across all query terms.
score_file() {
  local file="$1" total=0 hits
  for term in "${TERMS[@]}"; do
    hits=$(grep -ci -- "$term" "$file" 2>/dev/null | tr -d '[:space:]' || true)
    hits=${hits:-0}; [ -z "$hits" ] && hits=0
    total=$((total + hits))
  done
  echo "$total"
}

# Context around the best-matching line.
extract_context() {
  local file="$1" best_line=0 best=0
  while IFS= read -r line_data; do
    local ln="${line_data%%:*}" content="${line_data#*:}" s=0
    for term in "${TERMS[@]}"; do
      echo "$content" | grep -qi -- "$term" 2>/dev/null && s=$((s + 1))
    done
    if [ "$s" -gt "$best" ]; then best=$s; best_line=$ln; fi
  done < <(grep -ni -- "${TERMS[0]}" "$file" 2>/dev/null | head -20)
  if [ "$best_line" -gt 0 ]; then
    local start=$((best_line - 1)); [ "$start" -lt 1 ] && start=1
    sed -n "${start},$((best_line + 1))p" "$file" 2>/dev/null
  fi
}

FILES=()
for f in "$BRAIN_DIR"/*.md; do
  [ -f "$f" ] && FILES+=("$f")
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No brain corpus found at $BRAIN_DIR"
  exit 0
fi

for file in "${FILES[@]}"; do
  tf=$(score_file "$file")
  [ "$tf" -eq 0 ] && continue
  sw=$(weight_for_source "$file")
  combined=$((tf * sw))
  rel="${file#$PROJECT_DIR/}"
  echo "$combined|$rel|$tf|$sw" >> "$RESULTS_FILE"
done

if [ ! -s "$RESULTS_FILE" ]; then
  echo "No brain hits for: $QUERY"
  exit 0
fi

echo "=== brain search: \"$QUERY\" ==="
echo ""

RANK=0
sort -t'|' -k1 -nr "$RESULTS_FILE" | head -"$LIMIT" | while IFS='|' read -r score path tf sw; do
  RANK=$((RANK + 1))
  echo "[$RANK] $path (score: $score)"
  [ "$VERBOSE" = true ] && echo "    term_freq=$tf  source_wt=$sw"
  ctx=$(extract_context "$PROJECT_DIR/$path")
  if [ -n "$ctx" ]; then
    echo "    ---"
    echo "$ctx" | sed 's/^/    /'
    echo "    ---"
  fi
  echo ""
done

TOTAL=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
echo "Found $TOTAL matching brain files. Showing top $LIMIT."
