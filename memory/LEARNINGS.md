# acorn — LEARNINGS (append-only)

Every error → root cause → rule. Auto-compressed when >500 lines (memory-compress.sh).

## 2026-10-19 — the contract said what the schema could not read
**What broke:** `dsip.json` named the snapback granularity `component, repo`, which is outside Darwin's schema, so the contract did not say what the nightly loop really does.
**Rule:** write the contract in the schema's own words (granularity `skill, employee`, matching the `feat(skill)` and `feat(employee)` commit prefixes) and run `darwin-check` after any change to `dsip.json`.

## 2026-10-19 — a stranger's MCP config and the files a git install needs
**What broke:** the root `.mcp.json` started the server with a relative path and a `${DATABASE_URL}` reference, which fails for anyone outside this repository and for the plugin; and a git install would have shipped no `brain/`, so `acorn brain search` would find nothing.
**Rule:** the root `.mcp.json` holds only acorn's own server from GitHub (`npx -y -p github:naman10parikh/acorn acorn-mcp`) and servers that need no secret; the rest live in `.mcp.dev.json`. Every folder the code reads at runtime goes in `package.json` `files`, and a `prepare` script builds `dist/` on a git install.
