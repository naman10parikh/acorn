# Ecosystem Research — Best Starter / Template / Example Repos (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Stars + last-push via `gh api`.

## 1. Canonical DB-stack starters (ranked, with WHY)

| Stars | Repo | Stack | Last push | Why it's a reference |
|---|---|---|---|---|
| **28,970★** | `t3-oss/create-t3-app` | Next.js + TS + **Drizzle (option)** + tRPC + NextAuth | 2025-12-13 | The default "typesafe full-stack Next.js" scaffolder; Drizzle is a first-class DB choice. Best *teaching* baseline for the Drizzle-on-Postgres path. |
| **15,877★** | `nextjs/saas-starter` | Next.js 15 + **Drizzle 0.43.1** + `postgres` driver + **Stripe 18** + shadcn/ui | 2025-12-11 | Vercel's official SaaS starter. **Confirmed Drizzle** (`db:generate`/`db:migrate`/`db:studio` scripts). The cleanest "Postgres + Stripe + Drizzle" reference; mirrors Energy's Supabase+Stripe shape. |
| **12,977★** | `ixartz/Next-js-Boilerplate` | Next.js 16 + **Drizzle ORM** + Sentry + Vitest + Playwright + Tailwind 4 | 2026-06-01 | DX-maximal boilerplate; Drizzle + full test/observability wiring. Actively maintained (pushed this month). |
| **7,180★** | `ixartz/SaaS-Boilerplate` | Next.js + **Drizzle** + Auth + **Multi-tenancy + Roles/Permissions** + i18n | 2026-06-01 | **THE multi-tenant reference** — explicitly ships multi-tenancy + RBAC on Drizzle. Closest to Energy's multi-tenant-SaaS default; study its tenant model. |
| **1,046★** | `vercel/nextjs-postgres-auth-starter` | Next.js + **Drizzle** + NextAuth + Postgres | 2024-06-23 | Minimal Drizzle+Auth+Postgres; small enough to read end-to-end. (Older — 2024.) |

## 2. Supabase-specific
- `supabase/supabase` (**104,020★**, pushed 2026-06-11) — the platform monorepo; `/examples` dir has dozens of framework integrations (Next.js, auth, RLS, realtime, vector). The authoritative source for "how Supabase intends X to be done." _Source: gh api 2026-06-11._
- `vito8916/supabase-nextjs-starter-template` (pushed 2026-04-07) — production-ready App Router + Supabase auth + dashboard shell + shadcn. Low stars but current and clean. _(Most keyword-search "supabase nextjs starter" hits are 0–2★ forks of the official `with-supabase` template — prefer the official `npx create-next-app -e with-supabase` over random forks.)_
- **Official path:** `npx create-next-app -e with-supabase` (Vercel/Supabase-maintained example) is the real canonical Supabase+Next.js starter — outranks the long tail of low-star forks.

## 3. Convex
- `get-convex/convex-backend` (**11,910★**, release 2026-06-09) — the OSS backend itself (self-host).
- `get-convex/templates` (131★, pushed 2026-06-10) + `get-convex/convex-demos` (275★, pushed 2026-06-09) — official starter templates + demo apps, **both pushed this week** (very live). Use these for the reactive/real-time path.

## 4. ORM repos (for reference / issue-mining — see `ecosystem-10`)
- `prisma/prisma` (46,255★, 2,618 open issues) — v7 (Rust-free) since 2025-11-19.
- `drizzle-team/drizzle-orm` (34,758★, 1,842 open issues) — PlanetScale-backed since 2026-03-03.

## 5. Tooling repos worth pinning
- `xataio/pgroll` — zero-downtime migrations via multi-version views (expand/contract + rollback). The strongest fit for acorn's migration mandate.
- `crystaldba/postgres-mcp` + Postgres MCP Pro — the live OSS Postgres MCP servers (the Node.js reference is archived).
- `squawkhq/squawk` + `ariga/atlas` — migration linters (destructive/lock detection) for CI.

## 6. Selection guidance for acorn
- **Multi-tenant SaaS reference → `ixartz/SaaS-Boilerplate`** (multi-tenancy + RBAC on Drizzle) — the closest match to Energy's default.
- **Clean Postgres+Stripe+Drizzle → `nextjs/saas-starter`** (Vercel-official, minimal, current).
- **Supabase-native → official `with-supabase` example**, not low-star forks.
- **Reactive/real-time → `get-convex/templates`**.
- **Teaching baseline → `create-t3-app`** with the Drizzle option.
Avoid 0–2★ "starter" forks — they're stale clones of the official examples.
