# acorn — Heartbeat

> Cadence for acorn's self-checks and the deterministic RSI loop. acorn is a tool-employee, not an
> earning/scanning agent — the heartbeat is about **keeping the brain current and the evals green**, not
> scanning a marketplace. The nightly loop runs via `rsi.yml`'s `schedule:` (`dsip.json` is the contract).

## Schedule

| Check                       | Frequency             | Action on anomaly                                                  |
| --------------------------- | --------------------- | ----------------------------------------------------------------- |
| Tool-matrix currency probe  | Nightly, 09:00 UTC (RSI loop) | Report the version-gate snapshot (Supabase PG major, pgvector, Prisma 7, PG18 `uuidv7`); the live changelog diff waits for the Claude half |
| Eval-pyramid health         | Nightly (L1) + every push (full pyramid in `acceptance.yml`) | An L1 regression turns the nightly run red; a person snaps back (git) on the offending skill or employee change |
| RLS-coverage drift          | Nightly (RSI loop)    | Check that `acorn rls lint` runs; a failure → flag it in the proposal |
| Brain freshness             | Nightly (RSI loop)    | A brain artifact older than the newest version-gate event → name it in the proposal for re-verification |

## Health indicators

- **Healthy:** `python eval/eval.py --l1-only` exits 0; the acceptance CI job (`acceptance.yml`) green;
  no open version-gate regression.
- **Warning:** a version-gate moved (a changelog diff fired) but evals still pass — a proposed diff is
  waiting for review.
- **Critical:** an eval regression in the CI-blocking subset → the nightly run goes red and its proposal
  names the regression; a person snaps back to the last green commit with git. The loop never merges.

## Recovery

1. Read the last eval verdict + proposed diff from the RSI run (the `rsi-proposal` artifact, or
   `node workflows/rsi.workflow.js --dry-run` locally).
2. Check `memory/LEARNINGS.md` + `brain/KNOWN-PITFALLS.md` for a known fix.
3. If fixable deterministically: apply, re-run the eval pyramid, commit (eval-gated).
4. If it needs the Claude half (`CLAUDE_CODE_OAUTH_TOKEN` set): refresh the affected brain artifact, draft
   the lint/skill, re-run — always eval-gated, never self-grading.
