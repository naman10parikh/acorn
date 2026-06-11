# Ecosystem Research — Zero-Downtime Migration Playbook (Postgres, June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.
> energy has NO rollback/zero-downtime story today (forward-only numbered SQL) — acorn OWNS this.

## 1. The core pattern: Expand → Migrate → Contract (a.k.a. "parallel change")
Decompose every breaking change into 3 independently-shippable, reversible phases:
1. **Expand** — ADD new columns/tables alongside old. Never drop, never rename. Old + new coexist. App not yet writing new cols; a trigger/background job starts populating. _Source: <https://dev.to/jp_fontenele4321/the-expand-and-contract-pattern-for-zero-downtime-migrations-445m>; <https://systemdr.systemdrd.com/p/database-schema-migrations-with-zero>._
2. **Migrate (dual-write + backfill)** — deploy app that **writes BOTH old and new**; backfill history in **batches of 1,000–10,000 rows with a deliberate sleep between batches** to spare I/O. New schema never falls behind. _Source: same._
3. **Contract** — once new cols verified-full AND old code drained, DROP old column. `DROP COLUMN` is **metadata-only (ms)** on modern PG regardless of table size. _Source: same._

A column **rename** = expand (add new) + dual-write + backfill + contract (drop old). NEVER a bare `ALTER ... RENAME` in prod (breaks the old app version mid-deploy).

## 2. Lock taxonomy — the operations that take ACCESS EXCLUSIVE (block ALL reads+writes)
> "any ALTER TABLE statements will require the ACCESS EXCLUSIVE lock which conflicts with all other lock types." _Source: <https://xata.io/blog/zero-downtime-schema-migrations-postgresql>._

**Dangerous (AccessExclusive — can cause an outage if the table is hot):**
- `ALTER TABLE ... ADD COLUMN ... NOT NULL` WITHOUT a default (pre-PG11 also rewrote with default).
- `ALTER TABLE ... ALTER COLUMN TYPE` (table rewrite + AccessExclusive — the classic outage maker).
- `ALTER TABLE ... ADD CONSTRAINT ... (CHECK/FK)` validated immediately (scans whole table under lock).
- `CREATE INDEX` (non-concurrent) — AccessExclusive for the duration.
- `ALTER TABLE ... SET NOT NULL` directly (full scan under lock pre-PG12 trick).

**Safe / fast:**
- `ALTER TABLE ... ADD COLUMN x text DEFAULT 'active'` — **PG11+: NO table rewrite** (default stored in catalog), fast metadata op, brief lock. _Source: dev.to/mickelsamuel "5 PostgreSQL Migration Mistakes"._
- `DROP COLUMN` — metadata-only, ms.
- `CREATE INDEX CONCURRENTLY` — no AccessExclusive; doesn't block writes (but: runs outside a txn, can leave an INVALID index on failure → must `DROP` + retry; can't be in a transaction block, which trips some migration tools).

## 3. The two version-specific tricks every migration tool forgets
### 3a. Safe NOT NULL (the `NOT VALID` + `VALIDATE` two-step)
Instead of `SET NOT NULL` (full scan under AccessExclusive):
```sql
-- step 1: add a CHECK that new rows must satisfy, but DON'T scan existing rows
ALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;
-- step 2: validate existing rows under a WEAKER (ShareUpdateExclusive) lock — reads/writes continue
ALTER TABLE users VALIDATE CONSTRAINT users_email_nn;
-- (PG12+) you can then SET NOT NULL cheaply because the validated CHECK proves it
ALTER TABLE users ALTER COLUMN email SET NOT NULL;  -- PG12+ uses the constraint, skips the scan
```
PG12+ recognizes the validated CHECK and **skips the full scan** when you finally `SET NOT NULL`. _Source: dev.to/mickelsamuel; oneuptime 2026-01-25._

### 3b. Safe FK add (same NOT VALID/VALIDATE shape)
```sql
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT fk_user;  -- separate, non-blocking-ish step
```

## 4. Lock-timeout discipline (the rule that prevents the outage)
**Set `lock_timeout` (and a short `statement_timeout`) on EVERY migration** so a migration that can't get its lock **fails fast instead of queuing behind a long query and freezing the table** (a waiting AccessExclusive also blocks every query behind it):
```sql
SET lock_timeout = '3s';
SET statement_timeout = '0';  -- or a sane cap
ALTER TABLE ...;
```
> "make migrations fail early instead of locking the DB for a long time and causing an outage." _Source: search corpus, getdefacto + lob.com migration posts._
The human-factor gotcha: "a developer who writes migrations twice a month is unlikely to remember the NOT VALID + VALIDATE pattern or the lock_timeout requirement every time" → **automate it in the harness** (this is acorn's job: a migration linter/template that injects lock_timeout + flags AccessExclusive ops). _Source: same._

## 5. Tooling
- **pgroll** (Xata, OSS) — applies schema changes by **serving multiple schema versions simultaneously** via views, so app instances on old+new schema both work during rollout; changes applied without locking; built-in expand/contract + rollback. Strong fit for acorn's zero-downtime mandate. _Source: <https://xata.io/blog/zero-downtime-schema-migrations-postgresql>; github.com/xataio/pgroll._
- **Bytebase** — migration review/governance + change history. _Source: <https://www.bytebase.com/blog/postgres-schema-migration-without-downtime/>._
- **Atlas (ariga)** — declarative schema + lint that DETECTS destructive/locking ops in CI (`atlas migrate lint`).
- **squawk** — a Postgres-migration LINTER (flags AccessExclusive, missing CONCURRENTLY, etc.) — perfect to wire into acorn's CI.
- ORM-native: Drizzle `generate`→edit `.sql`; Prisma `migrate` (shadow DB drift detection). Neither auto-applies the NOT VALID trick — you hand-write it.

## 6. The 5 outage-causing mistakes (checklist acorn lints against)
1. Adding `NOT NULL` without the NOT VALID/VALIDATE two-step.
2. `ALTER COLUMN TYPE` on a big hot table (rewrite under AccessExclusive).
3. `CREATE INDEX` without `CONCURRENTLY`.
4. Bare `RENAME`/`DROP` that breaks the still-running old app version (skipping expand/contract).
5. No `lock_timeout` → the migration's lock request queues and freezes every query behind it.
_Source: <https://dev.to/mickelsamuel/the-5-postgresql-migration-mistakes-that-cause-production-outages-ngg>._

## 7. Provider notes
- **Supabase branching** lets you run + verify the migration on an isolated branch DB before merge (de-risks step 1-2).
- **Neon** branching = test the migration on a copy-on-write branch of prod data, then apply to main; instant rollback = point main at the pre-migration branch.
- **Managed providers** may forbid `CREATE INDEX CONCURRENTLY` inside their migration runner (it can't be in a txn) — check the runner's transaction wrapping.
