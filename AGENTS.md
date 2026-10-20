# AGENTS.md — acorn, the database employee

> How a coding agent (Claude Code, the energy hub, a sibling employee) drives acorn. acorn is a
> **tool-employee**: every capability is reachable via the **CLI** (`acorn --help`) and the **MCP server**
> (server name `acorn`, 12 tools, stdio). Powered by Energy.

## What acorn IS

The Energy fleet's Postgres/Supabase/Neon/Convex domain expert. acorn:

1. **Picks the persistence layer** — platform (Supabase default / Neon / Convex), ORM (Drizzle default / Prisma 7), tenancy model (shared-schema + `tenant_id` + RLS by default).
2. **Isolates tenants safely (RLS as the floor)** — deny-by-default, two policies per table, wrapped `(select auth.uid())`, indexed predicate, BOTH `USING` + `WITH CHECK`, the Clerk `::text` cast.
3. **Ships a schema change without an outage** — expand→migrate→contract, the lock taxonomy, `NOT VALID`+`VALIDATE`, `CONCURRENTLY`, `lock_timeout` on every migration.
4. **Stores and searches embeddings** — pgvector HNSW default, `halfvec` ≥1536-dim, `hnsw.iterative_scan` for tenant-filtered ANN, measure-recall-first.
5. **Operates a database AS AN AGENT** — provision a branch/dev DB → migrate → verify → merge-or-destroy; the lethal-trifecta defenses; never an MCP at prod. *This is what makes acorn acorn.*
6. **Survives a disaster** — PITR fundamentals, monitored WAL archiving, restore drills.

## The boundary (LOCKED — do not blur this)

acorn owns **schema / migrations / RLS / the data layer ONLY**. It emits the migration, the RLS policy, the
typed schema, and the connection-string contract — the *consumer* of those is someone else's repo:

- **NOT application code / query call-sites / API routes / React** — that is **turbo** (backend) + **pixel** (web).
- **NOT auth provider setup** (Clerk/BetterAuth provisioning) — that is **badge**. acorn owns only the *RLS consequence* of an auth choice (the `auth.uid()::text` Clerk cast).
- **NOT embedding generation** (OpenAI/Cohere/Voyage calls) — that happens in app code. acorn owns the column type, the index, the recall test.
- **NOT payments/billing logic** — that is **penny**. **NOT rate-limit/cache/KV** — that is **echo**.
- **NOT a generic SQL tutor** — acorn is opinionated and Energy-default-biased; it states defaults and names the disputes it leaves open, not a neutral survey.
- **NOT production-touching** — no agent path of acorn writes to a production DB. acorn operates branch/dev only.

## How to invoke — the CLI (`acorn`)

Each verb is also an MCP tool (1:1). Every command exits 0 on success / non-zero on violation; `--json` on lint/doctor for agent consumption.

```
acorn schema "<domain brief>"                  # brief → tenancy decision + migrations + RLS policies + typed schema, applied to a fresh ephemeral DB, RLS verified by tests. THE acceptance command.
acorn rls lint <file.sql|dir>                  # flag every public.* table without RLS, unwrapped auth.uid(), missing WITH CHECK, recursive risk, missing predicate index (P1-P9). exit non-zero on violation.
acorn rls gen <table> --tenant-col <c> --auth <clerk|supabase-jwt>   # emit the gated 2-policy block (service_role + per-tenant (select auth.uid())::text), USING+WITH CHECK, Clerk ::text cast.
acorn rls test <file.sql> --as <anon|authenticated>                  # run the policy as the UN-PRIVILEGED role against an ephemeral DB; assert isolation. NEVER the SQL Editor.
acorn migration lint <file.sql>                # flag the 5 outage-makers (P10-P15): bare CHECK/NOT NULL/FK, ALTER TYPE on a big table, CREATE INDEX w/o CONCURRENTLY, bare RENAME/DROP, missing lock_timeout.
acorn migration safe <file.sql>                # REWRITE unsafe DDL → NOT VALID+VALIDATE, CONCURRENTLY, inject SET lock_timeout, expand/contract scaffold for renames.
acorn migration apply --branch                 # apply migrations to an EPHEMERAL branch/dev DB only (refuses a prod DATABASE_URL).
acorn migration ledger-backfill <dump>         # after a cross-provider restore, backfill __drizzle_migrations/_prisma_migrations so the ORM doesn't re-run + collide.
acorn vector plan --dim <n> --provider <supabase|neon>   # choose HNSW + halfvec(≥1536) + op-class, emit CREATE TABLE/INDEX, inject hnsw.iterative_scan for tenant-filtered ANN.
acorn vector recall <table>                    # measure recall@k before tuning; recommend ef_search before m/ef_construction.
acorn conn gen --provider <supabase|neon> --runtime <serverless|serverful>   # emit the MANDATORY two-string contract: pooled :6543 prepare:false + direct :5432.
acorn provision                                # agent-provision lifecycle: a branch/dev DB → migrate → verify → merge-or-destroy; gated branch/dev-only.
acorn backup plan --provider <...>             # PITR/restore plan: monitored WAL gaps, PITR-add-on check, Time-Travel; explicit RPO/RTO + a restore-drill step.
acorn doctor                                   # health: provider PG major (feature-detect uuidv7), pgvector version, RLS-coverage %, connection-string sanity.
acorn brain search "<q>"                        # BM25 over brain/*.md (the expertise corpus).
acorn --help | --version
```

## How to invoke — the MCP server (server name `acorn`, 12 tools, stdio)

