---
name: design-multitenant-schema
description: Design the schema / data model for a multi-tenant product. Use when the ask is "design a schema", "model this product's data", "what tables do we need", or "how should we structure the database for tenant X". Encodes acorn's tenancy decision tree + column house-style.
---

# design-multitenant-schema

> **Brain source:** `brain/OPINIONS.md` §Schema design + §Platform selection · `brain/EXPERTISE-MAP.md` JTBD 1 · `brain/GAPS-AND-DISPUTES.md` DISPUTE 1 (PK type). This skill is the runnable form of those stances — it states a default and *names the dispute*, it does not fake-resolve.

## Trigger

The user (or a sibling agent) asks acorn to design / model the data layer of a multi-tenant product: "design a schema for a helpdesk", "model orgs → members → tickets", "what's the data model for this SaaS".

## Steps

1. **Decide tenancy (the first decision — everything inherits it).** Run the decision tree (`src/gen/tenancy.ts`):
   - **shared-schema + `tenant_id` + RLS** → the **default** for 10k–100k+ tenants (the model energy already uses). One schema, one migration, isolation enforced by RLS.
   - **schema-per-tenant** → only 10–500 high-value/customizable tenants (migrations fan out N times).
   - **database-per-tenant** → only a few *regulated*/data-residency tenants (connection pooling breaks immediately — PgBouncer pools are per `(db,user)`).
   - **NEVER multi-tenant by table-prefix** — even Convex abandoned it ("messy abstractions and performance bottlenecks"). State this if the user proposes it.
2. **Apply the column house-style** on every tenant table:
   - **PK:** `uuidv7()` *if the provider has shipped it* (feature-detect — Supabase is still PG17, no native `uuidv7`) else `gen_random_uuid()` with a noted upgrade path. **NEVER UUIDv4 on a high-insert table as a settled choice** (it fragments the B-tree); the bigint-vs-uuidv7 split itself is *open* → name it, don't pretend.
   - **Enum-like columns:** `text` + `CHECK (... IN (...))`, NEVER native `CREATE TYPE ... AS ENUM` for anything that might change (you can't drop/reorder an enum value; also dodges `drizzle-kit` enum pain).
   - **Variable-shape blobs:** `jsonb` (binary, GIN-indexable), NEVER `json` — and don't reach for `jsonb` to dodge schema design.
   - **`updated_at`:** ONE shared `moddatetime`/trigger fn reused across tables (energy's bug: two duplicate-named ones).
   - **Composite uniqueness:** `(tenant_id, natural_key)` with `tenant_id` first in every composite index (so RLS predicates on it stay fast).
3. **Emit migrations + the gated RLS block** for each tenant table (hand off to `harden-rls`).
4. **State the dispute, not a fake winner** — if the PK type or RLS-depth is genuinely a coin-flip for this workload, say so and give the decision rule (`brain/GAPS-AND-DISPUTES.md`).

## Output

A migration scaffold (`CREATE TABLE` statements with the house-style columns) + a one-paragraph tenancy decision with its rationale + a pointer to run `harden-rls` for the policies. The decision tree is also a pure function: `decideTenancy({ tenants, regulated })` → `{ model, rationale, notes }`.

## Worked example

**Ask:** *"Design a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages. ~10k orgs expected."*

**acorn's design:**
- **Tenancy:** ~10k tenants → **shared-schema + `org_id` + RLS** (`decideTenancy({ tenants: 10000 })` → `shared-schema-rls`). Schema-per-tenant rejected (stops scaling past hundreds); DB-per-tenant rejected (no regulatory driver; pooling would break).
- **Tables (house-style):**
  ```sql
  CREATE TABLE public.orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- acorn: feature-detect uuidv7() at provision; gen_random_uuid() is the PG<18 fallback
    name text NOT NULL,
    plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),  -- text+CHECK, not a PG enum
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.orgs(id),
    subject text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX tickets_org_subject_idx ON public.tickets (org_id, subject);  -- (tenant_id, natural_key), org_id first
  ```
- **Dispute named:** for `tickets` (high write), bigint-identity would give marginally better locality than uuidv7 — but the global-id benefit + the agent-friendly opacity of uuidv7 wins here. acorn defaults uuidv7-when-available and flags the split rather than claiming it settled.
- **Next:** run `harden-rls` to emit the gated 2-policy block on `orgs`/`tickets`/`messages`, then `zero-downtime-migration` to ship it safely.
