---
title: "acorn Tool Matrix — canonical tools, access surface, and required secrets"
type: synthesis
created: "2026-06-11"
updated: "2026-06-11"
tags: [tools, matrix, mcp, cli, secrets, env-vars, supabase, neon, drizzle, prisma, pgvector]
sources: ["brain/research/raw/ecosystem-12-agent-tooling-mcp-cli.md", "brain/research/raw/ecosystem-01-supabase.md", "brain/research/raw/ecosystem-03-neon-convex.md", "brain/research/raw/ecosystem-05-drizzle-vs-prisma.md", "brain/research/raw/ecosystem-07-templates-and-repos.md", "brain/research/raw/ecosystem-08-zero-downtime-migrations.md", "brain/research/raw/ecosystem-09-pgvector-embeddings.md", "brain/research/raw/ecosystem-11-backup-pitr.md", "brain/research/raw/field-02-migration-war-stories.md", "brain/research/raw/ecosystem-00-internal-references.md"]
related: ["[[EXPERTISE-MAP]]", "[[OPINIONS]]", "[[KNOWN-PITFALLS]]", "[[BATTLE-TESTED-SCENARIOS]]", "[[GAPS-AND-DISPUTES]]"]
summary: "The canonical tools for the Database vertical: default vs alternatives, when-to-use-which, the agent-access surface (CLI/API/MCP), and the exact env vars/secrets each needs. The §Required-Secrets table feeds the Wave-P secrets manifest."
---

# acorn Tool Matrix

> For each capability: the **default**, the **alternatives**, **when to use which**, and **how an agent drives it** (CLI / API / MCP). The §Required-Secrets table at the bottom is the machine-readable feed for the **Wave-P Required-Secrets manifest** — every secret an acorn product might need, what it's for, and which tools consume it. Default stack: **Supabase + Drizzle + pgvector-HNSW/halfvec + monitored WAL/PITR**, Neon for agent-provisioned branches, Convex for realtime-first. _Source: `ecosystem-06` §5._

---

## 1. Managed Postgres platform

