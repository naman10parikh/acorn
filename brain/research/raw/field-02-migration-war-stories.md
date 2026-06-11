# Field Intelligence — Migration War Stories (Provider A→B, What Actually Broke)

> Researcher: FIELD-INTELLIGENCE (acorn / Database harness, CP123 Wave-R). Captured 2026-06-11.
> Real migrations with verbatim error messages, not migration-guide marketing. Cited (URL + author + date).

---

## 1. THE recurring villain: transaction-pooler × named prepared statements (this breaks EVERYONE)

Across Supabase, Neon, and every serverless Postgres, the single most common production breakage is the same: **the transaction-mode pooler does not support named prepared statements, and `postgres-js`/Drizzle/Prisma default to using them.**

**Verbatim production error (Neon→Supabase + Drizzle migration, Felix Jumason, 2024-04-19):** _Source: <https://dev.to/blackie360/migrating-from-neon-to-supabase-postgres-drizzle-in-production-4ekh>._
> `prepared statement "drizzle_s_1" already exists`

He calls the connection-string choice **"the #1 footgun"**:
> "For Vercel/serverless workloads, you need the transaction pooler at `:6543`, but this connection type **does not support named prepared statements**, which is exactly what `postgres-js` (and therefore Drizzle) defaults to."

**Fix:** disable prepared statements in the client (`prepare: false` in postgres-js / `DATABASE_PREPARED_STATEMENTS=false`).

**His exact regret quote (the lesson):**
> "Set `DATABASE_PREPARED_STATEMENTS=false` **before the first request**. I set it after the first 502 and lost five minutes diagnosing prepared statement collisions in Drizzle."

**Same villain, Neon seeding (different team):** _Source: <https://seedfa.st/blog/seed-neon-database> (2026)._
> "use the **unpooled** connection string — the pooled URL breaks prepared statements mid-seed. If your seed throws prepared statement errors about `s1` already exists or **cached plan must not change result type**, you're connecting through the pooled URL."

**acorn house rule (encode as a template + lint):**
- **Two connection strings, always.** Pooled/transaction (`:6543`, `?pgbouncer=true`) for the app's hot path; **direct/unpooled (`:5432`) for migrations, seeds, and prepared-statement-heavy admin work.** Prisma calls these `DATABASE_URL` (pooled) + `directUrl` (unpooled) — the split is mandatory, not optional.
- **`prepare: false` on the pooled client** when using postgres-js/Drizzle through transaction mode. Bake it into the generated client; do not let a dev discover it via a 502.

---

## 2. War story in full: Neon → Supabase (Postgres + Drizzle + Better Auth, in prod)
_Source: <https://dev.to/blackie360/migrating-from-neon-to-supabase-postgres-drizzle-in-production-4ekh> — Felix Jumason, 2024-04-19. ~1 hour migration, small app. Verbatim errors below._

The five things that broke, in order:

1. **Wrong connection URL → prepared-statement collision** (see §1). The headline footgun.

2. **Port 5432 blocked by firewall during `pg_dump`:**
   > `AggregateError [ETIMEDOUT]: connect ETIMEDOUT ...:5432`
   - Corporate/ISP firewalls block the raw Postgres port. Workaround: Neon's HTTP serverless driver, `pg_dump` from an unrestricted network, or an MCP server that tunnels.

3. **Schema-restore collisions** (three predictable ones on Supabase):
   - **Duplicate ENUM type creation** (the dump re-creates a type the target already has).
   - **Extension schema mismatch** — Supabase puts extensions in the `extensions` schema, NOT `public`. A dump that assumes `public` extensions collides.
   - **Pre-existing `auth`, `storage`, `realtime` schemas** — Supabase ships these; a naive full restore fights them.

