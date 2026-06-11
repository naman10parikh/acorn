# Ecosystem Research — Multi-Tenant Schema Design in Postgres (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.
> This is acorn's flagship skill: most Energy products are multi-tenant SaaS on Supabase.

## 1. The three models (and the honest verdict)

| Model | Isolation | Tenants it suits | The killer drawback |
|---|---|---|---|
| **Shared schema + `tenant_id` column (+RLS)** | Logical (RLS-enforced) | 10k–100k+ low/modest-traffic tenants | Noisy-neighbor; one bad query/index hurts all; "biggest blast radius if RLS misconfigured" |
| **Schema-per-tenant** | Strong logical | 10–500 high-value tenants needing per-tenant customization | Migrations must run N times; catalog bloat at thousands of schemas; pooling pain (mitigated by Citus 12 + PgBouncer) |
| **Database-per-tenant** | Strongest | Few, regulated, high-value tenants | **Connection pooling breaks immediately** — PgBouncer pools are per `(db,user)`; thousands of DBs × pools blow past `max_connections`; you end up sharding clusters |

**Consensus recommendation: shared-schema + RLS is the default and most common.** Schema/DB-per-tenant only for a small number of high-value or compliance-bound tenants. _Sources: <https://planetscale.com/blog/approaches-to-tenancy-in-postgres>; <https://www.crunchydata.com/blog/designing-your-postgres-database-for-multi-tenancy>; <https://oneuptime.com/blog/post/2026-01-25-multi-tenant-schemas-postgresql/view> (2026-01-25); <https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/>; <https://debugg.ai/resources/postgres-multitenancy-rls-vs-schemas-vs-separate-dbs-performance-isolation-migration-playbook-2025> (2025)._

## 2. RLS performance reality (kills the "RLS is slow" myth)
- **RLS overhead is typically 1–5%** vs application-level `WHERE tenant_id = ...` filtering, because PG's planner treats policy predicates like WHERE clauses and **pushes them down to index scans**. _Source: oneuptime 2026-01-25; AWS DB blog._
- **It is only fast if the `tenant_id` column is indexed** and the policy predicate is sargable. (energy indexes `user_id` — correct.)
- **Wrap session/auth lookups in a scalar subselect** so they're evaluated once, not per-row: `using (tenant_id = (select current_setting('app.tenant_id')::uuid))`. (Supabase's documented `(select auth.uid())` trick — same principle.)

## 3. THE multi-tenant footgun: PgBouncer pooling mode vs RLS session variables (cite this loudly)
**Real breakage:** RLS that relies on a **session GUC** (`SET app.current_tenant = ...`) is SAFE only under **transaction-mode** pooling. Under **session-mode** pooling (PgBouncer's *default*), the session variable **persists across the pooled connection's reuse by a different tenant** → **cross-tenant data leak.** _Source: oneuptime 2026-01-25; debugg.ai 2025._
**Rules acorn must encode:**
1. With shared-schema RLS + a pooler → **use `pool_mode = transaction`** (Supabase's "Transaction" pooler / port 6543 is exactly this).
2. Set the tenant with **`SET LOCAL`** (txn-scoped), never plain `SET` (session-scoped), so it auto-resets at COMMIT.
3. If you must use session pooling, explicitly `RESET` the GUC at the start of every txn.
4. **Supabase specific:** the Supavisor/transaction pooler (6543) is for serverless; the session pooler (5432 direct) is for long-lived. PREPARE statements + transaction pooling historically conflicted — Supavisor added named-prepared-statement support, but verify for your driver. _Source: Supabase pooling docs <https://supabase.com/docs/guides/database/connecting-to-postgres>._

## 4. Citus / sharding angle
- **Schema-based sharding with Citus 12 + PgBouncer** is now "very viable with fewer tradeoffs" — Citus 12 added first-class schema-based sharding (each tenant schema becomes a distributed shard) with PgBouncer integration. For the 10–500-large-tenant case this beats raw schema-per-tenant. _Source: PlanetScale tenancy blog; Citus 12 release._
- For >100k tenants on shared-schema, you eventually **shard by `tenant_id`** across clusters (hash range) — Citus or app-level routing.

## 5. energy's current posture (from internal ref)
energy is **shared-schema + `user_id` + RLS** (the recommended model) BUT:
- Tenant key is `user_id TEXT` (Clerk), compared via `auth.uid()::text` — works, but a JWT-claim read is cleaner with Clerk's native Supabase integration.
- energy does NOT set a session GUC (it leans on `auth.uid()` from the Supabase JWT, which is request-scoped, not pooler-leaky) — so energy avoids the §3 footgun *as long as it uses Supabase Auth JWTs and not a manual `SET app.tenant`*. acorn should keep it that way and explicitly warn against manual session-GUC tenancy behind a session pooler.
- energy's `memories` table has a `using(true)` policy (no tenant gate) — **a real isolation hole** if that table is ever exposed to the anon/authenticated key. Standardize on `auth.uid()::text = user_id`.

## 6. Per-tenant column checklist acorn recommends (house style)
- `tenant_id` (or `org_id`) NOT NULL on every tenant-scoped table, indexed, first column of composite indexes.
- RLS enabled + deny-by-default + one `service_role` policy + one per-tenant policy, predicate wrapped in `(select ...)`.
- Composite unique keys are `(tenant_id, natural_key)` (energy does `(user_id, key)`, `(user_id, channel)` — correct).
- A `tenants`/`orgs` table as the FK parent; cascade rules thought through (soft-delete vs hard).
- Tenant context set via JWT claim (preferred) or `SET LOCAL` under transaction pooling (never session-GUC under session pooling).

## 7. Open question for synthesis
Whether acorn defaults to **Supabase-Auth JWT-claim tenancy** (energy's path, pooler-safe) vs **app-set `SET LOCAL` GUC tenancy** (needed when not using Supabase Auth, e.g. raw Neon/RDS). Likely: JWT-claim on Supabase, `SET LOCAL`+transaction-pool elsewhere.
