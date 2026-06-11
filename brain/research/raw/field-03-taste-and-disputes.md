# Field Intelligence — Explicit TASTE + Verbatim DISPUTES (feeds GAPS-AND-DISPUTES)

> Researcher: FIELD-INTELLIGENCE (acorn / Database harness, CP123 Wave-R). Captured 2026-06-11.
> Opinions great practitioners hold that average ones don't — quoted. Where credible sources disagree, BOTH sides verbatim.
> This is the section the mission specifically wants for GAPS-AND-DISPUTES. Each dispute = two columns, both cited.

---

## DISPUTE 1 — Primary keys: UUIDv4 vs bigint identity (and where UUIDv7 changes it in 2026)

This is the single most-litigated DB-design taste question, and **the conventional wisdom flipped in 2025**.

### Side A — "Avoid UUIDv4 PKs" (the expert/performance camp)
**Andy Atkinson** (author, *High Performance PostgreSQL for Rails*), "Avoid UUID Version 4 Primary Keys (for Postgres)", **2025-07-02**. _Source: <https://andyatkinson.com/avoid-uuid-version-4-primary-keys>._ Hit the **HN front page 2025-12-15**. Hard numbers (his benchmark, 10M rows / 1M updates):
- **Page density:** integer indexes ~**97.64%** leaf fill vs UUIDv4 ~**79.06%** → "**40% more I/O per lookup**."
- **Buffer cache:** bigint **27,332** buffer hits vs UUIDv4 **8,562,960** — a delta of **8.5 million** extra page accesses ≈ **68.3 GB** extra data touched for the same workload.
- **Storage:** UUID is 16 bytes vs bigint 8 vs int4 4 → "doubles storage versus bigint; quadruples versus 4-byte integers."
- **Mechanism (verbatim):** UUIDv4's "122 bits … random or pseudo-randomly generated values" scatter B-Tree inserts across random pages → "unnecessary splits and rebalancing add space consumption and processing latency."
- **Security myth, verbatim (RFC 4122):** "Do not assume that UUIDs are hard to guess; they should not be used as security capabilities."
- **His recommendation:** `bigint` identity columns by default; if you truly need UUIDs, **UUIDv7** (time-ordered, in **Postgres 18, Fall 2025**, or `pg_uuidv7` now). For unguessable public ids without losing ordering: XOR+base62 over the internal integer.

### Side B — "UUIDs are fine / preferable as default" (the distributed-systems / API-design camp)
- The pro-UUID case (pganalyze, Cybertec, brandur.org/026-ids): UUIDs let you **generate ids client-side / across services without a round-trip or a central sequence**, avoid leaking row-counts/business-volume via sequential ids, and simplify sharding & merging datasets. The HN thread <https://news.ycombinator.com/item?id=40884878> is full of "we've shipped UUID PKs at scale and it's fine with the right settings." _Source: <https://pganalyze.com/blog/5mins-postgres-uuid-vs-serial-primary-keys>; <https://brandur.org/nanoglyphs/026-ids>._
- The consensus refinement (pganalyze, verbatim): "use identity columns **unless you need to generate primary keys outside a single database**, and ensure all PK columns are `bigint`."

