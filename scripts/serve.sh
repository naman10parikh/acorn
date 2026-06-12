#!/usr/bin/env bash
# acorn cockpit launcher (G1 · COCKPIT component · PLAN §10 · D3).
# Localhost stdlib Node http server — the chairman's read-mostly view. Never exposed.
#
#   bash scripts/serve.sh                 →  http://localhost:7779
#   ACORN_WEB_PORT=8080 bash scripts/serve.sh
#
# The cockpit shells out to the built `acorn` CLI + eval/eval.py for live data, so this
# ensures dist/ exists first (builds once if missing). Zero web dependencies — node:http only.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Build the CLI if dist/index.js is missing (the cockpit's brain-search / ask / doctor views need it).
if [ ! -f "dist/index.js" ]; then
  echo "acorn cockpit: dist/ missing — building once (pnpm build)…" >&2
  if command -v pnpm >/dev/null 2>&1; then
    pnpm build >&2
  else
    npx --yes tsc >&2
  fi
fi

exec node cockpit/server.mjs
