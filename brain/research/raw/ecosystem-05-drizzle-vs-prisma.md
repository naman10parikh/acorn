# Ecosystem Research — Drizzle vs Prisma (June 2026 honest state)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited with dates.

## 0. Live repo stats (gh api, 2026-06-11)
| Repo | Stars | Open issues | Last push |
|---|---|---|---|
| `prisma/prisma` | **46,255** | 2,618 | 2026-06-11 |
| `drizzle-team/drizzle-orm` | **34,758** | 1,842 | 2026-06-11 |
| `prisma/prisma-engines` | 1,334 | — | 2026-06-08 |
_Source: `gh api repos/...` run 2026-06-11._ Both actively maintained (pushed today). Prisma leads on GitHub stars; **Drizzle leads on npm download trend** (see §3).

## 1. The two headline events of the last 6 months (BOTH dated, both load-bearing)

### A. Prisma 7.0.0 — Rust query engine REMOVED — **2025-11-19**
- Prisma 7 made the **TypeScript Query Compiler the default** and **removed the Rust binary entirely**. _Source: <https://www.prisma.io/blog/announcing-prisma-orm-7-0-0> (2025-11-19); InfoQ <https://www.infoq.com/news/2026/01/prisma-7-performance/> (2026-01)._
- **Bundle size: ~14 MB (7 MB gzip) → ~1.6 MB (600 KB gzip)** = 85–90% smaller. **Up to 3x faster queries**, **70% faster TS type-checking** vs the Rust client. _Source: same Prisma blog._
- **ESM by default** — drops into Next.js 15, Astro 5, Hono, Deno 2, Bun 1.2 without CommonJS interop. _Source: same._
- **Why it matters for serverless/edge:** the Rust binary was the historical reason Prisma was painful on Cloudflare Workers / Lambda cold starts and blew the 3 MB CF free-tier bundle limit. Prisma 7 mostly erases that disadvantage — **"edge support is no longer a clear Drizzle win"** (Prisma added Driver Adapters for Neon, Turso, Cloudflare D1). _Source: ecosire 2026 + makerkit 2026._

### B. Drizzle team joined PlanetScale — **2026-03-03**
- PlanetScale hired the **entire Drizzle core team**; Drizzle stays an independent OSS project with its own roadmap, now with full-time funding. _Source: <https://planetscale.com/blog/drizzle-joins-planetscale> (2026-03-03); HN <https://news.ycombinator.com/item?id=47233956>._
- Signal: Drizzle is now enterprise-backed, not a side project — de-risks the "bus factor" concern that used to favor Prisma.
- Adoption: multiple 2026 sources report **Drizzle npm downloads overtook Prisma (first time, ~May 2026)**. _Source: search snippet citing "drizzle-orm dethroned prisma for the first time in May 2026" (tech-insider.org / dev.to 2026)._ **[FLAG — "dethroned in May 2026" is a secondary-blog claim; I did NOT pull npm-trends directly. Treat as directional. See GAPS.]**

## 2. ⚠️ VERSION DISPUTE acorn must not repeat
The widely-cited **ECOSIRE "66 production schemas" blog** (<https://ecosire.com/blog/drizzle-orm-vs-prisma-2026-comparison>) benchmarks **"Drizzle 0.44 vs Prisma 6.x (Rust engine, ~30 MB)"** and **does not mention Prisma 7 at all** — it is **stale relative to Prisma 7 (Nov 2025)**. Its perf numbers (Prisma cold-start 95 ms, 110 MB idle) reflect the *Rust* engine and **overstate Prisma's current penalty**. Any "Prisma is 10x slower / huge bundle" claim sourced from pre-Nov-2025 content is OUTDATED. Always check whether a Prisma benchmark is v6 (Rust) or v7 (TS). _Sources: ecosire blog (loaded 2026-06-11, self-evidently pre-v7) vs prisma.io v7 announcement (2025-11-19)._

## 3. Honest current trade-offs (post-Prisma-7, June 2026)

| Dimension | Drizzle (0.44+) | Prisma (7.x) |
|---|---|---|
| **Mental model** | SQL-first query builder; you write SQL-shaped TS. Thin. | Schema-first (`schema.prisma`); generated client abstracts SQL. |
| **Bundle / cold start** | Tiny (no engine); ~12 ms cold (ecosire). Best for edge/Lambda. | Was the weak spot; **v7 ~1.6 MB, ESM** — now competitive, not equal. |
| **Raw perf** | Marginally faster on simple ops (1.8 ms vs 2.4 ms SELECT, ecosire v6 numbers) | v7 closed most of the gap on serverful; 3x faster than v6. |
| **Migrations** | `drizzle-kit generate` → editable SQL files; `drizzle-kit push` for rapid dev (declarative diff). You can hand-write/edit migrations. | `prisma migrate dev/deploy`; opinionated, guards destructive changes; shadow DB. |
| **Type-safety depth** | Excellent, inferred from schema TS. Relational queries API matured (`db.query.x.findMany({with})`). | Excellent, generated. v7 = 70% faster typecheck. |
| **DB breadth** | PG, MySQL, SQLite, **Cloudflare D1, bun:sqlite, Turso, SQLite-over-HTTP** | PG, MySQL, SQLite, **CockroachDB, SQL Server, MongoDB** (Drizzle lacks these) |
| **Edge** | Native, long-standing | v7 Driver Adapters (Neon/Turso/D1) — caught up |
| **Backing** | PlanetScale (since 2026-03), OSS | Prisma company (commercial: Postgres, Accelerate, Pulse) |
| **Ecosystem maturity** | Younger; some rough edges historically in complex `where`/migrations | Older, larger plugin/Studio ecosystem; more SO answers |

## 4. The agent-operating angle (what acorn-the-agent needs)
- **Drizzle** is friendlier to an LLM that wants to *read and hand-edit SQL migrations* (plain `.sql`). `drizzle-kit push` is dangerous in prod (auto-applies diff, can drop columns) — restrict to dev/branch. Use `generate`+review+`migrate` for prod.
- **Prisma 7** is friendlier to an LLM that reasons over a single declarative `schema.prisma`; `prisma migrate dev` uses a **shadow database** to detect drift (needs a second DB the agent must provision; a gotcha on managed providers where you can't create DBs freely → use `prisma migrate diff` for shadow-less).
- **Both** generate types; for an agent, the schema file (Prisma) or the schema TS (Drizzle) is the single source of truth to inspect before writing queries.

## 5. acorn recommendation (to finalize in synthesis)
- **Default for Energy/Supabase-Postgres products: Drizzle** — SQL-first matches the "agent reads/edits real SQL" ethos, tiny edge bundle, plain `.sql` migrations align with energy's existing numbered-SQL workflow, now PlanetScale-backed. Use `generate`→review→`migrate` (NOT `push`) for anything past dev.
- **Choose Prisma 7 when:** you need MongoDB/SQL Server/CockroachDB, want the most mature Studio/tooling, or the team prefers schema-first. The old "Prisma is bloated/slow on edge" objection is largely resolved as of v7 — judge on model fit, not the stale Rust-era benchmarks.
