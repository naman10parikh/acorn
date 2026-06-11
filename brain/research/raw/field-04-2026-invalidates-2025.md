# Field Intelligence — What Changed in 2026 That Invalidates 2025 Conventional Wisdom

> Researcher: FIELD-INTELLIGENCE (acorn / Database harness, CP123 Wave-R). Captured 2026-06-11. Cited (URL + date).
> If a blog post predates these events, its advice may be stale. acorn must date-check every DB recommendation.

---

## 1. PostgreSQL 18 SHIPPED — **2025-09-25** (this resolves the UUIDv7 GAP and changes index/IO advice)
_Source: <https://www.postgresql.org/about/news/postgresql-18-released-3142/>; <https://neon.com/postgresql/18-new-features>; <https://www.postgresql.org/docs/release/18.0/>. All confirmed 2026-06-11._

The single most important DB platform event of the cycle. Five changes that **invalidate 2025 advice**:

1. **Native `uuidv7()` function.** "PostgreSQL 18 adds a `uuidv7()` function for generating timestamp-ordered UUIDs … better indexing and read performance." → **This kills the UUIDv4-vs-bigint dispute** (`field-03` §DISPUTE 1). You no longer need `pg_uuidv7`, a custom function, or a trade between "distributed-friendly" and "index-local." Pre-PG18 advice that says "use bigint because UUIDs fragment your index" is now only true for **v4**. **acorn default for new PKs on PG18+: `uuidv7()`.**
2. **Asynchronous I/O (AIO).** "up to **3× performance improvements** when reading from storage" on seq scans, bitmap heap scans, vacuum. → 2025 capacity-planning numbers for scan-heavy workloads are conservative on PG18.
3. **Skip scan on multicolumn B-tree indexes.** Queries that **omit an `=` on a prefix column** can now use a multicolumn index. → The 2025 rule "you must always lead your composite index with the column you filter on, or it's useless" is **weakened** — PG18 can skip-scan. (Still index for your real predicates, but the penalty for a suboptimal column order dropped.)
4. **Virtual generated columns are now the DEFAULT** for generated columns (computed at read, not stored). → Re-decide the `field-01`/`ecosystem-00` §B7 "STORED generated tsvector" advice per-case: STORED is still right for an indexed `tsvector`, but for cheap derived values, virtual (the new default) avoids write amplification. **acorn must be explicit `STORED` when it wants the value materialized for an index.**
5. **Temporal constraints** (PK/UNIQUE/FK over ranges via `WITHOUT OVERLAPS`), **`RETURNING OLD/NEW`** in INSERT/UPDATE/DELETE/MERGE, **OAuth auth**, and **`pg_upgrade` retains optimizer statistics** (no more "ANALYZE the whole DB after upgrade" stall). → Several hand-rolled patterns (exclusion-constraint hacks for temporal validity; trigger-based old-value capture) are now built-in.

**The managed-provider caveat (still a real GAP):** PG18 GA'd 2025-09. Managed providers lag core. As of this research I did NOT confirm the exact date Supabase / Neon default new projects to PG18 or expose `uuidv7()` natively. _Chris Longros (<https://chrislongros.com/2026/03/01/postgresql-18-released/>, 2026-03) frames PG18 as "where it stands in 2026," implying broad availability by Q1 2026, but provider-specific GA needs a live check before acorn hard-codes `uuidv7()`._ → **acorn rule: feature-detect (`SELECT uuidv7()` probe) before defaulting to it; fall back to `gen_random_uuid()` if the managed PG is <18.**

---

## 2. Prisma 7 (late 2025) made MOST pre-2026 ORM comparisons obsolete
_Source: <https://www.infoq.com/news/2026/01/prisma-7-performance/> (2026-01); <https://www.prisma.io/blog/announcing-prisma-orm-7-0-0> (2025-11-19); <https://techsy.io/en/blog/prisma-vs-drizzle-orm> (2026)._

The verbatim warning every 2026 source repeats:
> "**Most Prisma vs Drizzle comparisons you'll find online describe a Prisma that no longer exists.** If you last evaluated Prisma in 2024 or early 2025, the architecture underneath has fundamentally changed." — _pockit/techsy, 2026._

What changed and what it invalidates:
- **Rust query engine REMOVED; client is pure TypeScript.** → Every "Prisma ships a 14-30MB Rust binary / blows the Cloudflare bundle limit / cold-starts slowly on Lambda" claim is **dead**. Bundle fell **~90%** (to ~1.6MB / 600KB gz), cold starts "**roughly 9x**" better, "**up to 3.4x faster queries** for large result sets" (cross-language serialization gone). _Source: infoq 2026-01._
- **Driver adapters are core, not experimental.** → "Prisma 7 works natively in edge environments via its TypeScript engine. **No Prisma Accelerate proxy required for basic edge support.**" The 2024 "you need Accelerate to run Prisma on the edge" advice is stale.
- **BUT the bundle gap didn't fully close:** "Drizzle's 57KB bundle is still roughly **28x smaller** than Prisma 7's 1.6MB." → Drizzle still wins on raw edge bundle; Prisma 7 just stopped being disqualifying.

