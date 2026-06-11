---
title: "acorn Opinions — explicit taste stances (the anti-slop layer)"
type: synthesis
created: "2026-06-11"
updated: "2026-06-11"
tags: [opinions, taste, house-style, stances, anti-slop, rls, migrations, pgvector, orm]
sources: ["brain/research/raw/field-03-taste-and-disputes.md", "brain/research/raw/field-01-rls-production-footguns.md", "brain/research/raw/field-02-migration-war-stories.md", "brain/research/raw/field-04-2026-invalidates-2025.md", "brain/research/raw/field-05-migration-disasters-and-pgvector-field-reality.md", "brain/research/raw/ecosystem-05-drizzle-vs-prisma.md", "brain/research/raw/ecosystem-06-tradeoff-matrix.md", "brain/research/raw/ecosystem-08-zero-downtime-migrations.md", "brain/research/raw/ecosystem-09-pgvector-embeddings.md", "brain/research/raw/ecosystem-00-internal-references.md"]
related: ["[[EXPERTISE-MAP]]", "[[BATTLE-TESTED-SCENARIOS]]", "[[KNOWN-PITFALLS]]", "[[GAPS-AND-DISPUTES]]", "[[TOOL-MATRIX]]"]
summary: "What acorn believes and refuses to do. Each stance: ALWAYS X / NEVER Y — because Z (source). These are opinions great practitioners hold that average ones don't. Where genuine taste-splits remain unresolved, this defers to GAPS-AND-DISPUTES rather than fake-resolving them."
---

# acorn Opinions

> The anti-slop layer. A listicle says "RLS is a good practice." acorn says: **"NEVER test RLS in the Supabase SQL Editor (it runs as `postgres` and bypasses RLS); test as `anon`/`authenticated` — because this privilege-mismatch is the single reason RLS bugs ship, and it cost 170 apps a breach."** Each stance is a default acorn applies unprompted and will defend with a receipt. Disputes that remain genuinely open are NOT fake-resolved here — they live in [[GAPS-AND-DISPUTES]].

## The two highest-leverage stances (if acorn remembers only two things)
1. **ALWAYS test RLS as the un-privileged role (`anon`/`authenticated`), NEVER in the SQL Editor or as `service_role`** — because the SQL Editor runs as `postgres` and bypasses ALL RLS, so a policy "verified" there is meaningless, and this exact privilege-mismatch is why CVE-2025-48757 leaked 170 apps. The highest-leverage taste in the vertical. _Source: `field-01` §3, `field-03` nugget 1._
2. **ALWAYS use two connection strings — pooled `:6543` (`prepare:false`) for the app, direct `:5432` for migrations/seeds — from day one, NEVER discover it via a 502** — because the transaction pooler doesn't support named prepared statements that postgres-js/Drizzle/Prisma default to, and this is the single most common production breakage in the entire vertical. _Source: `field-02` §1, `field-03` nugget 2._

---

## §RLS & tenant isolation

- **ALWAYS make RLS the floor, NEVER the ceiling.** RLS handles deny-by-default tenant isolation (the un-bypassable baseline); rich business rules (risk scores, time windows, device reputation, cross-store) go in the app/service layer — because RLS is constrained to SQL expressions and can't evaluate those, and DBAs become a bottleneck if you cram everything into policies. The 2026 consensus is hybrid, not either/or. _Source: `field-03` DISPUTE 2._
- **ALWAYS wrap auth functions: `(select auth.uid())`, NEVER bare `auth.uid()`** — because bare is re-evaluated per row ("a 5ms policy becomes a 5-second policy" on 100K rows); the subselect makes the planner cache it once as an initPlan. energy doesn't do this; acorn does. _Source: `field-01` §3, `ecosystem-01` §3.4._
- **ALWAYS write BOTH `USING` and `WITH CHECK` and test INSERT/UPDATE/DELETE, NEVER ship a SELECT-only RLS mental model** — because `WITH CHECK` is what stops a user planting a row under another tenant's id. _Source: `field-01` §3 row 8._
- **ALWAYS lint that every `public.*` table has RLS enabled in CI, NEVER trust the "secure-by-default" dashboard change** — because that default covers dashboard-created tables only; migration-created tables (`supabase db push`, how acorn works) are still opt-in, and "RLS is on by default now" is a false-confidence trap. _Source: `field-04` §4, `field-01` §1._
- **ALWAYS cast `auth.uid()::text` for Clerk-on-Supabase, NEVER compare a uuid to a Clerk text id** — because the type mismatch makes the policy silently deny everything; this is a real, repo-confirmed energy footgun. _Source: `field-01` §4._
- **NEVER default an agent's DB connection to `service_role`** for user-facing reads — because `service_role` bypasses all RLS, which is exactly the first leg of the lethal trifecta; use a scoped/user-JWT-bound role so RLS still protects the data the agent reads on a user's behalf. _Source: `field-01` §2._

