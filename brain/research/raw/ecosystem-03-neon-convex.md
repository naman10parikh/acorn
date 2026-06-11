# Ecosystem Research — Neon & Convex (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.

## PART A — Neon (serverless Postgres, post-Databricks)

### A1. The acquisition + what changed (dated)
- **Databricks announced intent to acquire Neon 2025-05-14, ~$1B.** Databricks continues investing in Neon's DB + DX for existing/new customers. _Source: <https://www.databricks.com/company/newsroom/press-releases/databricks-agrees-acquire-neon-help-developers-deliver-ai-systems> (2025-05-14); <https://www.databricks.com/blog/databricks-neon>._
- **Pricing changes after the acq (Aug 2025):** new usage-based pricing — **compute −15–25%, storage −80% ($1.75 → $0.35/GB)**, **$5/mo minimum** for paid plans. **Oct 2025: free-plan compute doubled to 100 CU-hours.** _Source: <https://vela.simplyblock.io/articles/neon-serverless-postgres-pricing-2026/>; <https://www.saaspricepulse.com/tools/neon>._ (Matches energy checklist line 270's "−15–25% compute / −80% storage" — confirmed + dated.)
- **The AI-agent signal:** **>80% of databases provisioned on Neon are created by AI AGENTS, not humans.** This is *the* datapoint for acorn — Neon is explicitly the "agents spin up Postgres" platform. _Source: <https://venturebeat.com/data-infrastructure/the-1-billion-database-bet-what-databricks-neon-acquisition-means-for-your-ai-strategy>; databricks blog._

### A2. Architecture differentiators (why Neon ≠ stock Postgres)
- **Separation of storage and compute** — compute is stateless and **scales to zero** (suspend when idle, resume on connect); storage is a custom multi-tenant **copy-on-write** layer (not stock PG heap files). _Source: <https://getautonoma.com/blog/neon-database>; <https://medium.com/@ThinkingLoop/neons-postgres-twist-cloud-native-agent-ready-492d51b9e9b1>._
- **Instant provisioning** — a fully isolated Postgres in **≤500 ms**. _Source: databricks press release._
- **Branching/forking of schema AND data** — instant, copy-on-write, fully isolated branch (like git for your DB). The headline feature; ideal for per-PR preview DBs and "test the migration on a copy of prod, roll back by repointing." _Source: same._
- **Instant restore / PITR** — restore to any point via the branch/history mechanism (Neon's PITR is branch-based, not pg_basebackup-based).

### A3. Gotchas an agent must know
- **Cold-start latency:** scale-to-zero means the FIRST query after idle pays a resume penalty (sub-second to low-seconds depending on tier). Bad for latency-critical always-warm apps; great for spiky/agent workloads. Use a min-CU / "always-on" setting if you need warm.
- **Connection model:** Neon provides a **pooled (PgBouncer) endpoint** (`...-pooler...`) for serverless + a direct endpoint. Use the pooled endpoint from Lambda/edge; transaction mode. (Same RLS-session-GUC caveat as `ecosystem-04` §3.)
- **Not all PG17 features apply** — Neon's storage engine replaces stock PG storage, so PG17 incremental basebackup is irrelevant; rely on Neon branching/PITR instead.
- **Databricks-direction risk:** post-acq roadmap tilts toward AI/Lakebase integration; watch for pricing/feature shifts. Standalone-Neon longevity is "continue investing" per Databricks but is now a Databricks product.

### A4. Neon for agents — tooling
- **Neon MCP server** exists (`@neondatabase/mcp-server-neon` / hosted) — lets an agent create projects, run SQL, manage branches. Pairs with the ">80% provisioned by agents" thesis.
- CLI: `neonctl` (project/branch/role/connection-string management).
- Drizzle + Prisma both ship Neon driver adapters (`@neondatabase/serverless` HTTP/WebSocket driver for edge).

## PART B — Convex (open-source reactive DB)

### B1. Versions + freshness (gh + repo)
- `get-convex/convex-backend`: **11,910 stars**, **open issues 186**, last push **2026-06-11**; latest precompiled release **2026-06-09**. Composition TS 44.8% / Rust 43.2%. _Source: `gh api` 2026-06-11; <https://github.com/get-convex/convex-backend>._
- **Self-host:** Docker (recommended) or prebuilt binary; runs over **SQLite, Postgres, MySQL, RDS**, and integrates with Neon/Fly/Vercel/Netlify for hosting. Includes dashboard + CLI in self-host. _Source: <https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md>._

### B2. What Convex IS (different paradigm from Supabase/Neon)
- **Reactive, strongly-consistent, code-first.** You write **pure TypeScript** server functions (queries/mutations/actions); **reactive queries auto-subscribe to live updates** (no manual websocket/Realtime wiring). **All reads/writes strongly consistent by default — no eventual-consistency race conditions / stale reads.** _Source: openapps.pro/apps/convex; producthunt; convex docs._
- Not SQL — a document/relational hybrid with a TS query API; **no raw SQL**, no RLS (auth via function-level checks). This is the BIG trade-off vs Postgres: you give up SQL/RLS/the PG ecosystem for reactivity + end-to-end TS + zero-config realtime.
- Built-ins: cron jobs, file storage, **vector search**, full-text search, **Components** (composable backend modules — auth, rate-limit, workflows installable as packages). _Source: convex docs / components._

### B3. Self-host limitations vs cloud
- Self-host is "less battle-tested on Windows than Linux/Mac."
- Ships an **anonymous beacon** (disable with `--disable-beacon`).
- **MUST change default instance secret + admin keys** from the repo defaults (security gotcha — leaving defaults = open admin). _Source: self-hosted README._
- Cloud has the generous free tier + zero ops; self-host trades that for control/data-residency.

### B4. When acorn picks Convex
- Real-time-first apps (collab, presence, live dashboards, multiplayer) where Supabase Realtime wiring is the pain point.
- All-TypeScript teams who want one mental model client→server→DB.
- **NOT** when you need: raw SQL, Postgres extensions (pgvector/PostGIS), RLS-as-isolation, complex analytical queries, or to reuse the vast PG tooling. For Energy's multi-tenant SaaS default (Supabase + RLS), Convex is the **alt**, not the default — matches energy checklist line 270.

## PART C — quick verdict for acorn
- **Default: Supabase** (Postgres + RLS + the agent MCP) — most Energy products.
- **Reach for Neon** when: per-PR branch DBs, scale-to-zero economics, or "agent provisions its own DB" (its native use case). Neon + Drizzle/Prisma adapters on edge.
- **Reach for Convex** when: realtime/reactive is the core requirement and SQL/RLS is not needed.