**acorn rule:** when grading any ORM benchmark, **first determine if it's Prisma ≤6 (Rust) or 7 (TS).** Reject "Prisma is bloated/slow on edge" sourced from pre-Nov-2025 content. (Cross-ref `ecosystem-05` §2 VERSION DISPUTE — same finding, both researchers independently confirm.)

---

## 3. The DB landscape consolidated under data-platform giants (2025) — a strategic, not technical, invalidation
- **Databricks → Neon, ~$1B, announced 2025-05-14.** Post-acq pricing (Aug 2025): compute −15-25%, storage −80% ($1.75→$0.35/GB), $5/mo min; free compute doubled to 100 CU-hrs (Oct 2025). _Source: <https://www.databricks.com/blog/databricks-neon>; cross-ref `ecosystem-03` §A1._ → "Neon is a scrappy independent serverless-PG startup" is stale; it's a Databricks/Lakebase product now. Watch for AI-platform-tilt in the roadmap.
- **PlanetScale → Drizzle core team, 2026-03-03.** _Source: <https://planetscale.com/blog/drizzle-joins-planetscale>; cross-ref `ecosystem-05` §1B._ → The 2024 "Drizzle is a side-project, bus-factor risk, pick Prisma for stability" argument is **invalidated** — Drizzle is now full-time enterprise-backed.
- **The agent-provisioning datapoint that reframes the whole vertical:** ">80% of databases provisioned on Neon are created by **AI AGENTS**, not humans." _Source: <https://venturebeat.com/data-infrastructure/the-1-billion-database-bet-...>; cross-ref `ecosystem-03` §A1._ → This is *the* June-2026 fact for acorn: provisioning a Postgres is now an **agent action**, which is exactly acorn's domain. The 2024 mental model ("a human clicks 'create database' in a dashboard") is no longer the dominant path.

---

## 4. The security default flipped — but only on ONE path (the trap)
- **2024 wisdom:** "Supabase tables are public-by-default; you must remember to enable RLS." **2025 change:** "For tables created **via the dashboard**, RLS is enabled by default" + auto-revoke of secret keys leaked to public GitHub + new `sb_publishable_`/`sb_secret_` key formats. _Source: <https://supabase.com/blog/supabase-security-2025-retro>; cross-ref `field-01` §1._
- **Why this is a TRAP, not a fix, for acorn:** the secure-by-default applies to **dashboard-created** tables. Tables created by **SQL migration** (`supabase db push`, which is how acorn/energy work) are **still RLS-opt-in.** A 2026 dev who reads "RLS is on by default now" and ships migration-created tables has the *old* vulnerability with *new* false confidence. **acorn must lint regardless of the platform default.**

---

## 5. The agent-DB security model is NEW (2025-2026) and has no 2024 equivalent
The **Supabase MCP "lethal trifecta"** (Simon Willison, 2025-07-06, `field-01` §2) is a class of bug that **did not exist in 2024** because agents weren't operating production DBs at scale. Conventional 2024 DB security (SQL injection, RLS, least-privilege roles) does NOT cover **prompt-injection-via-stored-row-content** or **an agent with `service_role` echoing private data to an attacker-controlled table.** → acorn is operating in a threat landscape that postdates most DB-security writing. The relevant primary sources are all 2025+: Willison, Pomerium ("When AI Has Root"), General Analysis. **acorn's safety rules must be authored from 2025+ sources, not classic DB-security canon.**

---

## 6. One-line takeaways for acorn
1. **PG18 (2025-09-25) changes defaults:** `uuidv7()` native (feature-detect first), async I/O, skip scan, virtual generated columns default, temporal constraints, `RETURNING OLD/NEW`. Date-check any pre-Sept-2025 index/IO advice.
2. **Prisma 7 (Nov 2025) erased the "Rust binary / edge / cold-start" disqualifiers.** Reject pre-Nov-2025 Prisma benchmarks. Drizzle still wins raw bundle (28x), not perf-class.
3. **Neon=Databricks, Drizzle=PlanetScale** — both de-risked the "small independent project" objection; both shifted roadmap incentives.
4. **>80% of Neon DBs are agent-provisioned** — the dominant "create a database" actor is now an agent (acorn's exact domain).
5. **Secure-by-default is dashboard-only** — migration-created tables are still RLS-opt-in; lint anyway.
6. **Agent-DB threats (MCP lethal trifecta) postdate 2024** — author acorn's safety rules from 2025+ sources.
