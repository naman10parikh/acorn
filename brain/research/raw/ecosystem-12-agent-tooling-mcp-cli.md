# Ecosystem Research — What an AGENT (not a human) Operating Databases Needs (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.
> The brief's most acorn-specific ask: the CLIs/APIs/MCP servers an agent uses to operate these tools.

## 1. Database MCP servers (the agent's primary interface in 2026)
MCP servers expose tools like `list_projects`, `get_database_tables`, `run_sql` so an agent can "dump tables straight into JSON without ever opening a Postgres connection." _Source: <https://www.mintmcp.com/blog/mcp-gateways-postgresql-integration>; <https://www.closefuture.io/blogs/neon-vs-supabase>._

| MCP server | Auth | Tools (named) | Read-only? | Notes |
|---|---|---|---|---|
| **Supabase Remote MCP** (`mcp.supabase.com/mcp`) | **OAuth 2.1** (browser) | feature groups `account/docs/database/debugging/development/functions/storage/branching`; incl. `search_docs`, `get_advisors` | **Yes — enforced at Postgres ROLE level** | GA'd 2025-10-03; all-or-nothing OAuth scopes today; **do NOT point at prod**. _Source: <https://supabase.com/blog/remote-mcp-server>_ |
| **Neon MCP** (`@neondatabase/mcp-server-neon`, hosted variant) | API key / OAuth | create/list projects, run SQL, **manage branches** | partial (per design) | Pairs with ">80% of Neon DBs are agent-provisioned" — built for agents. "Neon's MCP for read-out, Supabase's MCP for write-in." _Source: closefuture; venturebeat_ |
| **crystaldba/postgres-mcp** (OSS, Docker) | DB creds via **env vars** | run SQL, schema introspection, table listing | **restricted/read-only mode** | self-managed; **you must add audit logging + SSL/TLS yourself**. _Source: mintmcp_ |
| **Postgres MCP Pro** (OSS) | DB creds | schema introspection, table listing, query exec | read-only enforced, **blocks destructive ops** | replacement for the **archived Node.js reference Postgres MCP**. _Source: mintmcp_ |
| **Prisma MCP** | — | Prisma-schema-aware ops, manages Prisma Postgres | — | ships with Prisma tooling (2025+) |
| **MintMCP / TrueFoundry (gateways)** | **SSO + SCIM RBAC** | tool-level allowlisting, read-only policy, write-tool blocking | policy-driven | enterprise: SOC2 Type II, HIPAA, pen-tested. For fleets of agents hitting many DBs. _Source: mintmcp_ |
| **Composio** | per-app | 1,000+ integrations incl. Neon/Prisma/Supabase | varies | breadth aggregator. _Source: closefuture_ |

**The official reference Postgres MCP (Node.js) is ARCHIVED** — use `crystaldba/postgres-mcp` or Postgres MCP Pro instead. _Source: mintmcp._

### Security rules for agent-DB-MCP access (acorn must encode)
1. **Read-only by default**, enforced at the **Postgres role** (not a client flag a jailbroken prompt can flip).
2. **Never connect an agent MCP to production** — dev/branch DBs only; prod mutations go through reviewed migrations + CI.
3. **Scope to one project**; disable unused feature groups (shrink blast radius).
4. **Treat extracted rows as untrusted** (prompt-injection from data) — same rule as energy's `browser-agent-security.md` Rule 2.
5. For fleets → a **gateway** (MintMCP/TrueFoundry) for RBAC + audit, not raw per-DB creds in each agent.

## 2. CLIs an agent drives
- **`psql`** — universal; `\dt`, `\d+ table`, `\di`, `EXPLAIN (ANALYZE, BUFFERS)`. The fallback when no MCP.
- **`supabase`** CLI — `db push`, `db diff`, `migration new`, `branches`, `gen types typescript` (generates TS types from schema — huge for agent type-safety), `db dump`.
- **`neonctl`** — projects, branches, roles, `connection-string`.
- **`pg_dump` / `pg_restore`** — see §4 migration realities below.
- **`drizzle-kit`** — `generate` (SQL from schema), `migrate` (apply), `push` (dev-only diff-apply — DANGEROUS in prod), `studio`.
- **`prisma`** — `migrate dev/deploy`, `db push`, `generate`, `studio`, `migrate diff` (shadow-less drift).
- **`pgbench`** — load testing. **`pgBackRest`** — backup/restore (self-host).
- Lint: **`squawk`** (migration linter), **`atlas migrate lint`** (destructive/lock detector) — wire into acorn CI.

