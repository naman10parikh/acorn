---
title: "acorn Known Pitfalls — version-specific gotchas with detection + avoidance"
type: synthesis
created: "2026-06-11"
updated: "2026-06-11"
tags: [pitfalls, gotchas, rls, migrations, pooling, pgvector, orm, supabase, neon]
sources: ["brain/research/raw/field-01-rls-production-footguns.md", "brain/research/raw/field-02-migration-war-stories.md", "brain/research/raw/field-04-2026-invalidates-2025.md", "brain/research/raw/field-05-migration-disasters-and-pgvector-field-reality.md", "brain/research/raw/ecosystem-08-zero-downtime-migrations.md", "brain/research/raw/ecosystem-09-pgvector-embeddings.md", "brain/research/raw/ecosystem-10-github-issues-real-breakage.md", "brain/research/raw/ecosystem-12-agent-tooling-mcp-cli.md", "brain/research/raw/ecosystem-01-supabase.md", "brain/research/raw/ecosystem-00-internal-references.md"]
related: ["[[EXPERTISE-MAP]]", "[[BATTLE-TESTED-SCENARIOS]]", "[[OPINIONS]]", "[[GAPS-AND-DISPUTES]]", "[[TOOL-MATRIX]]"]
summary: "The gotcha list. Each pitfall has WHY it bites, HOW to detect it (the symptom/lint), and HOW to avoid it. Grouped by surface: RLS · Migrations/Locks · Pooling/Connections · ORM-tooling · pgvector · Provider/Platform · Currency."
---

# acorn Known Pitfalls

> Every entry: **why it bites · detect (symptom or lint) · avoid (the fix)**. Version-specific where it matters. These are the traps that "pass tests and leak/break in prod." The cross-cutting reason most of them ship: the **test-environment privilege/scale mismatch** — devs validate as a superuser on 10K rows, then ship to `anon` on 84M rows. _Source: `field-00`, `field-05` §1._

---

## §RLS — Row-Level Security (the highest-value, highest-loss surface)

### P1. RLS not enabled on a migration-created table → anon reads everything
- **Why:** RLS is **opt-in** for tables created via SQL migration (`supabase db push`). The 2025 "secure-by-default" change covers **dashboard-created tables only** — the migration path acorn uses is still wide open. The `anon` key ships in client JS by design; without RLS it's "a master key." → CVE-2025-48757, 170 apps. _Source: `field-01` §1, `field-04` §4._
- **Detect:** Supabase Security Advisor lint `0003`; an `anon`-role `SELECT` returns rows it shouldn't. The *dangerous* state is "RLS disabled," not "RLS enabled, no policy" (the latter fails closed).
- **Avoid:** Lint in CI that **every** `public.*` table has `ENABLE ROW LEVEL SECURITY`. Never trust the dashboard default for `db push`.

### P2. Testing RLS in the Supabase SQL Editor (the #1 debugging trap)
- **Why:** The SQL Editor runs as the `postgres` role → **bypasses ALL RLS**. Your policy "works" in the editor and over-exposes (or 403s) for real users. _Source: `field-01` §3 row 2._
- **Detect:** If your RLS "test" was run in the SQL Editor or as `service_role`, it proved nothing.
- **Avoid:** Test with `SET ROLE anon;` / `SET ROLE authenticated;` + `request.jwt.claims`, or via the client with a real user JWT. **acorn's eval pyramid runs RLS tests as the un-privileged role.**

### P3. `auth.uid()` unwrapped → per-row re-evaluation (5ms policy becomes 5s)
- **Why:** Bare `auth.uid()` (or `current_setting(...)`) is re-evaluated **per row**; on a 100K-row table that's the difference between a 5ms and a 5-second policy. _Source: `field-01` §3 row 4, `ecosystem-01` §3.4._ **energy does NOT wrap it** → degrades on big tables.
- **Detect:** `EXPLAIN ANALYZE` shows the auth function in the per-row filter, not as a cached `InitPlan`.
- **Avoid:** Wrap as `(select auth.uid())` so the planner runs it ONCE as a cached initPlan.

