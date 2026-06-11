---
name: harden-rls
description: Add or review row-level security / tenant isolation on Postgres/Supabase tables. Use when the ask is "add RLS", "secure this table", "review my policies", "isolate tenants", or "why can a user see another tenant's data". Encodes the 9 RLS pitfalls and the flagship rule — test as the un-privileged role, NEVER the SQL Editor.
---

# harden-rls

> **Brain source:** `brain/OPINIONS.md` §RLS · `brain/KNOWN-PITFALLS.md` §RLS (P1-P9) · `brain/BATTLE-TESTED-SCENARIOS.md` #1 (CVE-2025-48757), #3 (recursive-RLS 500), B1/B2/B3. This is acorn's **flagship** skill — most Energy products are multi-tenant SaaS on Supabase, and this is where teams bleed the most expensive failures.

## Trigger

"Add row-level security to X", "review the RLS on my schema", "tenant isolation for this table", "a user can read another org's rows", "set up Clerk + Supabase RLS".

## Steps

1. **Enable + deny-by-default.** `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;` on EVERY `public.*` table. Migration-created tables are **NOT** covered by Supabase's secure-by-default (that only covers dashboard-created tables) — the `anon` key, designed to ship in client JS, reads everything otherwise. **Lint it in CI** (`acorn rls lint`, rule P1).
2. **Two policies per tenant table:** a `service_role` gate (documentation of intent — `service_role` already bypasses RLS, so it is NOT the enforcement, P8) + the real per-tenant policy.
3. **Wrap the auth function:** `(select auth.uid())`, NEVER bare `auth.uid()` — bare is re-evaluated per row (a 5ms policy becomes 5s on 100K rows); the subselect makes the planner cache it once as an initPlan (P3).
4. **Write BOTH `USING` and `WITH CHECK`** and test INSERT/UPDATE/DELETE — `USING` filters reads, `WITH CHECK` validates writes; omit it and a user plants rows under another tenant's id (P5/B3).
5. **Index the predicate column** (`tenant_id`/`org_id`/`user_id`) — a policy on an unindexed column falls back to a seq scan (>100x slower on large tables, P4); make it first in any composite index.
6. **Clerk cast:** `(select auth.uid())::text = user_id` — `auth.uid()` is `uuid`, Clerk ids are non-uuid text; without `::text` the type mismatch silently denies every row (P7/B2).
7. **Break recursion with a `SECURITY DEFINER` helper** in a private schema for any multi-table membership check — a policy that queries a table whose own policy references back raises `infinite recursion detected in policy` at *runtime* (a user-facing 500, never caught at migrate time, P6/#3).
8. **TEST AS THE UN-PRIVILEGED ROLE.** `SET ROLE authenticated` + `request.jwt.claims` (or a real user-JWT client) — **NEVER the Supabase SQL Editor** (it runs as `postgres` and bypasses ALL RLS, so a policy "verified" there is meaningless — this exact privilege mismatch is why CVE-2025-48757 leaked 170 apps). acorn's eval pyramid enforces this.

## Output

Either (a) the gated 2-policy block for a table (`acorn rls gen <table> --tenant-col <c> --auth <clerk|supabase-jwt>` → `src/gen/rls-policy.ts`), or (b) a violation report from `acorn rls lint <file.sql>` naming each pitfall (P1-P9) with its fix. Both carry the flagship reminder to test as the un-privileged role.

## Worked example

**Ask:** *"Secure `public.tickets` so a member only sees their own org's tickets. We use Clerk."*

**acorn emits (`acorn rls gen tickets --tenant-col org_id --auth clerk`):**
```sql
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

-- (1) service_role gate: documents intent. service_role bypasses RLS, so this is NOT the enforcement (P8).
CREATE POLICY "tickets_service_role" ON public.tickets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- (2) per-tenant isolation: the real gate. Wrapped subselect = evaluated once as an initPlan (P3).
-- acorn: ::text cast is mandatory for Clerk — auth.uid() is uuid, Clerk ids are text (P7/B2).
CREATE POLICY "tickets_tenant_isolation" ON public.tickets
  FOR ALL TO authenticated
  USING (org_id = (select auth.uid())::text)
  WITH CHECK (org_id = (select auth.uid())::text);

CREATE INDEX IF NOT EXISTS tickets_org_id_idx ON public.tickets (org_id);  -- P4
```
**acorn then says:** *"Test this with `SET ROLE authenticated` + a real Clerk user's JWT claims, never the SQL Editor. Assert: user A reads only A's org rows; an `anon SELECT` returns 0; an INSERT under a foreign `org_id` is rejected by `WITH CHECK`."*

**Lint counter-example** — given a table with a bare `auth.uid()` and no `WITH CHECK`, `acorn rls lint` exits non-zero: `P3` (unwrapped `auth.uid()` → per-row re-evaluation) + `P5` (`USING` without `WITH CHECK` → cross-tenant writes), each with the receipt. (P2 is the SQL-Editor test trap — a process pitfall, not a lint-detectable one.)