### Resolution for 2026 (what acorn should encode)
The dispute **largely dissolves with UUIDv7** (PG18, Fall 2025): you get the distributed-generation + non-sequential-API benefits of UUID **without** the index-locality catastrophe of v4. The live taste split in June 2026 is **"bigint identity (max perf, internal)" vs "UUIDv7 (distributed-friendly, near-bigint locality)"** — and **UUIDv4 is now the agreed-wrong default for new PKs.**
- **acorn rule:** default new PKs to **UUIDv7** (matches energy's existing `gen_random_uuid()` UUID surface but fixes locality) OR `bigint` identity for internal-only high-write tables. **Never UUIDv4 as a PK on a high-insert table.** Note: energy currently uses `gen_random_uuid()` (=v4) on every table (`ecosystem-00` §B1) — acorn should flag the v7 upgrade as a concrete house-style improvement. _GAP: confirm PG18 GA date + Supabase/Neon PG18 availability — see §GAPS._

---

## DISPUTE 2 — Authorization: "all in RLS / DB-is-the-perimeter" vs "app/middleware layer, RLS only as defense-in-depth"

### Side A — "Put authz IN the database" (PostgREST / Supabase / Neon house doctrine)
**PostgREST "Database Authorization" doctrine.** _Source: <https://docs.postgrest.org/en/latest/explanations/db_authz.html>._
- Core claim (verbatim): "Anyone accessing the generated API endpoint for the chat table will see **exactly the rows they should, without our needing custom imperative server-side coding**."
- The argument: define authz **once** in SQL (roles + RLS) → it enforces itself across **every** access path → **fewer places to get it wrong or bypass**. The DB becomes the single, un-bypassable source of truth. Supabase and **Neon RLS/"Neon Authorize"** (<https://neon.com/blog/introducing-neon-authorize>) productize exactly this.

### Side B — "RLS is the wrong place for real authz" (the larger-org / platform-eng camp)
**Bytebase, "Postgres RLS Limitations and Alternatives", 2025-05-28.** _Source: <https://www.bytebase.com/blog/postgres-row-level-security-limitations-and-alternatives/>._ Verbatim limitations:
- Performance: "RLS policies are evaluated **for _every single row_** during query execution" — vs views where the optimizer can "push predicates down and use indexes effectively."
- Expressiveness: "RLS policies are **constrained to SQL expressions**" → cannot evaluate "time zones, device reputation, risk scores, or external API approvals."
- Ops bottleneck: "DBAs become organizational bottlenecks when managing RLS policies due to the manual intervention required"; "no self-service … for access management or testing"; no JIT/emergency access.
- Missing: "No audit trails or version control for policies"; "no unit testing against different access scenarios"; can't span multiple data stores.
- Proposed alternative: **hybrid** — RLS for basic `tenant_id` isolation **+ OPA/Rego** for complex policy (version-controlled) **+ a governance tool** for operational access. Also <https://www.permit.io/blog/postgres-rls-implementation-guide> pushes ABAC/external-authz.

### Resolution for 2026 (what acorn should encode)
The 2026 consensus is **hybrid, not either/or** (both camps now concede this): **RLS as the always-on, un-bypassable baseline for tenant isolation** (the thing that, if you forget it, leaks 170 apps — see `field-01`), **plus app/service-layer authz for rich business rules** (risk scores, time windows, cross-store). _Source synthesis: bytebase + permit.io + Supabase docs, all 2025-2026._
- **acorn taste:** make RLS the **floor** (deny-by-default tenant isolation, tested as the un-privileged role), never the **ceiling** (don't cram device-reputation/risk logic into SQL policies). This reconciles Side A's "un-bypassable" with Side B's "too coarse for real authz." It also explains why CVE-2025-48757 happened: teams treated "no RLS" as acceptable because authz "lived in the app" — but with PostgREST/Supabase the DB *is* a public API, so a missing floor = open door.

---

## DISPUTE 3 — ORM vs raw SQL (and the agent-specific twist)

### Side A — "ORMs are the cigarettes of data engineering" (the spicy anti-ORM camp)
"ORMs are the Cigarettes of the Data Engineering World", **Daniel, 2021-11-15** (still widely cited in 2026 threads). _Source: <https://www.confessionsofadataguy.com/orms-are-the-cigarettes-of-the-data-engineering-world/>._ Verbatim:
- "You **don't learn SQL**, and SQL is everywhere and is going nowhere."
- "You don't make as many mistakes and struggle, **which is how you learn**."
- "If you can't actually **see the SQL** that is being generated by some ORM … chances are you are missing out on a lot."
- Observed in prod: senior engineers "resorting to bypassing the ORM but writing out the intricate SQL queries"; "skilled developers unable to solve intermediate SQL problems."
- **Only concession:** "It's probably fine for your small web app. It's probably **not fine for anything else** in a high volume production environment."

Tiger Data echoes the perf side: "industry benchmarks show SQL queries achieving **4x throughput** increase compared to popular ORMs" (the EdgeDB benchmark, ORM-vs-SQL). _Source: <https://www.tigerdata.com/blog/orms-in-production-postgresql-friend-or-foe> (2024-07-01)._

### Side B — "ORMs are a fine productivity tool with a SQL escape hatch" (the pragmatic camp)
- Tiger Data's balanced side (verbatim): ORMs "allow you to develop your entire project in a single language," give "simplified syntax for common query structures," handle "query safety," and let devs "work in languages they already know." Good for "fetching rows of data to plug into an object," PoCs, single-table early dev.
- The pragmatic 2026 take (makerkit, encore, coffeeaddict.dev): both Drizzle and Prisma are production-ready; **"ORM choice matters significantly less than data model design and business logic quality."** _Source: <https://www.alexcloudstar.com/blog/drizzle-orm-vs-prisma-2026/> (2026); <https://coffeeaddict.dev/orm/>._

### Resolution + the agent twist (what acorn should encode)
- The mature line: **use an ORM for the 90% of CRUD, drop to raw SQL for the 10% that's hot or analytical** — and the ORM you pick should make that drop-down painless. **This is exactly why Drizzle (SQL-first, plain `.sql` migrations) fits an agent better than a heavy ORM** (cross-ref `ecosystem-05` §4): an agent reasoning about a query benefits from the ORM being a thin, SQL-shaped layer it can read AND from being able to emit raw SQL when needed.
- **The N+1 trap is the average-engineer tell** (both sides agree): the lazy-loaded relation that fires one query per row. acorn lint: flag relation access inside a loop; prefer a single `with`/join. An agent that emits N+1 is the DB-domain equivalent of a junior.

---

## TASTE NUGGETS (single opinions worth quoting, not full disputes)

1. **"Test RLS as the un-privileged role, never in the SQL Editor."** The #1 thing experts do that beginners don't — the SQL Editor runs as `postgres` and bypasses RLS, so beginners "verify" policies that are actually wrong. (See `field-01` §3.) This is the highest-leverage taste in the vertical.
2. **"Two connection strings, always."** Experts split pooled (`:6543`, app) from direct (`:5432`, migrations/seeds) on day 1; beginners discover it via `prepared statement "drizzle_s_1" already exists` and a 502. (See `field-02` §1.)
3. **"`DROP COLUMN` is free; `ALTER COLUMN TYPE` is an outage."** Experts know the lock taxonomy cold and decompose every breaking change into expand→contract; beginners run a bare `ALTER`/`RENAME` and take the table down. (`ecosystem-08`.)
4. **"text + CHECK beats native ENUM"** for anything that might change — because you can't easily drop/reorder an ENUM value, but you can edit a CHECK. energy already does this (`ecosystem-00` §B8); it's a real taste marker. _Cross-ref Drizzle enum/`push` pain, `ecosystem-10` §1._
5. **"jsonb, never json."** Always `jsonb` (binary, indexable with GIN) over `json` (text). And **don't reach for jsonb to avoid schema design** — it's for genuinely variable-shape blobs, not "I didn't want to write a migration." (energy uses jsonb correctly for per-channel credentials, `ecosystem-00` §B4.)
6. **"Multi-tenant by table-prefix is what you do right before you regret it."** Even Convex abandoned per-tenant table prefixing for shared-schema-on-Postgres (`field-02` §4). Default to shared-schema + RLS; reach for DB-per-tenant only at enterprise/data-residency scale.
7. **"The storage engine and tenancy model dominate write-latency, not query micro-opts."** Convex's P50 became their old P99 purely by re-platforming the storage layer (`field-02` §4). Pick the right engine before tuning queries.

---

## Where I could NOT fully confirm (hand to GAPS-AND-DISPUTES)
- **PG18 GA + UUIDv7 availability on Supabase/Neon.** UUIDv7 "in Postgres 18, Fall 2025" is stated by Andy Atkinson (2025-07) and the PG18 release schedule, but I did not independently confirm PG18 reached GA nor when Supabase/Neon's managed Postgres exposes 18 + native `uuidv7()`. Treat "default to UUIDv7" as directionally-correct, version-gated.
- **"Drizzle dethroned Prisma in npm downloads, May 2026"** — secondary-blog claim (also flagged in `ecosystem-05` §1B); not verified against npm-trends directly.
- **The EdgeDB "4x throughput vs ORMs" number** is an EdgeDB-marketing benchmark (they sell an alternative); the magnitude is plausible for naive-ORM-vs-hand-SQL but is not a neutral source. Cite as "vendor-benchmarked," not gospel.