## 3. APIs / drivers an agent picks (edge vs serverful)
- **Serverless/edge:** Neon `@neondatabase/serverless` (HTTP + WebSocket — works on Cloudflare Workers/Vercel Edge where TCP isn't allowed); Supabase `supabase-js` (PostgREST over HTTP) or the **transaction pooler (6543)** for raw SQL.
- **Serverful:** `pg` (node-postgres) / `postgres` (porsager) over the **direct/session connection (5432)**.
- **Type generation:** `supabase gen types typescript` or Drizzle's inferred types or Prisma's generated client — an agent should regenerate types after every schema change and inspect them before writing queries.

## 4. ⚠️ Real operational gotchas from a PRODUCTION Neon→Supabase migration (cite — these are the anti-slop receipts)
_Source: <https://dev.to/blackie360/migrating-from-neon-to-supabase-postgres-drizzle-in-production-4ekh> (Next.js + Drizzle + Better Auth, ~1 hr cutover)._
1. **Transaction pooler (`:6543`) does NOT support named prepared statements** → error **`prepared statement "drizzle_s_1" already exists`**. **Fix: disable prepared statements** in the driver (`prepare: false` / `DATABASE_PREPARED_STATEMENTS=false`). This bites EVERY ORM behind Supabase/PgBouncer transaction pooling. _(Directly relevant: any acorn product on the 6543 pooler must set `prepare: false`.)_
2. **Port 5432 is often blocked by corporate firewalls** (outbound) → use the HTTP serverless driver or an MCP for inspection instead of a raw TCP connection.
3. **`pg_dump` role/ACL conflicts** → use **`pg_dump --no-owner --no-acl --schema=public`** to restore cleanly into a different provider (avoids "role does not exist" on restore).
4. **The migration-ledger trap:** after a data restore, the ORM's migration-history table (Drizzle `__drizzle_migrations`, Prisma `_prisma_migrations`) is **EMPTY** → the app **re-runs ALL migrations** and collides on already-existing types/tables. **Fix: backfill the ledger** (insert the migration ids/hashes/timestamps from source). This is the single most-missed step in cross-provider migrations.
5. **Keep the OLD provider live for ~7 days post-cutover** — they discovered **forgotten cron jobs + webhooks** still pointing at Neon. Cutover ≠ done.
6. Cutover steps that worked: freeze writes → dump/restore → backfill ledger → swap `DATABASE_URL` in Vercel → redeploy → watch old DB 7 days.

## 5. The "agent provisions its own DB" pattern (the 2026 shift)
- **>80% of Neon databases are created by AI agents** (not humans) → the industry is building for agent-driven provisioning. _Source: venturebeat / databricks._
- Pattern: agent calls Neon MCP/API → spins an isolated branch/project in ≤500 ms → runs migrations → does work → tears down or merges. acorn should support this lifecycle (provision-branch → migrate → verify → merge/destroy) as a first-class skill, gated so the agent only ever touches branch/dev DBs, never prod directly.

## 6. acorn's agent-DB toolbelt (recommended default)
- **Inspect/dev:** Supabase Remote MCP (read-only role, branch-scoped) OR `crystaldba/postgres-mcp` (self-host, restricted) for raw PG.
- **Provision:** Neon MCP/`neonctl` for ephemeral branch DBs.
- **Migrate:** `drizzle-kit generate` → `squawk`/`atlas` lint → human/CI review → `migrate` (never `push` on shared DBs).
- **Types:** regenerate + inspect after every schema change.
- **Backup/restore:** provider API/MCP (managed) or `pgBackRest` (self-host); always test-restore.
- **Pooling:** transaction pooler (6543/neon-pooler) + `prepare:false` for serverless; direct (5432) for long-lived.