| | **Supabase** (default) | **Neon** (alt) | **Convex** (alt) |
|---|---|---|---|
| **When** | Multi-tenant SaaS needing Postgres+Auth+Storage+RLS+Realtime in one | Per-PR branch DBs, scale-to-zero, **agent-provisioned** DBs (>80% of Neon DBs are agent-made) | Realtime/reactive IS the product; all-TS; no need for SQL/RLS/pgvector |
| **Agent surface** | Remote MCP `mcp.supabase.com/mcp` (OAuth 2.1, **read-only at the Postgres role**); `supabase` CLI | Neon MCP (`@neondatabase/mcp-server-neon`) + `neonctl` CLI | Convex CLI + dashboard (self-host Docker/binary) |
| **Branching** | DB branches per Git branch, merge on PR | **Best-in-class** copy-on-write, ≤500ms, Time-Travel | n/a |
| **Key secrets** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` (CLI/MCP), `DATABASE_URL`/`DIRECT_URL` | `NEON_API_KEY`, `DATABASE_URL` (pooled `-pooler`), `DIRECT_URL` | `CONVEX_DEPLOYMENT`, `CONVEX_URL`; self-host: `CONVEX_INSTANCE_SECRET`, admin key |
| **Watch-out** | Self-host Docker/Storage/Auth rough (`KNOWN-PITFALLS` P28); PITR is paid add-on | Databricks-owned (roadmap tilt); cold-start on resume (P30) | No SQL/RLS/PG-extensions; self-host default-secret trap (P29); bundle lock-in |
_Source: `ecosystem-01`, `ecosystem-03`, `ecosystem-06` §1._

**Self-host MCP note:** the official Node.js reference Postgres MCP is **ARCHIVED** — use `crystaldba/postgres-mcp` or **Postgres MCP Pro** for raw-PG agent access. _Source: `ecosystem-12` §1._

## 2. ORM / query layer

| | **Drizzle 0.44+** (default) | **Prisma 7.x** (alt) | **Raw `pg`/`postgres`** (escape hatch) |
|---|---|---|---|
| **When** | Energy/Supabase-Postgres; agent reads/edits SQL; tiny edge bundle | Need MongoDB/SQLServer/CockroachDB; schema-first team; mature Studio | The hot/analytical 10%; full control |
| **Migrations** | `drizzle-kit generate`→review→`migrate` (**never `push` on shared/prod** — P20) | `prisma migrate dev/deploy`; `migrate diff` (shadow-less, for managed providers — P23) | hand-written SQL |
| **Agent surface** | `drizzle-kit` CLI; schema is plain TS files | `prisma` CLI; Prisma MCP (schema-aware) | `psql` |
| **Key secrets** | `DATABASE_URL` (pooled, `prepare:false`), `DIRECT_URL` (migrations/seeds) | `DATABASE_URL` (pooled) + `directUrl` (unpooled) — the split is **mandatory** | `DATABASE_URL` |
| **Currency** | PlanetScale-backed (2026-03-03); ~57KB bundle | **v7 (2025-11-19) removed the Rust engine** — judge on v7, reject pre-Nov-2025 benchmarks (P33) | — |
_Source: `ecosystem-05`, `field-02` §1._

**The mandatory connection-string split (both ORMs):** pooled `:6543` (`?pgbouncer=true`, `prepare:false`) for the app; **direct `:5432` for migrations/seeds/prepared-statement-heavy work.** Prisma names these `DATABASE_URL` + `directUrl`. Skipping it → `prepared statement "drizzle_s_1" already exists` (the vertical's #1 breakage — [[BATTLE-TESTED-SCENARIOS]] #11, P16). _Source: `field-02` §1._

## 3. Migration tooling (acorn's mandate — energy has no zero-downtime story)

| Tool | Role | When | Agent surface |
|---|---|---|---|
| **squawk** (default linter) | Flags AccessExclusive ops, missing `CONCURRENTLY`, missing `lock_timeout` | **Wire into acorn CI** — catches the 5 outage-makers | `squawk` CLI on `.sql` |
| **atlas migrate lint** (alt linter) | Declarative schema + destructive/lock detection in CI | Schema-as-desired-state + CI gate | `atlas` CLI |
| **pgroll** (Xata, OSS) | Zero-downtime via multi-version views (expand/contract + rollback) | 100M+ row migrations; strongest fit for the zero-downtime mandate | `pgroll` CLI |
| **pg-osc** | Online schema change for very large tables | 100M+ rows when not using pgroll | CLI |
| **Bytebase** (alt) | Migration review/governance + change history | Team governance, audit trail | web/CLI |
| ORM-native | `drizzle-kit generate` / `prisma migrate` | Day-to-day; **neither auto-applies NOT VALID/VALIDATE — hand-write it** | CLI |
_Source: `ecosystem-08` §5, `ecosystem-12` §2._ Provider caveat: managed runners may forbid `CREATE INDEX CONCURRENTLY` (can't be in a txn) — check the runner. _Source: `ecosystem-08` §7._

## 4. Database MCP servers (the agent's primary interface)

| MCP | Auth | Read-only? | When | Secrets |
|---|---|---|---|---|
| **Supabase Remote MCP** (`mcp.supabase.com/mcp`) | **OAuth 2.1** (browser) | **Yes — enforced at the Postgres role** | Inspect/dev on Supabase; feature groups `account/docs/database/debugging/development/functions/storage/branching`; `search_docs`, `get_advisors` | OAuth (no static key) or `SUPABASE_ACCESS_TOKEN` for stdio variant |
| **Neon MCP** | API key / OAuth | partial | **Provision** branch DBs, run SQL, manage branches (agent-native) | `NEON_API_KEY` |
| **crystaldba/postgres-mcp** (OSS) | DB creds (env) | restricted/read-only mode | Self-host raw-PG inspection; **you add audit logging + SSL/TLS yourself** | `DATABASE_URL` (read-only role) |
| **Postgres MCP Pro** (OSS) | DB creds | read-only, **blocks destructive ops** | Replacement for the archived Node.js reference MCP | `DATABASE_URL` |
| **Prisma MCP** | — | — | Prisma-schema-aware ops | Prisma config |
| **MintMCP / TrueFoundry** (gateways) | **SSO + SCIM RBAC** | policy-driven | **Fleets** of agents hitting many DBs; SOC2/HIPAA, audit | gateway-managed |
| **Composio** | per-app | varies | Breadth (1,000+ integrations incl. Neon/Prisma/Supabase) | `COMPOSIO_API_KEY` |
_Source: `ecosystem-12` §1, `ecosystem-01` §2._

**Security rules for ANY agent-DB-MCP access (constitutional — [[OPINIONS]] §Agent-ops):** read-only by default *at the Postgres role* (not a flippable client flag); **never connect to production** (dev/branch only); scope to one project; disable unused feature groups; **treat all extracted rows as untrusted** (prompt-injection — the lethal trifecta); fleets → a gateway for RBAC+audit, not raw per-DB creds. _Source: `ecosystem-12` §1, `field-01` §2._

## 5. CLIs an agent drives

| CLI | What | Key commands | Secrets |
|---|---|---|---|
| `psql` | Universal fallback | `\dt`, `\d+ table`, `\di`, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` | `DATABASE_URL` / `PG*` |
| `supabase` | Supabase ops | `db push/diff`, `migration new`, `branches`, **`gen types typescript`**, `db dump` | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` |
| `neonctl` | Neon ops | `projects`, `branches`, `roles`, `connection-string` | `NEON_API_KEY` |
| `drizzle-kit` | Drizzle migrations | `generate`, `migrate`, `push` (dev-only — DANGEROUS in prod), `studio` | `DATABASE_URL`+`DIRECT_URL` |
| `prisma` | Prisma migrations | `migrate dev/deploy`, `db push`, `generate`, `studio`, `migrate diff` | `DATABASE_URL`+`DIRECT_URL` |
| `pg_dump`/`pg_restore` | Dump/restore | **`--no-owner --no-acl --schema=public`** for cross-provider (avoids "role does not exist" — P, scenario #6) | `DATABASE_URL` |
| `pgbench` | Load testing | benchmark before tuning | `DATABASE_URL` |
| `pgBackRest` | Backup/restore (self-host) | full/incr/diff, validate, parallel restore | repo creds |
| `squawk` / `atlas` | Migration lint | `squawk <file.sql>` / `atlas migrate lint` | — |
_Source: `ecosystem-12` §2._ **Type generation discipline:** regenerate types after every schema change (`supabase gen types typescript` / Drizzle inferred / Prisma client) and inspect them before writing queries. _Source: `ecosystem-12` §3._

## 6. Drivers (edge vs serverful)

| Need | Driver | Connection | Note |
|---|---|---|---|
| Edge (Cloudflare Workers / Vercel Edge, no TCP) | `@neondatabase/serverless` (HTTP/WS) | Neon pooled | Works where raw TCP isn't allowed |
| Supabase serverless | `supabase-js` (PostgREST/HTTP) or transaction pooler | `:6543` | `prepare:false` (P16) |
| Serverful | `pg` (node-postgres) / `postgres` (porsager) | direct `:5432` | long-lived |
_Source: `ecosystem-12` §3._ Firewall caveat: port 5432 is often blocked outbound (corp/ISP) → use the HTTP driver or an MCP (P19). _Source: `field-02` §2._

## 7. pgvector (embeddings)

| Choice | Default | Alt | When alt |
|---|---|---|---|
| Index | **HNSW** | IVFFlat | Memory-constrained + static, bulk-loaded data |
| Type | **`halfvec`** (≥1536-dim) | `vector` / `bit`(binary) | `vector` if measured recall regression; `bit` only behind a re-rank stage |
| Scale | pgvector 0.8 | **pgvectorscale** (Timescale) | Very large vector workloads before a dedicated vector DB |
| Filtered ANN | `hnsw.iterative_scan` | partial HNSW per tenant | Big tenants |
_Source: `ecosystem-09`._ Op-class must match the query operator: `vector_cosine_ops`↔`<=>`, `vector_l2_ops`↔`<->`, `vector_ip_ops`↔`<#>`. Embedding generation happens in **app code** (OpenAI/Cohere/Voyage) → needs `OPENAI_API_KEY` (or provider equiv); the DB only stores+searches. _Source: `ecosystem-09` §7._