### P4. Missing index on the RLS predicate column → seq scan under the policy
- **Why:** A policy on `tenant_id` is only fast if `tenant_id` is indexed (">100x on large tables"). _Source: `field-01` §3 row 5._ (energy indexes `user_id` — correct.)
- **Detect:** `EXPLAIN` shows a Seq Scan with the policy predicate on a large table.
- **Avoid:** Index every column an RLS policy filters on; make it the first column of composite indexes.

### P5. `USING` without `WITH CHECK` (or vice-versa) → cross-tenant writes
- **Why:** `USING` filters *reads*; `WITH CHECK` validates *writes*. Omit `WITH CHECK` and a user can `INSERT`/`UPDATE` a row under **another** tenant's id (write rows they can't read, plant rows under another tenant). _Source: `field-01` §3 row 8._
- **Detect:** You only tested SELECT; no INSERT/UPDATE/DELETE policy exists.
- **Avoid:** Write BOTH clauses; test INSERT/UPDATE/DELETE as `authenticated`, not just SELECT.

### P6. Recursive RLS policy → runtime 500 (not a migrate-time error)
- **Why:** A policy that queries a table whose own policy references the first → Postgres detects infinite recursion **at runtime** → 500 for the user. Passes migrate (no static check). _Source: `field-01` §3 row 6._
- **Detect:** `infinite recursion detected in policy for relation ...` at query time.
- **Avoid:** A `SECURITY DEFINER` helper in a private schema (`private.user_orgs()`, `STABLE`) to break the cycle.

### P7. Clerk-on-Supabase RLS without the `::text` cast → silently denies everything
- **Why:** `auth.uid()` returns `uuid`; Clerk ids are non-uuid text. `auth.uid() = user_id` is a type mismatch → the policy never matches → denies all reads. _Source: `field-01` §4, `ecosystem-00` §B2 (confirmed in `002_agentdial.sql`)._
- **Detect:** A Clerk user reads 0 rows that should be theirs; the policy "looks right."
- **Avoid:** `(select auth.uid())::text = user_id` — or use Clerk's native Supabase integration and read `auth.jwt()->>'sub'`.

