# Field Intelligence — Migration Disasters (full postmortems) + pgvector Field Reality

> Researcher: FIELD-INTELLIGENCE (acorn / Database harness, CP123 Wave-R). Captured 2026-06-11. Cited.
> The narrative postmortems behind the lock-taxonomy rules in `ecosystem-08`, plus what practitioners actually hit with pgvector.

---

## 1. POSTMORTEM: "The migration that locked production for 4 hours" (84M rows, 12.4M users, $52,400)
_Source: <https://medium.com/engineering-playbook/the-database-migration-that-locked-production-for-4-hours-complete-postmortem-1a4955f64b63> (Postmortem Files / Engineering Playbook, **2026-04**). This is the canonical narrative; it operationalizes `ecosystem-08`'s lock rules into a real incident with numbers._

**The exact command that caused it (verbatim):**
```sql
ALTER TABLE users ADD CONSTRAINT users_phone_number_check
CHECK (phone_number IS NOT NULL);
```
On an **84-million-row** `users` table.

**Impact (the numbers that make this quotable):**
- **4 hours 12 minutes** of lock (2:47 PM → 6:59 PM).
- **12.4 million users** could not log in; checkout API timed out on every request.
- Lock type: **`AccessExclusiveLock`**.
- **$47,200** estimated revenue loss; **$52,400** total cost (incl. support overtime + refunds).

**Why they couldn't escape it (the scary part):**
- `pg_cancel_backend()` and `pg_terminate_backend()` **both failed to stop the DDL** — the CHECK validation was mid-full-scan of 84M rows.
- "If we force-restart Postgres now, we'll corrupt the table." → They were **trapped**: can't cancel, can't kill, can't restart. They had to wait it out.

