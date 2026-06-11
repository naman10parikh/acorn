# Ecosystem Research — Real-World Breakage (GitHub issues + production postmortems, June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited (issue # + URL).
> This is the anti-slop section: actual high-engagement issues + real outage patterns, not feature lists.

## 1. Drizzle ORM — the issues that reveal the real failure surface
Top-commented closed issues (`gh search issues --repo drizzle-team/drizzle-orm --state closed --sort comments`, 2026-06-11):
- **#2389 (86→73 comments) — `drizzle-kit push` not detecting Postgres enum label already exists.** <https://github.com/drizzle-team/drizzle-orm/issues/2389> → confirms the **`drizzle-kit push` enum/diff fragility**: push tries to re-create an enum value that exists and errors. **Lesson: enums + `push` = pain; use `generate`+hand-edited SQL for enum changes, or prefer text+CHECK (energy's choice) over native PG enums.**
- **#781 — Drizzle-Kit 0.19.0 fails to generate migrations.** <https://github.com/drizzle-team/drizzle-orm/issues/781> → drizzle-kit version churn historically broke migration generation. **Lesson: PIN `drizzle-kit` and review every generated migration; don't blind-trust codegen.**
- **#2344 — `Cannot read properties of undefined (reading 'compositePrimaryKeys')`** <https://github.com/drizzle-team/drizzle-orm/issues/2344> → schema-definition edge cases crash the kit.
- **#2654 — TS error on optional fields during update/insert.** <https://github.com/drizzle-team/drizzle-orm/issues/2654> → Drizzle's insert/update types around optional/`.default()` columns are a recurring friction point.
- **#594 — Support PostgreSQL RLS (feature).** <https://github.com/drizzle-team/drizzle-orm/issues/594> → **Drizzle historically had NO first-class RLS DSL** (you wrote RLS in raw SQL migrations). Drizzle later added `pgPolicy()`/`crudPolicy` RLS helpers, but the long thread shows RLS was bolted on late. **Lesson for acorn: when using Drizzle on Supabase, RLS policies may still be cleanest as raw SQL in the migration, not via the Drizzle DSL — verify the DSL covers `(select auth.uid())` wrapping.**
- **#3067 — dependency on deprecated `@esbuild-kit/esm-loader`** and **#2251 — 0.30.10 broke with React 18.3.1** → dependency/peer churn.

**Net:** Drizzle's pain is concentrated in **`drizzle-kit` (the migration/diff tool)**, not the runtime query layer. The runtime is solid; the schema-diff/push tooling is where production teams get bitten. → **acorn rule: never `drizzle-kit push` against a shared/prod DB; `generate` → human/lint review → `migrate`.**

## 2. Prisma — the issues (note: many are the Rust-era pain that v7 FIXES)
Top-commented closed issues (`gh search issues --repo prisma/prisma`, 2026-06-11):
- **#27700 (401 comments!) — "403 when trying to download prisma engine."** <https://github.com/prisma/prisma/issues/27700> → THE most-discussed Prisma issue ever is about **downloading the Rust engine binary failing** (CDN 403, air-gapped/CI environments, checksum). **This single issue is the strongest argument for Prisma 7's Rust removal** — no binary to download = this entire class of failure disappears. acorn note: if a team is still on Prisma ≤6, engine-download flakiness in CI/Docker is a top risk; v7 eliminates it.
- **#2377 (352c) — split Prisma schema into multiple files.** <https://github.com/prisma/prisma/issues/2377> → for years Prisma forced ONE `schema.prisma`; large schemas were unwieldy. (Now supported via `prismaSchemaFolder`.) Contrast Drizzle (schema is just TS files, split freely).
- **#1122 (193c) — query across multiple schemas** / **#1844 (122c) — interactive transactions with dependencies** / **#678 (116c) — DB views** / **#5042 (216c) — exclude fields** → long-standing expressiveness gaps vs raw SQL. Several now partially addressed (`multiSchema`, `views`, interactive txns), but the comment volume shows how long users waited.
- **#2452 (179c) — Deno support** / **#8131 — `createMany()` return records** → runtime/ergonomics.