### P8. Explicit `service_role` policy = dead code that misleads reviewers
- **Why:** `service_role` already bypasses RLS, so a `for all using (auth.role()='service_role')` policy is a no-op that generates an advisor warning and can fool a reviewer into thinking the gate matters. _Source: `field-01` §3 row 7._ (It's still useful as *documentation of intent* — the issue is treating it as enforcement.)
- **Detect:** Advisor warns on a `service_role` policy.
- **Avoid:** Know it's documentation, not a gate; the real isolation is the per-tenant policy + RLS-on.

### P9. energy's `using(true)` "service role" policy has no role gate → RLS-off for anon too
- **Why:** energy's `001_user_memories.sql` uses `for all using (true) with check (true)` labelled "Service role full access" — but there's no `auth.role()` gate, so it's effectively **RLS-off for everyone including anon**. The agentdial tables correctly gate on `service_role`. _Source: `field-01` §4, `ecosystem-00` §B3._
- **Detect:** A permissive `using(true)` policy with no role condition on a table reachable by the anon/authenticated key.
- **Avoid:** Standardize on the gated form: a `service_role` policy + a per-tenant `(select auth.uid())::text = user_id` policy.

---

## §Migrations & Locks (second-most-expensive surface; energy has NO zero-downtime story)

### P10. `ADD CONSTRAINT CHECK` / `SET NOT NULL` / `ADD FK` validated immediately → AccessExclusive full scan
- **Why:** Validating against existing rows happens **under `AccessExclusiveLock`** (blocks all reads+writes). On 84M rows that's a 4h12m outage you **can't cancel or kill** (`pg_terminate_backend` fails mid-scan). _Source: `field-05` §1, `ecosystem-08` §2._
- **Detect:** The migration includes a bare `ADD CONSTRAINT ... CHECK`/`SET NOT NULL`/`ADD ... FOREIGN KEY` on a non-trivial table; staging is tiny so it "passes."
- **Avoid:** Two-step: `... NOT VALID;` (brief lock, no scan) then `VALIDATE CONSTRAINT` (weaker ShareUpdateExclusive). PG12+ then `SET NOT NULL` skips the scan. acorn's linter auto-applies this.

### P11. `ALTER COLUMN TYPE` on a big hot table → table rewrite under AccessExclusive
- **Why:** A type change rewrites the whole table under AccessExclusive — the classic outage maker. _Source: `ecosystem-08` §2,6._
- **Detect:** `ALTER TABLE ... ALTER COLUMN ... TYPE ...` in a migration.
- **Avoid:** Expand/contract: add a new column of the new type, dual-write, backfill in batches, swap, drop old. Never a bare in-place type change on a hot table.

### P12. `CREATE INDEX` without `CONCURRENTLY` → blocks writes for the build duration
- **Why:** Non-concurrent index build holds AccessExclusive for the whole build. _Source: `ecosystem-08` §2._
- **Detect:** `CREATE INDEX` (no `CONCURRENTLY`) on a large table.
- **Avoid:** `CREATE INDEX CONCURRENTLY`. **Caveat:** it can't run in a transaction block (trips some migration runners), and on failure leaves an **INVALID** index that must be `DROP`ped + retried. Managed providers may forbid it inside their runner.

### P13. Bare `RENAME`/`DROP` breaks the still-running old app version
- **Why:** During a rolling deploy, the old app instances still reference the old name → a bare rename/drop 500s them mid-deploy. _Source: `ecosystem-08` §2,6._
- **Detect:** A migration with `RENAME COLUMN`/`DROP COLUMN` shipped in the same release as the code that depends on it.
- **Avoid:** Expand→dual-write→backfill→contract; drop the old column a release *after* the code stops using it.

### P14. No `lock_timeout` → the migration's lock request freezes the whole table
- **Why:** A *waiting* AccessExclusive lock **blocks every query that arrives behind it**, even cheap reads, until it gets the lock. A migration queued behind one long query cascades into an outage. _Source: `field-05` §2, `ecosystem-08` §4._
- **Detect:** The migration has no `SET lock_timeout`.
- **Avoid:** `SET lock_timeout = '3s'` (+ sane `statement_timeout`) at the top of every migration — fail fast and retry, never queue. "Better to fail and retry than to queue behind long-running queries and cascade into an outage."

### P15. Staging-to-prod scale mismatch hides the outage
- **Why:** Staging 10K rows vs prod 84M (8,400x) → the migration "passes" in ms in staging and locks prod for hours. _Source: `field-05` §1._
- **Detect:** Your staging table count is orders of magnitude below prod.
- **Avoid:** A "staging-large" (~50M rows); any migration exceeding ~5s gets rewritten; online-DDL tools (`pg-osc`, pgroll) for 100M+ rows.

---

## §Pooling & Connections (the universal serverless breakage)

### P16. Transaction pooler × named prepared statements → `prepared statement "drizzle_s_1" already exists`
- **Why:** The transaction-mode pooler (`:6543`, `?pgbouncer=true`) **does not support named prepared statements**, but `postgres-js`/Drizzle/Prisma default to them. The single most common production breakage in the vertical. Also surfaces as `cached plan must not change result type` during seeds. _Source: `field-02` §1._
- **Detect:** A 502 + that exact error string on the first serverless request, or prepared-statement errors mid-seed (you're on the pooled URL).
- **Avoid:** `prepare:false` on the pooled client; **two connection strings always** — pooled `:6543` for the app, **direct `:5432` for migrations/seeds** (Prisma: `DATABASE_URL` + `directUrl`). Set it *before the first request*, not after the first 502.

### P17. RLS via session-GUC behind a SESSION-mode pooler → cross-tenant data leak
- **Why:** RLS that relies on `SET app.current_tenant = ...` (a *session* GUC) is safe only under **transaction-mode** pooling. Under **session-mode** (PgBouncer's default), the variable **persists across the pooled connection's reuse by a different tenant** → cross-tenant leak. _Source: `ecosystem-04` §3._
- **Detect:** You use a manual `SET app.tenant` for RLS behind a session-mode pooler.
- **Avoid:** Use `pool_mode = transaction` (Supabase port 6543) + **`SET LOCAL`** (txn-scoped, auto-resets at COMMIT), never plain `SET`. **Best on Supabase: JWT-claim tenancy** (`auth.uid()` from the request-scoped JWT — pooler-safe, no session GUC). energy avoids this footgun *because* it leans on Supabase-Auth JWTs, not a manual `SET`.

### P18. `Max client connections reached` under a spike (cap *clients*, not *server* connections)
- **Why:** Serverless opens a connection per invocation; a spike makes hundreds of Lambdas race past Supavisor's **client-connection cap (tied to compute size, not independently raisable)**. The failure is too many *clients*, not too few server connections. The official "increase compute" answer was downvoted 12×. _Source: `field-02` §3._
- **Detect:** `PostgresError: Max client connections reached` under load despite using the pooler; leaked Realtime channels.
- **Avoid:** `connection_limit=1` per Lambda (the pooler fans them in); transaction mode (6543); close Realtime channels; for >500 concurrent Realtime → custom limits/self-host/dedicated provider.

### P19. Port 5432 blocked by corporate/ISP firewall during `pg_dump`/connect
- **Why:** Many networks block outbound raw Postgres TCP (5432) → `AggregateError [ETIMEDOUT]: connect ETIMEDOUT ...:5432`. _Source: `field-02` §2, `ecosystem-12` §4._
- **Detect:** ETIMEDOUT on 5432 from CI/corp network.
- **Avoid:** Use the HTTP serverless driver (`@neondatabase/serverless`), `pg_dump` from an unrestricted network, or an MCP that tunnels.

---

## §ORM-tooling (the bite-zone is the migration/diff tool, not the runtime)

### P20. `drizzle-kit push` against a shared/prod DB → silent column drop / enum collision
- **Why:** `push` auto-applies the diff and can interpret a rename as **DROP+ADD (data loss)**; it also chokes re-creating an existing enum value (#2389, 86 comments). The runtime query layer is solid — **`drizzle-kit` is where teams get bitten.** _Source: `field-02` §6, `ecosystem-10` §1._
- **Detect:** `push` in a non-dev workflow; a generated migration with a `DROP COLUMN` where you meant a rename.
- **Avoid:** Never `push` past dev. `generate` → human/lint review → `migrate`. Use strict mode (prompts on ambiguous renames). Pin `drizzle-kit` (version churn historically broke generation, #781). Prefer **text+CHECK over native PG enums** (enum changes are migration pain; you can't easily drop/reorder a value).

### P21. Restoring a schema dump without the ORM migration ledger → re-runs everything and collides
- **Why:** After a schema restore, `__drizzle_migrations` / `_prisma_migrations` is **empty** → the ORM re-runs ALL migrations against an already-populated schema → `type "..." already exists`. The single most-missed step in cross-provider migrations. _Source: `field-02` §2, `ecosystem-12` §4._
- **Detect:** `DrizzleQueryError: type "X" already exists` (or Prisma equivalent) right after a restore + first deploy.
- **Avoid:** Backfill the ledger — insert the migration ids/hashes/timestamps so the ORM believes they already ran.

### P22. Prisma ≤6 Rust-engine download fails in CI/Docker/air-gapped (403)
- **Why:** Prisma's #1 most-discussed issue ever (**#27700, 401 comments**) is the Rust engine binary failing to download (CDN 403, checksum, air-gapped). _Source: `ecosystem-10` §2._
- **Detect:** "403 when trying to download prisma engine" in CI/Docker on Prisma ≤6.
- **Avoid:** **Upgrade to Prisma 7** (2025-11-19) — the Rust engine is gone, so this entire failure class disappears. (Also kills the bundle/edge/cold-start disadvantages.)

### P23. Prisma shadow-DB drift detection needs a second DB the agent can't create
- **Why:** `prisma migrate dev` uses a shadow database to detect drift; on managed providers where you can't freely create DBs, it fails. _Source: `ecosystem-05` §4._
- **Detect:** `migrate dev` errors that it can't create the shadow DB.
- **Avoid:** Use `prisma migrate diff` (shadow-less) for drift on managed providers.

---

## §pgvector (energy has none yet — acorn owns it)

### P24. pgvector defaults are tuned for a demo → "pgvector is slow" (it isn't, you didn't tune it)
- **Why:** `hnsw.ef_search` defaults to **40** (too low for recall); `m`=16/`ef_construction`=64 are "balanced," not tuned. "Most 'pgvector is slow' posts are wrong because nobody tuned the parameters." _Source: `field-05` §3, `ecosystem-09` §6._
- **Detect:** Low recall or high p99 on ANN with default params.
- **Avoid:** Raise `ef_search` first (free, query-time, no rebuild); **measure recall before** cranking `m`/`ef_construction` (doubles build time + memory).

### P25. Filtered ANN over-filters → too few rows for multi-tenant search (see [[BATTLE-TESTED-SCENARIOS]] #9)
- **Why:** Pre-0.8 pgvector returns k candidates, the `WHERE tenant_id` drops most, you get <k. _Source: `ecosystem-09` §5._
- **Detect:** Tenant-scoped ANN returns fewer than `LIMIT` rows despite plenty of matches.
- **Avoid:** pgvector 0.8 `SET hnsw.iterative_scan = 'relaxed_order'`; partial HNSW per big tenant. Confirm provider pgvector ≥0.8.

### P26. Full `vector` (float4) blows RAM at scale; binary quantization tanks recall (see #10)
- **Why:** 1536-dim `vector` = 6,148 bytes/row before the graph. Binary quant (1-bit) is 32x smaller but a "significant recall drop on 1536-dim" without re-ranking. _Source: `field-05` §3, `ecosystem-09` §3._
- **Detect:** Index falls out of RAM → latency; or recall collapses after switching to `bit`.
- **Avoid:** Default `halfvec` (2-byte, exact 50% storage, matching recall) for ≥1536-dim; binary quant only behind a re-rank stage.

### P27. IVFFlat built before data loads, or left to drift → degraded recall
- **Why:** IVFFlat must be built **after** representative data loads (it clusters around centroids) and degrades as data drifts; HNSW builds incrementally on empty tables. _Source: `ecosystem-09` §2, `field-05` §3._
- **Detect:** IVFFlat recall degrading over time as the table grows/shifts.
- **Avoid:** Default HNSW; reserve IVFFlat for static, memory-constrained, bulk-loaded data and rebuild on drift.

---

## §Provider / Platform

### P28. Self-hosting Supabase is operationally rough (Storage, Kong, Auth/GoTrue, logging)
- **Why:** The Postgres is rock-solid; the breakage clusters in the BaaS wrapper — file upload broken via Docker (#16857), gateway+logging in local dev (#26785), can't delete user locally, Google-auth traps, email-provider rate-limiting other providers. _Source: `ecosystem-10` §3._
- **Detect:** Storage/Auth/gateway failures in a self-hosted stack.
- **Avoid:** Prefer hosted Supabase unless data-residency forces self-host; budget real ops time if you do.

### P29. Convex self-host left on default secrets = open admin
- **Why:** The self-hosted Convex README ships default instance secret + admin keys; leaving them = anyone can admin. Also an anonymous beacon (disable with `--disable-beacon`); less battle-tested on Windows. _Source: `ecosystem-03` §B3._
- **Detect:** Default keys still in place after self-host setup.
- **Avoid:** Change the instance secret + admin keys immediately; `--disable-beacon`.

### P30. Neon cold-start penalty (scale-to-zero) on latency-critical apps
- **Why:** Scale-to-zero suspends compute when idle; the **first query after idle pays a resume penalty** (sub-second to low-seconds). Great for spiky/agent workloads, bad for always-warm latency-critical. _Source: `ecosystem-03` §A3._
- **Detect:** Intermittent first-request latency spikes after idle periods.
- **Avoid:** A min-CU/"always-on" setting for warm paths; accept it (or prefer Supabase) for latency-critical always-on apps.

### P31. Provider Postgres major lags core; a feature you assume may be missing
- **Why:** Supabase/Neon/RDS/Cloud SQL lag postgresql.org by 0–12 months and may withhold a feature (e.g. `summarize_wal`/incremental basebackup, `io_uring`, native `uuidv7()`). Neon's re-architected storage makes PG17 incremental-basebackup irrelevant entirely. _Source: `ecosystem-02` §3, `field-04` §1._
- **Detect:** A feature works on local vanilla PG but not on the managed provider.
- **Avoid:** Check the **provider's** supported-version + supported-extension page, not postgresql.org. **Feature-detect** before using (e.g. `SELECT uuidv7()` probe; fall back to `gen_random_uuid()` if <18).

### P32. Supabase OAuth token endpoint changed 201→200 (May 26, 2026)
- **Why:** Supabase's `/v1/oauth/token` returned HTTP **201 Created**; on **2026-05-26** it changed to **200 OK** (OAuth 2.1 compliance). Code that hardcoded `=== 201` broke token exchange after that date (and strict OAuth clients broke before it). _Source: `ecosystem-01` §1._
- **Detect:** OAuth token exchange failing around that date boundary; a `=== 201` check in the client.
- **Avoid:** Check `response.ok` / any 2XX, never hardcode a specific 2XX status.

---

## §Currency (date-check or repeat a stale mistake)

### P33. Citing pre-Nov-2025 Prisma benchmarks ("bloated/slow on edge")
- **Why:** Prisma 7 (2025-11-19) removed the Rust engine; "most Prisma vs Drizzle comparisons online describe a Prisma that no longer exists." Bundle fell ~90% to ~1.6MB ESM, ~9x cold start, ~3x queries. The widely-cited ECOSIRE "66 schemas" blog benchmarks Prisma 6 (Rust) and overstates the penalty. _Source: `field-04` §2, `ecosystem-05` §2._
- **Detect:** A Prisma perf claim that mentions a 14–30MB Rust binary or pre-v7 cold-start numbers.
- **Avoid:** First determine if a benchmark is Prisma ≤6 (Rust) or 7 (TS); reject the stale ones. (Drizzle still wins raw bundle ~28x, but Prisma 7 is no longer disqualifying.)

### P34. Citing pre-Sept-2025 index/IO advice (pre-PG18)
- **Why:** PG18 (2025-09-25) added native `uuidv7()` (kills the UUIDv4-vs-bigint dispute), async I/O (~3x scan reads), skip-scan (weakens "always lead the composite index with your filter column"), and made virtual generated columns the default. _Source: `field-04` §1._
- **Detect:** Advice that assumes UUIDs always fragment the index, or that a suboptimal composite-index column order is always fatal.
- **Avoid:** Date-check against PG18. Default new PKs to `uuidv7()` **after feature-detecting** it on the managed provider; be explicit `STORED` when you want a generated column materialized for an index (virtual is now the default).

### P35. UUIDv4 (`gen_random_uuid()`) as a PK on a high-insert table → index bloat
- **Why:** UUIDv4's 122 random bits scatter B-tree inserts across random pages: ~79% leaf fill vs ~97.6% for integers ("40% more I/O per lookup"); 8.5M extra buffer hits vs bigint on a 10M-row/1M-update benchmark. energy uses `gen_random_uuid()` (=v4) on **every** table. _Source: `field-03` DISPUTE 1, `ecosystem-00` §B1._
- **Detect:** `gen_random_uuid()` PK on a high-write table; index bloat / poor cache hit ratio.
- **Avoid:** `uuidv7()` (PG18, time-ordered, near-bigint locality) — or `bigint` identity for internal-only high-write tables. The agreed-wrong default is UUIDv4. (This is a concrete house-style upgrade over energy's current schema.)

---

## The detection layer acorn ships (lints, not vibes)
- **RLS:** Supabase advisor `0003` (RLS-enabled on every `public.*` table) in CI; eval tests run as `anon`/`authenticated`; grep policies for unwrapped `auth.uid()` and missing `WITH CHECK`.
- **Migrations:** `squawk` / `atlas migrate lint` flag AccessExclusive ops, missing `CONCURRENTLY`, missing `lock_timeout`; rewrite-to-NOT-VALID/VALIDATE template.
- **Connections:** assert `prepare:false` on the `:6543` URL + a separate `:5432` `directUrl`; assert `connection_limit` set for serverless.
- **pgvector:** assert `halfvec` for ≥1536-dim; assert `iterative_scan` for tenant-filtered ANN; a recall-measurement step before knob-tuning.
- **Currency:** feature-detect `uuidv7()`; reject pre-Nov-2025 Prisma / pre-Sept-2025 PG benchmarks.