4. **Drizzle migration-ledger desync** (subtle, high-pain):
   > `DrizzleQueryError: type "showcase_status" already exists`
   - After restoring the schema, the `drizzle.__drizzle_migrations` table was **empty**, so Drizzle tried to **re-run ALL migrations against an already-populated schema** → every `CREATE TYPE`/`CREATE TABLE` collides. **Fix: manually insert the migration hashes + timestamps into the ledger** so Drizzle believes they already ran.
   - **acorn lesson:** when you restore a schema dump into a fresh DB, you must ALSO restore (or hand-seed) the ORM's migration-tracking table, or the ORM will fight the schema it didn't apply. This is true for Drizzle (`__drizzle_migrations`), Prisma (`_prisma_migrations`), and every migration runner.

5. **Auth-state preservation:** copying `session` rows (Better Auth) preserved logged-in state across the cutover — validated by testing a live admin account against the new DB. **Lesson: a DB migration that forgets the session/token tables logs every user out at cutover.**

**Why he kept Supabase anyway (the taste):**
> "Neon's branching is magic, but Supabase's bundle (Postgres + Auth + Storage + RLS + Realtime + a great dashboard) is hard to beat."

---

## 3. Supabase connection-limit pain: "Max client connections reached" (the most-frustrated thread)
_Source: <https://github.com/orgs/supabase/discussions/18986> ("Getting max connection reached using supavisor")._

**The symptom (verbatim):** `PostgresError: Max client connections reached` during traffic spikes — *despite* using Supavisor (the pooler). Hit across Prisma, Next.js, FastAPI, Spring Boot, all on Vercel serverless.

**Root cause:** serverless opens a new DB connection per invocation; under a spike, hundreds of Lambdas race for connections faster than the pooler's client-connection cap allows. (Postgres default `max_connections` ≈ 100; Supavisor adds its own client-connection ceiling tied to compute size.)

**Maintainer guidance (@chasers, 2024-03-12):** increase compute add-on (raises the limit), increase pool size, decrease query time, **use transaction mode on port 6543 + disable prepared statements**, reduce connections per client.

**The signal that this is genuinely unresolved:** the community **downvoted the official answer 12 times** — i.e. "increase your compute" was not a satisfying answer for serverless patterns. Community workarounds: IPv4 add-on ($4/mo) to dodge Supavisor latency, `connection_limit=10` in the connection string, Prisma `directUrl` + `database_url` split, and (a hacky one) "Restrict All Access then re-enable" to reset stuck connections.

**acorn rule:** in serverless/edge, **cap connections per client instance** (`connection_limit=1` per Lambda is the standard advice; the pooler fans them in). The failure mode is not "too few connections in the DB" — it's "too many clients each grabbing a connection." Design for the pooler's *client* ceiling, not the DB's *server* ceiling.

**Supabase-specific connection facts to encode:**
- Supavisor client limits are **tied to compute size** and cannot be raised independently. _Source: search corpus, supabase troubleshooting docs, 2026._
- Realtime: **leaked channels are the #1 cause of hitting connection limits**; >500 concurrent Realtime connections needs custom limits / self-host / a dedicated provider. _Source: <https://www.agilesoftlabs.com/blog/2026/05/supabase-realtime-in-production-what> (2026-05)._
- "Supabase is designed for **server-side** usage, not direct DB connection from thousands of browser tabs" — every browser sharing one rate-limit bucket hits the ceiling fast. _Source: same._

---

## 4. The meta-migration: Convex itself moved Aurora-MySQL → PlanetScale-Postgres (and what it teaches)
_Source: <https://medium.com/@joqim/why-convex-moved-from-aurora-mysql-to-planetscale-postgresql-f9891bba092b> (2025)._