**Root cause (verbatim):**
1. **Staging-to-prod scale mismatch:** staging had **10,000 rows**, prod had **84 million** — an **"8,400x difference."** The migration "passed" in staging in milliseconds.
2. "When you add a CHECK constraint in Postgres, it **validates every single row**" — under AccessExclusive.
3. "No mechanism existed to timeout or cancel mid-operation" (they hadn't set `lock_timeout`/`statement_timeout`).

**The cruel irony for acorn to teach:** the *fix* is a tiny change — add `NOT VALID`, then `VALIDATE` separately (`ecosystem-08` §3a). `ALTER TABLE users ADD CONSTRAINT ... CHECK (...) NOT VALID;` skips the scan and takes a brief lock; `ALTER TABLE users VALIDATE CONSTRAINT ...;` scans under a **weaker (ShareUpdateExclusive)** lock that lets reads/writes continue. The exact same business outcome (a validated NOT-NULL CHECK) with **zero** outage. The team didn't know the two-step. **This is precisely the human-factor failure `ecosystem-08` §4 predicts: "a developer who writes migrations twice a month is unlikely to remember the NOT VALID + VALIDATE pattern every time" → automate it in the harness.** acorn IS that automation.

**Rules they adopted afterward (verbatim — adopt these as acorn lints):**
- **Core rule: "If a migration requires AccessExclusiveLock for more than 1 second, don't run it"** → break into smaller steps using lower-level locks.
- **Batch updates:** chunks of **50,000 rows with 0.5s delays** between batches (spares I/O, lets the lock queue drain).
- **Test at scale:** a new **"staging-large" with 50M rows**; any migration exceeding **5 seconds** gets rewritten.
- **Online DDL tools** (`pg-osc`, pgroll) for **100M+ row** migrations.
- **Expand-contract** for every schema change.
- **Result of the corrected approach:** the same migration took **42 minutes** with **"0 seconds" of table-lock**.

**acorn's takeaway:** the postmortem proves the `ecosystem-08` rules are not theoretical — they are the difference between 4h12m/$52K and 42min/$0. acorn's migration linter must (a) inject `lock_timeout`, (b) flag any AccessExclusive op, (c) rewrite `SET NOT NULL`/`ADD CONSTRAINT CHECK`/`ADD FK` into the NOT VALID/VALIDATE two-step, (d) refuse a bare `ALTER COLUMN TYPE`/`RENAME` on a non-trivial table.

---

## 2. The corroborating "5 mistakes" + "7 regrets" canon (2025-12, consistent across sources)
Multiple independent 2025-2026 posts converge on the SAME five outage-makers — strong signal this is settled practitioner consensus, not one blog's opinion:
- _<https://dev.to/mickelsamuel/the-5-postgresql-migration-mistakes-that-cause-production-outages-ngg>_
- _<https://www.techbuddies.io/2025/12/14/top-7-postgresql-migration-mistakes-developers-regret-later/> (2025-12-14)_
- _<https://dev.to/leena_malhotra/lessons-from-migrating-a-live-postgres-schema-without-downtime-338c>_

The five (cross-confirmed with `ecosystem-08` §6):
1. `NOT NULL` without the NOT VALID/VALIDATE two-step (← the 4-hour postmortem).
2. `ALTER COLUMN TYPE` on a big hot table (rewrite under AccessExclusive).
3. `CREATE INDEX` without `CONCURRENTLY`.
4. Bare `RENAME`/`DROP` that breaks the still-running old app version (skip expand/contract).
5. No `lock_timeout` → the lock request queues and freezes every query behind it.

**The lock-queue cascade (the mechanism every source stresses):** a *waiting* AccessExclusive lock **blocks every query that arrives behind it**, even cheap reads. So a migration that can't get its lock doesn't just wait — it **freezes the table for everyone** until it either gets the lock or times out. This is why `lock_timeout` (fail-fast) is non-negotiable: "it is better to fail and retry than to queue behind long-running queries and cascade into an outage."

---

## 3. pgvector FIELD REALITY: "the defaults are tuned for a demo, not your workload"
_Sources: <https://nerdleveltech.com/pgvector-hnsw-postgres-18-production-tuning-tutorial> (2026); <https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost> (Raouf Chebri, 2024-07-31); <https://jkatz05.com/post/postgres/pgvector-scalar-binary-quantization/> (Jonathan Katz, pgvector maintainer); <https://www.dbi-services.com/blog/pgvector-a-guide-for-dba-part-2-indexes-update-march-2026/> (2026-03)._

**The headline practitioner taste (verbatim):**
> "Most 'pgvector is slow' posts are wrong because **nobody tuned the parameters.** … the defaults are tuned for a demo, not your workload." — _nerdleveltech, 2026._

**The HNSW knobs that matter (and their defaults — the trap):**
- `hnsw.ef_search` default **40** → too low for good recall. "At 200 you'd expect high recall; at 800 you converge toward perfect recall." This is a **query-time** GUC — tune per-session, no rebuild.
- `m` default **16**, `ef_construction` default **64** → "balanced." Raising `m`→32 or `ef_construction`→128 "improves recall slightly but **doubles build time and memory** — only tune if you measured recall and found it lacking." These are **build-time** (rebuild to change).
- **acorn rule:** ship a recall-measurement step BEFORE tuning. Don't blindly crank `m`/`ef_construction` (doubles cost); first raise `ef_search` (free, query-time) and measure.

**HNSW vs IVFFlat (the index-choice taste):** _Source: <https://bigdataboutique.com/blog/hnsw-vs-ivfflat-how-to-choose-the-right-vector-index>._ HNSW = better recall/latency, higher build cost + memory, **can be built on an empty table** (incremental). IVFFlat = cheaper memory but **must be built AFTER data is loaded** (needs the data to cluster) and degrades as data drifts from the trained centroids. **Default to HNSW** for most RAG; IVFFlat only when memory-constrained and data is static.

**halfvec — the "free" 50% storage win (precise numbers):** _Source: Neon / Raouf Chebri, 2024-07-31._
- OpenAI `text-embedding-3-small` (1536-dim): `halfvec` = **3,076 bytes** vs `vector` = **6,148 bytes** → **exactly 50% storage reduction.**
- "**Equivalent query execution time and recall**" + "**23% faster index build**" + "**50% reduction in prewarming time**."
- Verdict (verbatim): "using SQ and the `halfvec` type over `vector` seems like an **obvious choice**" — but "test before migration, your results might depend on your dataset."
- **acorn rule:** for ≥1536-dim embeddings, **default to `halfvec`** (2-byte float) over `vector` (4-byte). Reserve `vector` for when you've measured a recall regression. **Binary quantization** (1-bit) is a further 32x storage cut BUT "a significant drop in recall on 1536-dim embeddings" that needs **re-ranking** to recover — use only with a re-rank stage.

**2025-2026 pgvector perf improvements (so old "pgvector can't scale" takes are stale):** parallel HNSW builds (**build time −30-50%** on multicore), scalar+binary quantization, SIMD → "**10×–150× speedups**" across releases since 0.6.0. _Source: pgvector README + instaclustr._ → Date-check any "pgvector is too slow for production" claim against the version (pre-0.6 vs 0.8.x).

**Cross-ref:** energy has **no pgvector anywhere yet** (`ecosystem-00` §C.6) — acorn is the DB expert that must own the embeddings-storage playbook. This file is the field-grounded version of that mandate.

---

## 4. A finding from the ABSENCE of recent issues: Drizzle's migration churn has SETTLED
Filtering `drizzle-team/drizzle-orm` top-commented issues to `createdAt >= 2025-01-01` returned **effectively none** in the top tier — all the high-comment pain (the enum/`push` #2389, the kit-version-churn #781, the `compositePrimaryKeys` crash #2344) is **2023-2024 vintage** (`ecosystem-10` §1). _Source: `gh search issues --repo drizzle-team/drizzle-orm --sort comments`, filtered, 2026-06-11._

**Interpretation (with the appropriate caution):** the *most-discussed* Drizzle breakage predates 2025, consistent with the tool maturing + the PlanetScale backing (2026-03). This does NOT mean Drizzle has no 2025+ issues — it means none reached the comment-volume of the early-churn era. **The "drizzle-kit is where you get bitten" rule (`ecosystem-10` §1) still holds as a precaution** (never `push` to prod; `generate`→review→`migrate`), but the acute instability appears to be behind it. _Flag: "issues settled" is an inference from comment-volume, not a guarantee of stability — see GAPS._

---

## 5. One-line takeaways for acorn
1. The 4-hour/$52K postmortem is the canonical proof: a `CHECK (col IS NOT NULL)` on 84M rows = AccessExclusive full-scan you **can't cancel or kill**. The fix is the one-line `NOT VALID`/`VALIDATE` split. acorn's linter must auto-apply it.
2. "If a migration needs AccessExclusive > 1 second, don't run it" — adopt verbatim as a lint threshold.
3. Test migrations at **prod scale** (50M-row staging), not 10K-row staging — the 8,400x gap is what hides the outage.
4. pgvector: "defaults are tuned for a demo." Ship a recall-measurement step; raise `ef_search` (free) before `m`/`ef_construction` (doubles cost).
5. Default `halfvec` for ≥1536-dim embeddings: exact 50% storage, 23% faster build, matching recall. Binary quant only with re-ranking.
6. Default HNSW over IVFFlat (HNSW builds on empty tables, better recall); pgvector "too slow" takes are version-stale (10-150x speedups since 0.6).