## §Migrations & schema change

- **ALWAYS `SET lock_timeout` on every migration, NEVER run a migration that can queue indefinitely** — because a *waiting* AccessExclusive lock freezes every query behind it; "better to fail and retry than to queue behind long-running queries and cascade into an outage." _Source: `field-05` §2, `ecosystem-08` §4._
- **ALWAYS decompose breaking changes into expand→dual-write/backfill→contract, NEVER a bare `RENAME`/`DROP`/`ALTER COLUMN TYPE` on a hot table** — because the bare op either rewrites under AccessExclusive (outage) or breaks the still-running old app version mid-deploy. The canonical proof: a one-line CHECK on 84M rows = 4h12m/$52,400; the NOT VALID/VALIDATE two-step = 42min/$0. _Source: `field-05` §1, `ecosystem-08` §1._
- **ALWAYS `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` for NOT NULL/CHECK/FK, NEVER validate-on-add** — because validate-on-add scans the whole table under AccessExclusive you can't even cancel; the split validates under a weaker ShareUpdateExclusive while reads/writes continue. _Source: `ecosystem-08` §3a._
- **ALWAYS `CREATE INDEX CONCURRENTLY` on populated tables, NEVER a plain `CREATE INDEX`** — because the plain form blocks writes for the whole build; (caveat: can't be in a txn, leaves an INVALID index on failure to drop+retry). _Source: `ecosystem-08` §2._
- **ALWAYS test migrations at prod scale (~50M-row staging), NEVER trust a 10K-row staging pass** — because the 8,400x staging/prod gap is precisely what hides the outage. _Source: `field-05` §1._
- **NEVER `drizzle-kit push` against a shared/prod DB; ALWAYS `generate` → review → `migrate`** — because `push` can silently turn a rename into DROP+ADD (data loss) and chokes on enum diffs; the runtime is solid but `drizzle-kit` is the bite-zone. _Source: `field-02` §6, `ecosystem-10` §1._
- **ALWAYS backfill the ORM migration ledger after a schema restore, NEVER let the ORM re-run migrations against a populated schema** — because an empty `__drizzle_migrations`/`_prisma_migrations` makes it re-run everything and collide (`type "X" already exists`). The single most-missed cross-provider step. _Source: `field-02` §2._

## §Schema design (column-level house style)

- **ALWAYS `uuidv7()` (PG18, feature-detected) or `bigint` identity for new PKs, NEVER UUIDv4 (`gen_random_uuid()`) on a high-insert table** — because v4's random bits fragment the B-tree (~79% vs ~97.6% leaf fill, 8.5M extra buffer hits on a 10M-row benchmark); v7 keeps the distributed-id benefit with near-bigint locality. energy uses v4 everywhere — acorn flags the v7 upgrade. (The bigint-vs-UUIDv7 choice itself is an open taste-split → [[GAPS-AND-DISPUTES]] DISPUTE 1; the *settled* part is "not v4".) _Source: `field-03` DISPUTE 1, `ecosystem-00` §B1._
- **ALWAYS `text` + `CHECK (... IN (...))` for enum-like columns, NEVER native PG `CREATE TYPE ... AS ENUM` for anything that might change** — because you can't easily drop/reorder an enum value (migration pain), but you can edit a CHECK; energy already does this and it's a real taste marker (also dodges `drizzle-kit` enum/push pain). _Source: `field-03` nugget 4, `ecosystem-00` §B8._
- **ALWAYS `jsonb`, NEVER `json`** — because `jsonb` is binary and GIN-indexable; `json` is text. **AND don't reach for `jsonb` to avoid schema design** — it's for genuinely variable-shape blobs (per-channel credentials), not "I didn't want to write a migration." _Source: `field-03` nugget 5, `ecosystem-00` §B4._
- **ALWAYS one shared `moddatetime`/`updated_at` trigger function reused across tables, NEVER duplicate it per table** — because energy defines the same logic under two names (`update_updated_at` + `update_agentdial_updated_at`); consolidate to one (or use the `moddatetime` extension Supabase ships). _Source: `ecosystem-00` §B6._
- **PREFER a STORED generated `tsvector` column + GIN over a functional GIN index for FTS** — because a stored column stays valid and the planner uses it more reliably; (on PG18, be explicit `STORED` since virtual is now the default). energy uses the older functional-index form. _Source: `ecosystem-00` §B7, `field-04` §1._
- **ALWAYS composite unique keys as `(tenant_id, natural_key)` with a matching index, ALWAYS `tenant_id` first in composite indexes** — energy does `(user_id, key)`/`(user_id, channel)` correctly. _Source: `ecosystem-04` §6._

## §ORM & query layer

- **DEFAULT to Drizzle (SQL-first) for Energy/Supabase-Postgres, choose Prisma 7 only for MongoDB/SQLServer/CockroachDB or a schema-first team** — because an agent reasoning about queries benefits from a thin SQL-shaped layer it can read AND from emitting raw SQL when needed; Drizzle's plain `.sql` migrations align with energy's numbered-SQL workflow, and it's PlanetScale-backed now. _Source: `ecosystem-05` §5, `field-03` DISPUTE 3._
- **ALWAYS judge Prisma on v7, NEVER cite pre-Nov-2025 Prisma benchmarks** — because Prisma 7 removed the Rust engine ("a Prisma that no longer exists"): ~90% smaller bundle, ~9x cold start, ~3x queries; the "bloated/slow on edge" critique is stale (Drizzle still wins raw bundle ~28x, but Prisma 7 is no longer disqualifying). _Source: `field-04` §2, `ecosystem-05` §2._
- **ALWAYS use an ORM for the 90% CRUD and drop to raw SQL for the hot/analytical 10%, NEVER cram a hot/analytical query through the ORM out of purity** — and NEVER write an N+1 (a relation fetched inside a loop), which is the average-engineer tell; prefer a single `with`/join. _Source: `field-03` DISPUTE 3._

## §pgvector & embeddings

- **DEFAULT to HNSW, reach for IVFFlat only when memory-constrained + data is static** — because HNSW has better recall/latency and builds incrementally on empty/growing tables, while IVFFlat must be built after data loads and degrades as data drifts. _Source: `ecosystem-09` §2, `field-05` §3._
- **DEFAULT to `halfvec` for ≥1536-dim embeddings, NEVER full `vector` unless you measured a recall regression** — because `halfvec` is an exact 50% storage cut + 23% faster build with matching recall; "an obvious choice." Binary quantization only behind a re-rank stage (it tanks recall on 1536-dim alone). _Source: `field-05` §3, `ecosystem-09` §3._
- **ALWAYS measure recall before tuning, ALWAYS raise `ef_search` (free, query-time) before `m`/`ef_construction` (doubles build cost), NEVER blind-crank the build knobs** — because "the defaults are tuned for a demo, not your workload," and the build knobs double time+memory for a marginal recall gain. _Source: `field-05` §3, `ecosystem-09` §6._
- **ALWAYS enable `hnsw.iterative_scan` for tenant-filtered ANN, NEVER ship multi-tenant vector search on pre-0.8 pgvector without it** — because the filter over-filters and returns <`LIMIT` rows. _Source: `ecosystem-09` §5._
- **ALWAYS record the embedding model + dimension in a column** — because it's the only way to detect model drift on re-embed. _Source: `ecosystem-09` §7._

## §Connections & pooling

- **ALWAYS `prepare:false` on the pooled `:6543` client + a separate direct `:5432` `directUrl`, set before the first request** — see the highest-leverage stance #2. _Source: `field-02` §1._
- **PREFER JWT-claim tenancy on Supabase over a manual `SET app.tenant` session-GUC, NEVER a session-GUC behind a session-mode pooler** — because the GUC persists across pooled-connection reuse by another tenant → cross-tenant leak; if you must use a GUC, transaction-mode + `SET LOCAL`. energy is safe here precisely because it uses request-scoped Supabase-Auth JWTs. _Source: `ecosystem-04` §3._
- **ALWAYS cap connections per client in serverless (`connection_limit≈1`/Lambda), NEVER "just increase compute" as the first move** — because the bottleneck is too many *clients* grabbing connections, not too few server connections (the "increase compute" answer was downvoted 12×). _Source: `field-02` §3._

## §Backup, DR, provisioning

- **ALWAYS treat a never-restored backup as a hypothesis; ALWAYS schedule restore drills + monitor WAL-archive success, NEVER assume backups work** — because a single missing 16MB WAL segment breaks the recovery chain, silently. _Source: `ecosystem-11` §1,4._
- **ALWAYS enable the Supabase PITR add-on for products that matter, NEVER rely on daily-only backups for "undo the last 10 minutes"** — because second-level PITR is a paid add-on; lower tiers only do daily backups. On Neon, use branch-based Time-Travel to inspect *before* restoring. _Source: `ecosystem-11` §3._
- **ALWAYS provision agent DBs as ephemeral branches (Neon/Supabase) and gate the agent to branch/dev only, NEVER point an agent MCP at production** — because prod mutations must go through reviewed migrations + CI; the 2026 pattern is agent-provisions-branch → migrate → verify → merge/destroy. _Source: `ecosystem-12` §5, `field-01` §2._

## §Platform selection (when to pick what)

- **DEFAULT Supabase; reach for Neon when branching/scale-to-zero/agent-provisioning is the point; reserve Convex for realtime-first apps where you won't later need SQL/RLS/pgvector** — because Convex's lock-in isn't the API, it's the bundle (reactivity + transactions + built-ins) you stop getting; leaving means rebuilding S3/Algolia/Pusher/Clerk/queues yourself. _Source: `ecosystem-06` §1, `field-02` §5._
- **NEVER multi-tenant by table-prefix** — because even Convex abandoned it (re-platformed to many-DBs-per-instance after "messy abstractions and performance bottlenecks"); default shared-schema + RLS, DB-per-tenant only at enterprise/data-residency scale. _Source: `field-02` §4, `field-03` nugget 6._
- **PICK the storage engine + tenancy model before tuning queries** — because they dominate write-latency distribution far more than query micro-opts: Convex's P50 became their old P99 purely by re-platforming the storage layer. _Source: `field-02` §4, `field-03` nugget 7._

## §Currency discipline (a meta-opinion)

- **ALWAYS date-check a DB recommendation against the five 2025-2026 inflection events, NEVER repeat advice that predates them** — PG18 (2025-09-25), Prisma 7 (2025-11-19), Neon→Databricks (2025-05-14), Drizzle→PlanetScale (2026-03-03), the agent-DB threat model (2025+). A blog older than the relevant event may be confidently wrong. _Source: `field-04` (whole file)._
- **ALWAYS feature-detect provider capabilities (`SELECT uuidv7()`), NEVER hard-code a feature the managed provider may not have shipped yet** — because providers lag core by 0–12 months. _Source: `field-04` §1, `ecosystem-02` §3._

## Where acorn deliberately does NOT have an opinion (defer, don't fake-resolve)
Three real taste-splits remain genuinely open in June 2026 — acorn states both sides and the decision rule in [[GAPS-AND-DISPUTES]] rather than pretending a winner: **bigint-identity vs UUIDv7** for PKs (once v4 is off the table), **RLS-only vs RLS+app-layer authz** depth, and **ORM vs raw-SQL** for a given hot path. Defaulting is fine (acorn defaults as above); claiming the dispute is settled is slop.
