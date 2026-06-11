# Ecosystem Research — Supabase (June 2026 state of the art)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Every claim cited with URL + date.
> Internal cross-ref: energy uses Supabase in `packages/web` + root (`ecosystem-00-internal-references.md`).

## 1. Versions + last-6-months changelog deltas

- **Postgres engine on Supabase:** Supabase ships managed Postgres; current line tracks **PG15 default with PG17 available** on new projects (Supabase historically lags core by a major for stability). Confirm exact default at project-create time — Supabase upgrades the default major roughly yearly. Self-host (`supabase/postgres` Docker) tracks the same. _Source: Supabase docs guides (general knowledge, verify at <https://supabase.com/docs/guides/platform/upgrading>)._ **[FLAG — could not pin the exact June-2026 default major from a dated source; see GAPS.]**
- **Remote MCP server — GA'd Oct 3 2025.** Hosted at `https://mcp.supabase.com/mcp`; local at `http://localhost:54321/mcp`. Supports ChatGPT, Claude, Builder.io (plus the older stdio version for Cursor/Claude Code). _Source: <https://supabase.com/blog/remote-mcp-server> (2025-10-03)._
- **OAuth 2.1 token-endpoint breaking change — DATED:** Supabase's `/v1/oauth/token` returned **HTTP 201 Created**; **on May 26, 2026 it changed to HTTP 200 OK** to comply with OAuth 2.1 §3.2.3 (token endpoints MUST return 200). Returning 201 broke token exchange with strict OAuth clients. **Fix: check `response.ok` / any 2XX, never hardcode `=== 201`.** _Source: <https://supabase.com/changelog> (entry dated 2026; surfaced via Supabase Docs MCP-auth changelog)._ This is a real gotcha any agent integrating Supabase OAuth before/after that date must handle.
- **OAuth 2.1 Server (Supabase as IdP):** Supabase Auth now ships a full **OAuth 2.1 authorization server** (`/docs/guides/auth/oauth-server`) — your Supabase project can BE the OAuth provider for third-party / MCP clients, with browser-based auth, PKCE. Discussion #38022 tracked the capability. _Source: <https://supabase.com/docs/guides/auth/oauth-server> + <https://github.com/orgs/supabase/discussions/38022>._

## 2. The Remote MCP server — what an AGENT operating Supabase needs (this is the load-bearing flow for acorn)

`https://mcp.supabase.com/mcp` — OAuth2 browser flow, **no API keys to manage**. Tools organized into **feature groups**: `account`, `docs`, `database`, `debugging`, `development`, `functions`, `storage`, `branching`. Named tools incl. `search_docs` (live Supabase docs via Content API) and `get_advisors` (security + performance advisors). _Source: <https://supabase.com/blog/remote-mcp-server> (2025-10-03)._

**Security model an agent MUST respect:**
- **Read-only mode is enforced at the Postgres ROLE level** (not just a client flag) — the right way; a jailbroken prompt still can't write. Set this for any agent that should only read.
- **Project scoping** — pin the MCP to one project so a confused agent can't touch siblings.
- **Feature-group restriction** — disable e.g. `functions`/`storage` groups to shrink blast radius.
- **Coarse permissions TODAY:** OAuth2 is **all-or-nothing** — "grant *all* permissions or *none*." Fine-grained scopes are planned, not shipped (as of the Oct-2025 post). _Source: same blog._
- **Explicit warning: do NOT connect the MCP to production databases** — "designed to assist with app development." _Source: same blog._ → acorn rule: agent MCP access = dev/branch DBs only; prod mutations go through reviewed migrations + CI, never the MCP.

**Self-host MCP:** `/docs/guides/self-hosting/enable-mcp` exposes the same on a self-hosted stack. _Source: <https://supabase.com/docs/guides/self-hosting/enable-mcp>._

## 3. RLS patterns (the highest-value Supabase skill; energy already uses a subset)

Supabase = Postgres RLS is THE multi-tenant isolation mechanism. Patterns acorn should encode (energy's `002_agentdial.sql` already does #1, #2):

1. **Enable + deny-by-default:** `alter table T enable row level security;` — once enabled, NO rows are visible until a policy grants them. (energy does this.)
2. **Service-role bypass for server routes:** `create policy "svc" on T for all using (auth.role() = 'service_role');` — the service key bypasses RLS anyway, but an explicit policy documents intent. (energy's agentdial tables; energy's *memories* table is sloppier — `using(true)` with no role gate, which exposes to anon too. Standardize on the role-gated form.)
3. **Per-tenant SELECT/ALL:** `using (auth.uid() = tenant_id)` — for Supabase-Auth ids (uuid). **Clerk gotcha:** Clerk user ids are TEXT (`user_xxx`), so you need `using (auth.uid()::text = tenant_id)` OR (better, 2025+) Clerk-Supabase **native integration** that puts the Clerk id in a JWT claim you read via `auth.jwt()->>'sub'`. energy uses the `::text` cast. _Source: energy migration `002_agentdial.sql`; Supabase RLS docs <https://supabase.com/docs/guides/database/postgres/row-level-security>._
4. **`(select auth.uid())` wrapper for performance:** wrapping `auth.uid()` in a scalar subselect lets Postgres cache it once per query instead of per-row — a documented Supabase RLS perf fix for large tables. _Source: Supabase RLS performance docs <https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices>._ **acorn should bake `(select auth.uid())` into every policy template — energy does NOT do this and would slow down on big tables.**
5. **Index the RLS predicate column.** A policy on `tenant_id` is only fast if `tenant_id` is indexed. energy indexes `user_id` — good.
6. **`TO authenticated` / `TO anon` role targeting** instead of `using(true)` — scope each policy to the role that should match.
7. **Helper functions in a private schema** (`private.user_orgs()`) marked `SECURITY DEFINER` + `STABLE` for multi-table tenant checks, to avoid recursive RLS. _Source: Supabase docs._

## 4. Migrations on Supabase — workflow options (energy uses the oldest one)

- **Hand-numbered `.sql` + `supabase db push`** — what energy does (`001_…sql`…`006_…sql`). Simple, forward-only, no rollback, no diff. Fine for small teams; fragile at scale.
- **Timestamped migrations via `supabase migration new <name>`** — generates `YYYYMMDDHHMMSS_name.sql`; `supabase db diff` autogenerates the SQL from local-vs-remote schema drift. _Source: <https://supabase.com/docs/guides/deployment/database-migrations>._
- **Declarative schema (`supabase/schemas/*.sql`)** — newer: you write the DESIRED end-state schema as plain `CREATE TABLE`s; `supabase db diff` generates the migration to reach it. Closer to Atlas/Drizzle-kit declarative. _Source: <https://supabase.com/docs/guides/local-development/declarative-database-schemas>._
- **Branching (Supabase, GA):** Supabase **database branches** spin a full isolated Postgres per Git branch, run migrations on the branch, and merge to prod on PR-merge — integrates with the MCP `branching` feature group. Persistent + preview branches. _Source: <https://supabase.com/docs/guides/deployment/branching>._

**acorn recommendation (to confirm in synthesis):** move acorn's house style to **declarative schema + `supabase db diff` + branching**, keep forward-only numbered files only for data backfills. Use the MCP `branching` group so an agent develops on a branch, never prod.

## 5. Realtime

Supabase Realtime = three features: **Postgres Changes** (CDC over WAL → websocket; heavy at scale), **Broadcast** (low-latency pub/sub, the recommended default in 2025+), **Presence** (who's online). 2025 guidance shifted to **"Broadcast from the database"** (triggers → `realtime.broadcast_changes()`) instead of raw Postgres Changes for scale. _Source: <https://supabase.com/docs/guides/realtime> + <https://supabase.com/blog> realtime broadcast posts._ energy uses none of this yet (no realtime in migrations) — acorn owns the playbook.

## 6. Best Supabase starter/template repos (for §"3-5 best templates")
(See `ecosystem-07-templates-and-repos.md` for the consolidated, star-counted list — Supabase + Drizzle + Neon + Convex templates together.)

## 7. Honest trade-offs vs alts → see `ecosystem-06-tradeoff-matrix.md`.