## 8. Backup / PITR

| Context | Tool | Note | Secrets |
|---|---|---|---|
| Self-host (default) | **pgBackRest** | full+incr+diff, parallel, validate, S3/GCS/Azure; ~500GB restore <30min | repo + object-store creds |
| Self-host (alt) | Barman | DR-focused | repo creds |
| Supabase | PITR **add-on** (Pro+) | lower tiers = daily only | — (plan setting) |
| Neon | branch-based PITR + **Time-Travel** | inspect-before-restore | `NEON_API_KEY` |
| RDS/Aurora/Cloud SQL | automated backups + PITR | ~7–35 day retention window | provider IAM |
_Source: `ecosystem-11` §2,3._ Always: monitor WAL-archive success (one missing segment breaks the chain), scheduled restore drills, explicit RPO/RTO. _Source: `ecosystem-11` §1,4._

## 9. Reference starter repos (study, don't fork low-star clones)

| Stars | Repo | Use for |
|---|---|---|
| 7,180★ | `ixartz/SaaS-Boilerplate` | **THE multi-tenant reference** (multi-tenancy + RBAC on Drizzle) — closest to Energy's default |
| 15,877★ | `nextjs/saas-starter` | Clean Postgres + Stripe + Drizzle (Vercel-official) |
| 104,020★ | `supabase/supabase` `/examples` | Authoritative "how Supabase intends X" (RLS/realtime/vector) |
| — | `npx create-next-app -e with-supabase` | Canonical Supabase+Next.js starter (not low-star forks) |
| 28,970★ | `t3-oss/create-t3-app` | Teaching baseline (Drizzle option) |
| 11,910★ | `get-convex/templates` + demos | Reactive/realtime path |
_Source: `ecosystem-07`._ Avoid 0–2★ "starter" forks (stale clones of the official examples).