**Net:** Prisma's historical pain = **the Rust engine (download/bundle/edge)** + **schema-file rigidity** + **SQL-expressiveness gaps**. Prisma 7 (Nov 2025) directly kills the engine class; `prismaSchemaFolder` kills the single-file class. Judge Prisma on v7, not these scars.

## 3. Supabase — the issues (mostly platform/self-host ops, not the DB)
Top-commented closed issues (`gh search issues --repo supabase/supabase`, 2026-06-11):
- **#16857 (71c) — file upload broken in self-hosted Supabase via Docker** / **#26785 (86c) — API gateway + postgres logging not working in local dev** / **#32901 — can't delete user on local deploy ('Method Not Allowed')** → **self-hosting Supabase is operationally rough** (Storage, Kong gateway, logging, GoTrue admin all have sharp edges). **Lesson: prefer hosted Supabase unless data-residency forces self-host; budget real ops time for self-host.**
- **#15930 (82c) — Google auth not working** / **#10850 (67c) — email provider enabled rate-limits OTHER auth providers** → Auth/GoTrue config traps.
- **#12429 (63c) — custom domains for API & Storage** → long-requested platform gap.

**Net:** Supabase's *Postgres* is rock-solid (it's just Postgres); the breakage clusters in the **surrounding platform (self-host Docker, Storage, Auth/GoTrue, gateway)**. acorn note: keep the DB layer (the part acorn owns) clean; the risk is in the BaaS wrapper.

## 4. The RLS production-breakage facts (the scary ones — cite these to justify acorn's RLS rules)
_Source: <https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices>; <https://vibeappscanner.com/supabase-row-level-security>; <https://dev.to/whoffagents/supabase-row-level-security-in-production-patterns-that-actually-work-2l78> (2025)._
1. **"In May 2025, 10.3% of analyzed Lovable projects had Supabase tables readable by UNAUTHENTICATED requests using the public anon key."** → RLS-off-by-default + forgetting to enable it = mass data exposure. This is the #1 Supabase security failure in the wild. **acorn rule: deny-by-default, lint that EVERY public-schema table has RLS enabled (Supabase's own `0003`/advisor lint catches it — wire it into CI).**
2. **#1 RLS debugging trap: testing in the Supabase SQL Editor.** The SQL Editor runs as the `postgres` role which **BYPASSES ALL RLS** → your policy "works" in the editor and fails (or over-exposes) for real users. **Test RLS as `anon`/`authenticated` (set role / use the client with a user JWT), never in the SQL Editor.**
3. **`(select auth.uid())` wrapper = up-to-orders-of-magnitude faster** on big tables: wrapping the auth function in a scalar subselect makes the planner run it as a cached initPlan ONCE instead of per-row. energy does NOT do this → would degrade on large tables. _Source: Supabase RLS perf docs._
4. **Index the RLS column** → ">100x improvement on large tables" for `auth.uid() = user_id` once `user_id` is indexed. (energy indexes it — good.)
5. **Recursive RLS = a 500 in prod.** A policy that queries a table which itself has an RLS policy referencing the first = Postgres detects recursion and throws at RUNTIME (not migrate-time). Fix: a `SECURITY DEFINER` helper function in a private schema to break the cycle. _Source: same._

## 5. Cross-cutting lesson for acorn
The DATABASE engine (Postgres) almost never breaks. Production incidents cluster in:
(a) **migrations** (locks/rewrites → outage — see `ecosystem-08`),
(b) **RLS misconfig** (data exposure or recursion-500 — above),
(c) **the BaaS/ORM tooling layer** (drizzle-kit push, prisma engine download, supabase self-host),
(d) **connection pooling × session state** (cross-tenant leak — see `ecosystem-04` §3).
acorn's value is owning (a)-(d) as lint rules + templated house style, because that's where real teams bleed.
