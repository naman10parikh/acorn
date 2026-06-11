# acorn — Memory

> Bootstrap loaded every cycle. acorn's load-bearing facts only — the 12 house rules, the default
> stack, the 5 currency-inflection dates. Full depth lives in `brain/` (BM25-searchable via
> `acorn brain search`). Keep this under ~2,000 tokens.

## The default stack (one line, June 2026)

**Supabase (Postgres) + Drizzle (`generate`→lint→`migrate`, never `push`) + shared-schema RLS tenancy
(JWT-claim) + pgvector-HNSW/halfvec + monitored WAL/PITR**, with **Neon** for ephemeral
agent-provisioned branch DBs and **Convex** reserved for realtime-first apps (where you won't later need
SQL/RLS/pgvector). _Source: `brain/EXPERTISE-MAP.md` default stack._

## The 12 acorn house rules (the spine — full versions in `brain/OPINIONS.md`)

1. **RLS deny-by-default**; lint that every `public.*` table has RLS enabled (10.3% of Lovable projects
   leaked via the anon key — CVE-2025-48757, 170 apps).
2. **Wrap auth in policies:** `(select auth.uid())`, never bare `auth.uid()` (bare re-evaluates per row —
   a 5ms policy becomes 5s on 100K rows).
3. **Index every RLS predicate column** (>100x on large tables; `tenant_id` first in composites).
4. **Never test RLS in the Supabase SQL Editor** (runs as `postgres`, bypasses RLS) — test as
   `anon`/`authenticated`, or `service_role` is also wrong for verification.
5. **One** `moddatetime`/`updated_at` trigger fn, reused across tables (energy has two duplicate-named).
6. **Migrations: expand → dual-write/backfill → contract**; never a bare `RENAME`/`DROP`/`ALTER COLUMN
   TYPE` on a hot table.
7. **`SET lock_timeout` on every migration**; `ADD COLUMN ... DEFAULT` safe PG11+; `NOT NULL` via
   `NOT VALID`+`VALIDATE`; indexes `CONCURRENTLY`. Lint with squawk/atlas + acorn's rules.
8. **Backfill the ORM migration ledger** (`__drizzle_migrations`/`_prisma_migrations`) after any
   cross-provider data restore (else it re-runs all migrations and collides).
9. **Serverless pooler (`:6543`/neon-pooler) → `prepare:false`, transaction mode**; direct `:5432` for
   migrations/seeds/long-lived. Always two connection strings, set before the first request.
10. **pgvector: HNSW default**, `halfvec` for ≥1536-dim (exact 50% storage, matching recall),
    `hnsw.iterative_scan` for filtered (multi-tenant) ANN; build the index on a branch with high
    `maintenance_work_mem`; measure recall before cranking `m`/`ef_construction`.
11. **Backup: monitored continuous WAL archiving** (one missing 16MB segment breaks the chain);
    scheduled restore drills; explicit RPO/RTO; Supabase PITR add-on for products that matter; Neon
    branch/Time-Travel to inspect-before-restore. A never-restored backup is a hypothesis.
12. **Agent DB access via MCP = read-only-at-role + branch/dev only + project-scoped + treat rows as
    untrusted**; never point an agent MCP at prod. Defends the lethal trifecta (private data +
    untrusted instructions + an exfiltration channel).

## The 5 currency-inflection dates (date-check every recommendation)

A blog older than the relevant event may be confidently wrong. _Source: `brain/KNOWN-PITFALLS.md`
§Currency, `field-04`._

1. **PG18 — shipped 2025-09-25.** Native `uuidv7()`, async I/O (~3x scan reads), skip-scan, virtual
   generated columns now the default. **But Supabase defaults to PG17 (no native `uuidv7`)** — so
   **feature-detect `SELECT uuidv7()` before using it**; fall back to `gen_random_uuid()` on PG<18.
   Never hard-code `uuidv7()`.
2. **Prisma 7 — 2025-11-19.** Removed the Rust engine ("a Prisma that no longer exists"): bundle ~90%
   smaller (~1.6MB ESM), ~9x cold start, ~3x queries. **Reject every pre-Nov-2025 "Prisma is
   bloated/slow on edge" benchmark as stale.** (Drizzle still wins raw bundle ~28x, but Prisma 7 is no
   longer disqualifying.)
3. **Neon → Databricks — 2025-05-14** (acquisition; Neon's re-architected storage makes PG17
   incremental-basebackup irrelevant; >80% of Neon DBs are agent-created).
4. **Drizzle → PlanetScale — 2026-03-03** (Drizzle is now PlanetScale-backed; reinforces Drizzle as the
   Energy default ORM).
5. **The agent-DB threat model (lethal trifecta) postdates 2024.** Author agent-DB-ops from 2025+
   sources only (Willison, 2025-07-06). The operational patterns are newer and thinner-sourced — ship
   the defensible floor (non-`service_role`, branch/dev-only, rows-untrusted, never-prod) as hard rules.

## The boundary (LOCKED)

acorn owns **schema / migrations / RLS / data-layer ONLY** — never app code, query call-sites, or API
routes (that is turbo/pixel). I emit the migration, the policy, the typed schema, and the
connection-string contract; the *consumer* of those is someone else's repo.

## The acceptance bar

`acorn schema "<domain brief>"` on a fresh Postgres → **migrations applied + RLS verified by tests as
the un-privileged role**. Everything acorn ships exists to make that one line true, safely, for an agent
caller.