---

## §Required-Secrets (feeds the Wave-P manifest)

> Every secret an acorn product might need. **Required** = needed for the default stack; **Conditional** = only if that tool/path is used. Names follow energy's `.env.example` where they already exist. **Tier-by-sensitivity is noted** — `SERVICE_ROLE`/admin keys bypass RLS and must never reach an agent's user-facing path ([[OPINIONS]] §RLS).

| Secret | Tier | Consumed by | Purpose | Required/Conditional |
|---|---|---|---|---|
| `DATABASE_URL` | high | app, Drizzle/Prisma, drivers | **Pooled** connection (`:6543`, `?pgbouncer=true`, `prepare:false`) — app hot path | **Required** |
| `DIRECT_URL` / `directUrl` | high | `drizzle-kit migrate`, `prisma migrate`, seeds | **Direct/unpooled** (`:5432`) — migrations/seeds/prepared-stmt work; the split is mandatory (P16) | **Required** |
| `SUPABASE_URL` | low | `supabase-js` | Project REST/Realtime base URL | **Required** (Supabase) |
| `SUPABASE_ANON_KEY` | low (ships in client) | `supabase-js` (client) | Public anon key — **safe ONLY if every table has RLS** (CVE-2025-48757) | **Required** (Supabase) |
| `SUPABASE_SERVICE_ROLE_KEY` | **critical — bypasses RLS** | server routes, migrations | Server-side admin; **never an agent's user-facing path**; lethal-trifecta leg | Conditional (server) |
| `SUPABASE_ACCESS_TOKEN` | high | `supabase` CLI, stdio MCP | CLI/MCP auth for `db push`/`diff`/`branches` | Conditional (CLI/MCP) |
| `SUPABASE_DB_PASSWORD` | high | `supabase db`, direct connect | DB superuser password | Conditional |
| `NEON_API_KEY` | high | `neonctl`, Neon MCP | Provision/branch/PITR; the agent-provision path | Conditional (Neon) |
| `OPENAI_API_KEY` (or Cohere/Voyage) | high | app embedding step | Generate embeddings (DB only stores/searches) | Conditional (pgvector/RAG) |
| `CONVEX_DEPLOYMENT` / `CONVEX_URL` | medium | Convex client/CLI | Convex deployment target | Conditional (Convex) |
| `CONVEX_INSTANCE_SECRET` + admin key | **critical** | self-hosted Convex | **MUST change from repo defaults** (P29) | Conditional (Convex self-host) |
| `PGBACKREST_*` / object-store creds | high | pgBackRest (self-host) | Backup repo + S3/GCS/Azure | Conditional (self-host backup) |
| `CLERK_SECRET_KEY` / Clerk JWT config | high | RLS JWT-claim tenancy | Clerk-on-Supabase: `auth.uid()::text` or `auth.jwt()->>'sub'` (P7) | Conditional (Clerk auth) |
| `COMPOSIO_API_KEY` | medium | Composio MCP gateway | Breadth aggregator for many DB integrations | Conditional (fleet) |

**Connection-string env discipline (the load-bearing config, not just a secret):**
- Pooled client: `DATABASE_URL=...:6543/...?pgbouncer=true` **+ `prepare:false`** in the driver (or `DATABASE_PREPARED_STATEMENTS=false`).
- Migrations/seeds: `DIRECT_URL=...:5432/...`.
- Serverless: set a per-instance `connection_limit` (≈1) — design for the pooler's *client* ceiling (P18).
_Source: `field-02` §1,3, `ecosystem-12` §6._

## acorn's recommended agent-DB toolbelt (one line)
**Inspect/dev:** Supabase Remote MCP (read-only role, branch-scoped) or `crystaldba/postgres-mcp` for raw PG. **Provision:** Neon MCP/`neonctl` (ephemeral branches). **Migrate:** `drizzle-kit generate` → `squawk`/`atlas` lint → review → `migrate` (never `push` on shared DBs). **Types:** regenerate+inspect after every change. **Backup:** provider API/MCP or pgBackRest — always test-restore. **Pooling:** transaction pooler (6543/neon-pooler) + `prepare:false` for serverless; direct (5432) for long-lived/migrations. _Source: `ecosystem-12` §6._
