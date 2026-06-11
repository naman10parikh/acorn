---
name: zero-downtime-migration
description: Ship or review a schema change / migration without taking the site down. Use when the ask is "write a migration", "review this migration", "add a column / constraint / index", "rename a column", or "make X required". Encodes expand→migrate→contract, the lock taxonomy, and the NOT VALID+VALIDATE two-step.
---

# zero-downtime-migration

> **Brain source:** `brain/OPINIONS.md` §Migrations · `brain/KNOWN-PITFALLS.md` §Migrations (P10-P15) · `brain/BATTLE-TESTED-SCENARIOS.md` #4 (the 84M-row CHECK that locked prod for 4h12m / $52,400), #5 (drizzle rename → DROP+ADD data loss). energy has **no zero-downtime story today** — acorn OWNS this.

## Trigger

"Write a migration to ...", "review this migration", "add a NOT NULL / CHECK / foreign key", "create an index on a big table", "rename / change the type of a column", "make `users.phone` required".

## Steps

1. **Decompose any breaking change into Expand → Migrate → Contract:**
   - **Expand** — ADD new columns/tables alongside the old; never drop, never rename; old + new coexist.
   - **Migrate** — deploy app that writes BOTH; backfill history in **batches of 1k–10k rows with a sleep between batches**.
   - **Contract** — once new is verified-full AND old code is drained, `DROP` the old (metadata-only, ms).
2. **Know the lock taxonomy cold.** AccessExclusive (blocks ALL reads+writes — an outage on a hot table): `ALTER COLUMN TYPE`, `ADD CONSTRAINT CHECK/FK` validated immediately, `SET NOT NULL` directly, `CREATE INDEX` non-concurrent. Safe/fast: `ADD COLUMN x text DEFAULT '...'` (PG11+), `DROP COLUMN` (metadata), `CREATE INDEX CONCURRENTLY`.
3. **Apply the two version-specific tricks every tool forgets:**
   - **Safe NOT NULL / CHECK / FK** = `ADD CONSTRAINT ... NOT VALID;` (brief lock, no scan) then `VALIDATE CONSTRAINT` (weaker ShareUpdateExclusive; reads/writes continue). PG12+ then `SET NOT NULL` skips the scan.
   - **Index** = `CREATE INDEX CONCURRENTLY` (caveat: can't run in a txn block; on failure leaves an INVALID index to DROP + retry).
4. **`SET lock_timeout = '3s'` at the top of EVERY migration** — a *waiting* AccessExclusive lock freezes every query behind it; fail fast and retry rather than queue and cascade into an outage. "If a migration requires AccessExclusiveLock for more than 1 second, don't run it."
5. **Never bare-`RENAME`/`DROP` on a hot table** mid rolling-deploy (breaks the still-running old app version). Never `drizzle-kit push` past dev (it can silently turn a rename into DROP+ADD = data loss) — `generate` → review → `migrate`.
6. **Test at prod scale** — a 10K-row staging pass hides the outage that locks 84M rows for hours (the 8,400x mismatch is exactly the trap).

## Output

Either a safe migration (the two-step + `lock_timeout` + `CONCURRENTLY`, via `acorn migration safe <file.sql>` → `src/transform/safe-migration.ts`) or a lint report flagging the 5 outage-makers (P10-P15, via `acorn migration lint <file.sql>` → `src/lint/migration.ts`), each carrying the lock class it would have taken.

## Worked example

**Ask:** *"Make `users.phone_number` required. The table has 84M rows."* (literally Scenario #4)

**The naive command acorn REFUSES to ship:**
```sql
ALTER TABLE users ADD CONSTRAINT users_phone_number_check CHECK (phone_number IS NOT NULL);
```
*— this takes AccessExclusive and validates every row under it → a 4h12m lock you can't even cancel (`pg_terminate_backend` failed mid-scan); 12.4M users locked out; $52,400 lost. No `lock_timeout` was set; staging had 10K rows.*

**`acorn migration safe` rewrites it to (same business outcome, 42 min, 0s table-lock):**
```sql
SET lock_timeout = '3s';  -- acorn: fail fast, never queue behind a long query (P14)
ALTER TABLE users ADD CONSTRAINT users_phone_number_check CHECK (phone_number IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_phone_number_check;  -- acorn: weaker ShareUpdateExclusive, reads/writes continue
```
**Lint proof:** `acorn migration lint bare-check.sql` exits non-zero with `P10` (AccessExclusive full scan) + `P14` (no lock_timeout). A correctly-formed migration (lock_timeout + NOT VALID/VALIDATE + CONCURRENTLY) lints clean.