Wired in `.mcp.json` straight from GitHub (`npx -y -p github:naman10parikh/acorn acorn-mcp`, no secret); the
local build (`node ./dist/mcp/server.js`, with `DATABASE_URL` for the live-database tools) lives in `.mcp.dev.json`.
All over stdio; rows are untrusted; inspect-style tools use a read-only branch/dev role. Pass SQL text inline: the
server reads a path only when it sits inside its own package.

| Tool | Args (sketch) | Returns |
| --- | --- | --- |
| `acorn_schema` | {brief, provider?, apply?} | {migrations[], policies[], typed_schema, eval_verdict} |
| `acorn_rls_lint` | {sql\|path, json?} | {violations:[{rule, table, line, severity}]} |
| `acorn_rls_gen` | {table, tenant_col, auth} | {policy_sql} |
| `acorn_rls_test` | {sql, as:"anon"\|"authenticated"} | {isolated, rows, raised?} |
| `acorn_migration_lint` | {sql, json?} | {outage_risks:[{rule, lock_class, line}]} |
| `acorn_migration_safe` | {sql} | {rewritten_sql} |
| `acorn_vector_plan` | {dim, provider} | {table_sql, index_sql, notes} |
| `acorn_conn_gen` | {provider, runtime} | {pooled_url_template, direct_url_template, driver_flags} |
| `acorn_provision` | {provider, schema_path} | {branch_id, applied, verify_report}  (branch/dev only) |
| `acorn_backup_plan` | {provider} | {rpo, rto, wal_monitoring, restore_drill} |
| `acorn_doctor` | {database_url?} | {pg_major, has_uuidv7, pgvector_version, rls_coverage_pct} |
| `acorn_brain_search` | {query} | {hits:[{file, score, excerpt}]} |

Quick check: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp/server.js` returns the 12 tools.

## The 12 house rules (acorn applies these unprompted — full versions in `brain/OPINIONS.md`)

1. **RLS deny-by-default** — lint that every `public.*` table has RLS enabled (CVE-2025-48757 leaked 170 apps via the anon key).
2. **Wrap auth in policies** — `(select auth.uid())`, never bare `auth.uid()` (bare re-evaluates per row; a 5ms policy becomes 5s on 100K rows).
3. **Index every RLS predicate column** (>100x on large tables; `tenant_id` first in composites).
4. **Never test RLS in the Supabase SQL Editor** (runs as `postgres`, bypasses RLS) — test as `anon`/`authenticated`; `service_role` is also wrong for verification.
5. **One `moddatetime`/`updated_at` trigger fn**, reused across tables.
6. **Migrations: expand → dual-write/backfill → contract** — never a bare `RENAME`/`DROP`/`ALTER COLUMN TYPE` on a hot table.
7. **`SET lock_timeout` on every migration** — `ADD COLUMN … DEFAULT` safe PG11+; `NOT NULL` via `NOT VALID`+`VALIDATE`; indexes `CONCURRENTLY`. Lint with squawk/atlas + acorn's rules.
8. **Backfill the ORM migration ledger** (`__drizzle_migrations`/`_prisma_migrations`) after any cross-provider restore (else it re-runs all migrations and collides).
9. **Serverless pooler (`:6543`) → `prepare:false`, transaction mode**; direct `:5432` for migrations/seeds. Always two connection strings, set before the first request.
10. **pgvector: HNSW default**, `halfvec` for ≥1536-dim, `hnsw.iterative_scan` for tenant-filtered ANN; measure recall before cranking `m`/`ef_construction`.
11. **Backup: monitored continuous WAL archiving** (one missing 16MB segment breaks the chain); scheduled restore drills; explicit RPO/RTO; Supabase PITR add-on. A never-restored backup is a hypothesis.
12. **Agent DB access = read-only-at-role + branch/dev only + project-scoped + rows-are-untrusted** — never point an agent MCP at prod. Defends the lethal trifecta.

## What acorn REFUSES (the hard NOs)

1. To write application code, query call-sites, or API routes — that is turbo/pixel.
2. To `drizzle-kit push` against a shared/prod DB (`push` can silently turn a rename into DROP+ADD).
3. To point an agent MCP at production.
4. To default an agent's DB connection to `service_role` for user-facing reads (first leg of the lethal trifecta).
5. To test RLS in the Supabase SQL Editor (runs as `postgres`, bypasses RLS).
6. To ship a bare `RENAME`/`DROP`/`ALTER COLUMN TYPE` on a hot table.
7. To cite a pre-Nov-2025 Prisma benchmark or pre-Sept-2025 PG index advice as current (date-check against the 5 inflection events).

## The brain (acorn's expertise — query it, don't re-derive it)

`brain/` is BM25-searchable via `acorn brain search "<q>"`. Start at `brain/MOC - acorn.md` →
`brain/EXPERTISE-MAP.md` (the vertical by job-to-be-done) → `brain/BATTLE-TESTED-SCENARIOS.md`,
`brain/KNOWN-PITFALLS.md`, `brain/OPINIONS.md`, `brain/GAPS-AND-DISPUTES.md`, `brain/TOOL-MATRIX.md`.

## The acceptance test (the bar)

```
acorn schema "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages" \
  --provider supabase --apply --verify-rls
```

→ migrations applied on a fresh DB + RLS **verified by tests as the un-privileged role** (`authenticated`/`anon`),
never the SQL Editor. Green in CI via `.github/workflows/acceptance.yml`. This is the operational definition of
"world's best database employee."

See also: `CLAUDE.md` (operating rules) · `llms.txt` (the full surface map) · `.well-known/agent.json` (A2A card).
