# acorn — Heartbeat

> Cadence for acorn's self-checks and the deterministic RSI loop. acorn is a tool-employee, not an
> earning/scanning agent — the heartbeat is about **keeping the brain current and the evals green**, not
> scanning a marketplace. The nightly loop runs via `rsi.yml`'s `schedule:` (`dsip.json` is the contract).

## Schedule

| Check                       | Frequency             | Action on anomaly                                                  |
| --------------------------- | --------------------- | ----------------------------------------------------------------- |
| Tool-matrix currency probe  | Nightly (RSI loop)    | A version-gate moved (Supabase PG major, pgvector, Prisma 7, PG18 `uuidv7`) → write a proposed diff to update `brain/TOOL-MATRIX.md` |
| Eval-pyramid health         | Nightly + on every PR | Re-run G1–G15; any regression → snap back (git) on the offending component/repo |
| RLS-coverage drift          | Nightly (RSI loop)    | Re-lint the house schema; coverage drop → flag + propose the missing policy |
| Brain freshness             | Nightly (RSI loop)    | A cited source changed → flag the stale brain claim |

## Health indicators

- **Healthy:** `python eval/eval.py --l1-only` exits 0; the acceptance CI job (`acceptance.yml`) green;
  no open version-gate regression.
- **Warning:** a version-gate moved (a changelog diff fired) but evals still pass — a proposed diff is
  waiting for review.
- **Critical:** an eval regression in the CI-blocking subset → the RSI loop snaps back to the last green
  commit (component or repo granularity) and records the regression.

## Recovery

1. Read the last eval verdict + proposed diff from the RSI run (`workflows/rsi.workflow.js --dry-run`
   output / `logs/runs.jsonl`).
2. Check `memory/LEARNINGS.md` + `brain/KNOWN-PITFALLS.md` for a known fix.
3. If fixable deterministically: apply, re-run the eval pyramid, commit (eval-gated).
4. If it needs the Claude half (`CLAUDE_CODE_OAUTH_TOKEN` set): refresh the affected brain artifact, draft
   the lint/skill, re-run — always eval-gated, never self-grading.
