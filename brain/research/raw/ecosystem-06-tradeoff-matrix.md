# Ecosystem Research — Honest Trade-off Matrix + Synthesis (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. The consolidated decision layer.
> Read the deep files: ecosystem-01 (Supabase), -02 (PG17), -03 (Neon/Convex), -04 (multi-tenant),
> -05 (Drizzle/Prisma), -08 (migrations), -09 (pgvector), -10 (real breakage), -11 (backup/PITR),
> -12 (agent tooling). This file is the "which do I pick" rollup.

## 1. Managed Postgres provider matrix (the platform decision)

| | **Supabase** | **Neon** | **Convex** | **PlanetScale (PG)** |
|---|---|---|---|---|
| Core | Postgres + Auth/Storage/Realtime/PostgREST (full BaaS) | Pure serverless Postgres (storage/compute split, scale-to-zero) | Reactive TS DB (NOT SQL) | Serverless Postgres (Vitess heritage; added PG) |
| Killer feature | RLS + all-in-one + **agent MCP** | **Instant branching of schema+data**, ≤500ms provision, scale-to-zero | **Auto-reactive queries, strong consistency, zero realtime wiring** | Horizontal scale, branching |
| Branching | Yes (GA, per-PR isolated DB) | **Yes — best-in-class (copy-on-write, Time-Travel)** | n/a | Yes |
| Multi-tenant | RLS (the model energy uses) | RLS (same PG) | function-level auth (no RLS) | RLS |
| Realtime | Postgres Changes / Broadcast / Presence | — | **native, the whole point** | — |
| pgvector | Yes (`vector` ext) | Yes | own vector search | Yes |
| Scale-to-zero | No (always-on tiers) | **Yes** | managed | — |
| Agent-native | Remote MCP (OAuth2.1), read-only-at-role | **>80% DBs agent-provisioned**, MCP | TS-first | — |
| Self-host | Yes (but Docker/Storage/Auth rough — see ecosystem-10 §3) | No (managed only) | **Yes (Docker/binary over PG/SQLite/MySQL)** | No |
| Best for | **Energy default**: multi-tenant SaaS needing auth+storage+RLS in one | per-PR branch DBs, spiky/agent workloads, scale-to-zero economics | realtime/collab apps, all-TS teams | high-scale relational |
| Watch-out | self-host pain; PITR is paid add-on | Databricks-owned (roadmap tilt); cold-start on resume | no SQL/RLS/PG-extensions; lock-in to Convex paradigm | smaller PG mindshare |

_Sources: ecosystem-01/03; <https://dev.to/whoffagents/neon-vs-supabase-vs-planetscale-managed-postgres-for-nextjs-in-2026-2el4>; <https://www.closefuture.io/blogs/neon-vs-supabase>._

## 2. ORM matrix (post-Prisma-7) — see ecosystem-05 for detail
- **Drizzle (0.44+, PlanetScale-backed 2026-03):** SQL-first, tiny edge bundle, plain editable `.sql` migrations, best serverless. Pain = `drizzle-kit push`/diff fragility (use `generate`). **acorn default.**
- **Prisma (7.x, Rust-free 2025-11-19):** schema-first, now ~1.6MB ESM (was 14MB Rust), 3x faster than v6, edge-capable via Driver Adapters. Pick for MongoDB/SQLServer/CockroachDB or schema-first preference. The old "bloated/slow" critique is **stale** post-v7.
- **Do NOT** cite pre-Nov-2025 Prisma benchmarks (they measure the dead Rust engine).

## 3. Multi-tenant model decision (see ecosystem-04)
- **Default: shared-schema + `tenant_id` + RLS** (10k–100k+ tenants). energy already does this.
- Schema-per-tenant only for 10–500 high-value/customizable tenants (Citus 12 + PgBouncer makes it viable).
- DB-per-tenant only for few regulated tenants (pooling breaks at scale).
- **Footgun: RLS via session-GUC behind a SESSION-mode pooler = cross-tenant leak.** Use transaction pooling + `SET LOCAL`, or JWT-claim tenancy (Supabase Auth — pooler-safe).

## 4. The 12 acorn house rules (distilled from all files)
1. **RLS deny-by-default**; lint that EVERY public table has RLS on (10.3% of Lovable projects leaked via anon key, May 2025).
2. Wrap auth in policies: **`(select auth.uid())`**, not bare `auth.uid()` (per-row → cached initPlan; >orders-of-magnitude on big tables).
3. **Index every RLS predicate column** (>100x on large tables).
4. **Never test RLS in the Supabase SQL Editor** (runs as `postgres`, bypasses RLS) — test as `anon`/`authenticated`.
5. **One** `moddatetime`/`updated_at` trigger fn, reused (energy has two duplicate-named ones).
6. Migrations: **expand → dual-write/backfill → contract**; never bare RENAME/DROP/TYPE-change on hot tables.
7. **`SET lock_timeout` on every migration**; `ADD COLUMN ... DEFAULT` is safe PG11+; `NOT NULL` via NOT VALID + VALIDATE; indexes via `CONCURRENTLY`. Lint with squawk/atlas.
8. **Backfill the ORM migration ledger** (`__drizzle_migrations`/`_prisma_migrations`) after any cross-provider data restore (else all migrations re-run + collide).
9. **Serverless pooler (6543/neon-pooler) → `prepare:false`** (`prepared statement "drizzle_s_1" already exists`); transaction mode; direct 5432 for long-lived.
10. **pgvector: HNSW default**, `halfvec`/quantization to fit RAM, `hnsw.iterative_scan` for filtered (multi-tenant) ANN; build index on a branch with high `maintenance_work_mem`.
11. **Backup: monitored continuous WAL archiving** (a single missing 16MB segment breaks the chain); **scheduled restore drills**; explicit RPO/RTO; enable Supabase PITR add-on for products that matter; use Neon branch/Time-Travel to inspect-before-restore.
12. **Agent DB access via MCP = read-only-at-role + branch/dev only + project-scoped + treat rows as untrusted**; never point an agent MCP at prod; prod mutations go through reviewed migrations + CI. Provisioning via Neon branch lifecycle.

## 5. acorn's default stack recommendation (one line)
**Supabase (Postgres) + Drizzle (generate→lint→migrate) + shared-schema RLS tenancy (JWT-claim) + pgvector-HNSW + monitored WAL/PITR**, with **Neon** for ephemeral agent-provisioned branch DBs and **Convex** reserved for realtime-first apps — matching energy's checklist defaults but now evidence-backed and current to June 2026.