Convex (the reactive DB) re-platformed its OWN storage engine from AWS Aurora MySQL to PlanetScale Postgres. Why it's instructive for acorn:
- **The trigger was multi-tenancy economics.** On Aurora, each Convex project needed its own backend instance → no viable free tier. They tried **table-prefixing per tenant** ("messy abstractions and performance bottlenecks") before moving to PlanetScale Postgres, which runs **many databases per instance**. → **Multi-tenant-by-table-prefix is an anti-pattern even the experts abandon.** (Cross-ref `ecosystem-04` shared-schema-with-RLS as the better default.)
- **The payoff datapoint (great taste-quote):** after the switch, **"Convex's P50 commit latency became as good as their previous P99 (worst-case) commit latency."** A platform swap moved the *median* to where the *tail* used to be. acorn lesson: the storage engine and tenancy model dominate write-latency distribution far more than query-layer micro-optimizations.

---

## 5. Migrating AWAY from Convex → Postgres+Drizzle: the honest friction
_Source: <https://stack.convex.dev/how-hard-is-it-to-migrate-away-from-convex> (Convex's own blog — self-serving toward "self-host instead", but the technical points are concrete)._

- **API-level lock-in: manageable.** Query/mutation code can be ported with effort.
- **Reactive queries: the real friction.** Convex live-queries auto-update on data change; Postgres+Drizzle+TanStack Query requires **manual invalidation**: *"we need to add a few more lines to our mutation to manually invalidate our local query."* The reactivity you got for free becomes hand-written cache-invalidation.
- **Transactions: subtle.** *"Convex mutations are a transaction — everything within the handler must succeed."* Drizzle gives you transactions too, but "Drizzle Postgres transactions might not be exactly the same as Convex" → semantic gaps to audit on port.
- **The hidden cost is operational, not API:** leaving Convex means re-implementing what it bundled — file storage (S3), full-text search (Algolia), realtime (Pusher), auth (Clerk/Auth0), scheduling (PGBoss/RabbitMQ). *"You'd be taking on a lot more complexity by managing your own infrastructure."*

**acorn taste:** Convex's lock-in is NOT the query API — it's the **bundle of reactivity + transactions + built-ins** you stop getting. For Energy's Supabase-Postgres default, this is the case *for* Convex (realtime-first apps) and *against* it (you inherit the bundle-rebuild if you ever leave). Choose Convex when reactivity IS the product; avoid it when you'll want raw SQL / pgvector / RLS-as-isolation later.

---

## 6. Drizzle's own migration foot-gun: rename detected as drop+add (DATA LOSS)
_Source: <https://www.buildmvpfast.com/blog/drizzle-vs-prisma-orm-typescript-nextjs-2026> (2026); cross-ref `ecosystem-10` §1._
> "Drizzle's strict mode prompts when it detects ambiguous changes like column renames. **Without it, Drizzle might interpret a rename as 'drop + add', which loses data.** Always use strict mode."

This is the Drizzle equivalent of the expand/contract rename rule (`ecosystem-08` §1): a bare rename in `drizzle-kit` can silently become DROP+ADD and lose the column's data. **acorn rule: never let `drizzle-kit` auto-resolve a rename; review the generated SQL, and for prod use the expand→backfill→contract sequence, never a single rename op.**

---

## 7. One-line takeaways for acorn
1. **Two connection strings always** (pooled `:6543` for app, direct `:5432` for migrations/seeds); `prepare:false` on the pooled client. This one rule prevents the most common production breakage in the whole vertical.
2. When restoring a schema dump, **also restore the ORM migration-ledger table** (`__drizzle_migrations`/`_prisma_migrations`) or the ORM re-runs everything and collides.
3. Serverless: **cap connections per client** (~1/Lambda); design for the pooler's *client* ceiling, not the DB's server ceiling. "Increase compute" is the official-but-unloved answer (downvoted 12×).
4. **Multi-tenant by table-prefix is an anti-pattern even Convex abandoned** — prefer shared-schema + RLS or DB-per-tenant, not prefixing.
5. Convex lock-in = the bundle (reactivity/txns/built-ins), not the API. Leaving = rebuilding S3/Algolia/Pusher/Clerk/queue yourself.
6. Drizzle rename = potential DROP+ADD data loss; always review, always expand/contract in prod.
