# Ecosystem Research — Internal References (energy Supabase patterns + checklist Database section)

> READ-ONLY mine of `~/energy`. Quoted, not edited. Captured 2026-06-11.
> Researcher: ECOSYSTEM (acorn / Database domain-expert harness, CP123 Wave-R).

## A. What energy's checklist already says about Database (audit/HARNESS-CHECKLIST-2026.md lines 66, 267-271)

Verbatim (line 269-271):

> **Default:** **Supabase** (Postgres) — used by spark, alpha, naman-finance.
> **Alt:** **Neon** (serverless edge; post-Databricks-acq pricing −15–25% compute / −80% storage <https://www.databricks.com/blog/databricks-neon>); **Convex** (open-source, reactive, self-hostable <https://github.com/get-convex/convex-backend>).
> **Rule:** never `new Map()` for cross-request state in Vercel routes — Supabase or Upstash KV. **2026:** Supabase ships a **remote MCP** (`mcp.supabase.com`, OAuth 2.1). _Source: `CLAUDE.md` Tech Stack; `typescript.md`; `the_complete_story.md` 2566._

Line 66 (C1 product-shell checklist): `**Database** — Supabase (Postgres) default; Neon / Convex alts`
Line 79/342: object storage GAP — Supabase Storage listed as one alt to Cloudflare R2.
Line 390 (adoption table): `Product · C1 shell | Backend / DB / Auth | ✅ adopted (TS/Node · Supabase · Clerk)`.

This research file gives acorn its own evidence base to confirm/extend those one-liners with June-2026 currency.

## B. energy's actual migration patterns (the load-bearing ones acorn should encode as house style)

Source files (READ-ONLY):
- `~/energy/supabase/migrations/001_user_memories.sql`
- `~/energy/packages/web/supabase/migrations/{001_consent_grants,002_agentdial,003_agentdial_stripe,004_agentdial_messages,005_agentdial_thread_state}.sql`
- `~/energy/supabase/migrations/006_agentdial_health.sql`

Patterns observed (quote-level), each with the rationale energy embedded in the SQL comments:

### B1. UUID PK + `gen_random_uuid()` default
`id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — pgcrypto/built-in (PG13+ has `gen_random_uuid()` in core, no extension needed). Used on EVERY table. Note for acorn: PG17 still ships `gen_random_uuid()`; UUIDv7 (time-ordered, better index locality) is a 2025+ option to flag — see external research.

### B2. Tenant key is `user_id TEXT` (Clerk user id is a string, not a uuid)
`user_id TEXT NOT NULL` — they store Clerk's `user_xxx` id as text and compare RLS with `auth.uid()::text = user_id`. This is the multi-tenant isolation key. The `::text` cast is load-bearing: `auth.uid()` returns uuid, Clerk id is text — without the cast the policy silently never matches. (acorn: this is a real gotcha to document — Clerk-on-Supabase RLS.)

### B3. RLS dual-policy: service-role bypass + per-user SELECT
```sql
alter table agentdial_agents enable row level security;
-- server-side API routes use the service key, bypass RLS:
create policy "Service role full access on agents" on agentdial_agents
  for all using (auth.role() = 'service_role');
-- end users (anon/authenticated key) can only see their own rows:
create policy "Users view own agents" on agentdial_agents
  for select using (auth.uid()::text = user_id);
```
Their `001_user_memories.sql` uses a BLUNTER variant — `for all using (true) with check (true)` labelled "Service role full access" — which is effectively RLS-off for everyone (anon included) because there's no role gate. This is an energy inconsistency worth flagging: the agentdial tables gate on `auth.role() = 'service_role'`, the memories table does NOT. acorn should standardize on the agentdial pattern (gate every permissive policy on `service_role`).

### B4. `jsonb` for flexible per-channel/credential blobs
`credentials jsonb not null default '{}'` — they keep variable-shape per-channel secrets in jsonb rather than EAV or wide tables. Sane default; acorn should note jsonb + a GIN index when querying inside it, and `jsonb` vs `json` (always jsonb for indexing).

### B5. Composite unique constraints for natural tenant keys
`constraint agentdial_credentials_user_channel_unique unique (user_id, channel)` and `UNIQUE(user_id, key)` on memories — natural composite keys per tenant. Plus a matching index `(user_id, channel)` for the hot lookup.

### B6. `updated_at` via a trigger function, NOT app code
```sql
create or replace function update_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
create trigger user_memories_updated_at before update on user_memories
  for each row execute function update_updated_at();
```
Note: energy defines this SAME function under two names (`update_updated_at` and `update_agentdial_updated_at`) in different migration files — duplicate logic. acorn should define ONE shared `moddatetime`-style function (or use the `moddatetime` extension Supabase ships) and reuse it. This is a concrete consolidation win.

### B7. Full-text search via generated `to_tsvector` GIN index
```sql
create index idx_user_memories_search on user_memories
  using gin(to_tsvector('english', key || ' ' || value));
```
Functional GIN index (not a stored generated column). For PG12+ a STORED generated `tsvector` column + GIN is the more modern pattern (index stays valid, planner uses it more reliably). acorn should flag the generated-column upgrade.

### B8. `CHECK` constraints for enums-in-text
`source TEXT NOT NULL CHECK (source IN ('observed','told','inferred'))` and `status text not null default 'pending'`. They use text+CHECK rather than native PG enums (avoids the "can't drop enum value" migration pain). Good default — document the trade-off (CHECK is easier to migrate than `CREATE TYPE ... AS ENUM`).

### B9. `if not exists` everywhere + "run in SQL Editor or `supabase db push`"
Every object is `create ... if not exists`. The header comment says "Run this in your Supabase SQL Editor or via `supabase db push`." So energy's migration workflow is: plain numbered `.sql` files (`001_`, `002_`…) applied by `supabase db push` (or hand-run). NO down-migrations, NO declarative schema (`supabase/schemas/`), NO `supabase migration new` timestamped names. acorn's research should compare this hand-numbered style against Supabase's newer declarative-schema + timestamped-migration workflow and the "migra"/diff approach.

## C. energy migration-workflow GAPS acorn research must answer (turn into house rules)

1. **No down/rollback migrations.** energy relies on forward-only + `if not exists`. Need a zero-downtime + rollback playbook (expand/contract).
2. **Two `updated_at` trigger fns with different names.** Consolidate to one (or `moddatetime`).
3. **Inconsistent RLS** (memories table `using(true)` vs agentdial `service_role` gate). Standardize.
4. **Functional FTS index** vs **STORED generated tsvector column.** Pick the modern one.
5. **Hand-numbered migrations** (`00N_name.sql`) vs **timestamped + declarative schema.** Decide acorn's canonical workflow.
6. **No pgvector anywhere yet** in energy migrations — acorn is the DB expert, must own the embeddings-storage playbook.
7. **No PITR / backup story** in any migration file — acorn must own backup/restore.

These 7 are the bridge from "energy does X today" to "acorn (the DB domain expert) recommends Y in June 2026." External files ecosystem-01..09 fill them with cited, current sources.
