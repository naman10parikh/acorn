---
title: "acorn Gaps & Disputes — where sources disagree or can't be confirmed"
type: synthesis
created: "2026-06-11"
updated: "2026-06-11"
tags: [gaps, disputes, unresolved, experiments, currency, uuid, rls, orm, pgvector]
sources: ["brain/research/raw/field-00-index-and-gaps.md", "brain/research/raw/field-03-taste-and-disputes.md", "brain/research/raw/field-04-2026-invalidates-2025.md", "brain/research/raw/field-05-migration-disasters-and-pgvector-field-reality.md", "brain/research/raw/ecosystem-05-drizzle-vs-prisma.md", "brain/research/raw/ecosystem-01-supabase.md", "brain/research/raw/ecosystem-02-postgres17.md", "brain/research/raw/ecosystem-09-pgvector-embeddings.md", "brain/research/raw/ecosystem-11-backup-pitr.md", "brain/research/raw/ecosystem-00-internal-references.md"]
related: ["[[EXPERTISE-MAP]]", "[[OPINIONS]]", "[[KNOWN-PITFALLS]]", "[[TOOL-MATRIX]]", "[[BATTLE-TESTED-SCENARIOS]]"]
summary: "Three genuine taste-disputes (both sides cited verbatim), the facts research could NOT confirm (version-gates to feature-detect), and the questions with no good source where acorn must form its own view via experiments. Honesty layer: do not fake-resolve."
---

# acorn Gaps & Disputes

> This file exists so acorn does **not** fake-resolve genuine disagreements or assert things research could not confirm. Three sections: **A. Live disputes** (both sides verbatim + the decision rule), **B. Unconfirmed facts** (feature-detect / verify before relying), **C. Open questions** (no good source → acorn must experiment and write the answer back to [[OPINIONS]] / `brain/ORG_MEMORY.md`). The DSIP `externalIntelligence` loop should re-check Section B on a cadence.

---

## A. Live disputes (both sides cited; acorn defaults but does not declare a winner)

### DISPUTE 1 — Primary key type: `bigint` identity vs UUID (and where UUIDv7 changes it)
The single most-litigated DB-design taste question; conventional wisdom **flipped in 2025**.

- **Side A — "Avoid UUIDv4 PKs" (performance camp).** Andy Atkinson (*High Performance PostgreSQL for Rails*), 2025-07-02, HN front page 2025-12-15. Hard numbers (10M rows/1M updates): integer index ~**97.64%** leaf fill vs UUIDv4 ~**79.06%** → "**40% more I/O per lookup**"; bigint **27,332** buffer hits vs UUIDv4 **8,562,960** (~68.3GB extra touched); UUID 16 bytes vs bigint 8 vs int4 4. RFC 4122 verbatim: "Do not assume that UUIDs are hard to guess; they should not be used as security capabilities." Recommends `bigint` identity by default, UUIDv7 if you truly need UUIDs. _Source: `field-03` DISPUTE 1._
- **Side B — "UUIDs are fine / preferable" (distributed-systems/API camp).** pganalyze/Cybertec/brandur: UUIDs let you generate ids client-side/across services without a round-trip or central sequence, avoid leaking row-counts via sequential ids, and simplify sharding/merging. pganalyze refinement (verbatim): "use identity columns **unless you need to generate primary keys outside a single database**, and ensure all PK columns are `bigint`." _Source: `field-03` DISPUTE 1._
- **What's SETTLED:** **UUIDv4 is the agreed-wrong default for a high-insert PK.** Both camps concede the locality problem.
- **What's STILL OPEN (June 2026):** **`bigint` identity (max perf, internal-only) vs `uuidv7()` (distributed-friendly, near-bigint locality).** UUIDv7 (PG18) largely dissolves the dispute by giving UUID's benefits without v4's fragmentation — but the bigint-vs-v7 choice is a real per-table call.
- **acorn decision rule:** internal-only, highest-write tables → `bigint` identity; anything needing client-/cross-service id generation or non-sequential public ids → `uuidv7()` (feature-detected — see B1). **Never v4 on a high-insert PK.** Flag energy's blanket `gen_random_uuid()` (=v4) as a concrete upgrade. _Source: `field-03` DISPUTE 1, `ecosystem-00` §B1._

### DISPUTE 2 — Authorization location: "all in the DB (RLS)" vs "app/middleware layer, RLS only as defense-in-depth"
- **Side A — "Put authz IN the database" (PostgREST/Supabase/Neon doctrine).** PostgREST verbatim: "Anyone accessing the generated API endpoint for the chat table will see exactly the rows they should, **without our needing custom imperative server-side coding**." Define authz once in SQL (roles + RLS) → it enforces itself across every access path → fewer places to get it wrong. Neon "Authorize" + Supabase productize this. _Source: `field-03` DISPUTE 2._
- **Side B — "RLS is the wrong place for real authz" (larger-org/platform-eng camp).** Bytebase, 2025-05-28, verbatim limitations: RLS is "evaluated for every single row"; "constrained to SQL expressions" (can't do "time zones, device reputation, risk scores, or external API approvals"); "DBAs become organizational bottlenecks"; "No audit trails or version control for policies"; "no unit testing against different access scenarios." Proposes hybrid: RLS for `tenant_id` isolation + OPA/Rego for complex policy + a governance tool. permit.io pushes ABAC/external-authz. _Source: `field-03` DISPUTE 2._
- **What's SETTLED (2026 consensus, both camps concede):** **hybrid.** RLS as the always-on un-bypassable baseline for tenant isolation; app/service-layer authz for rich business rules.
- **What's STILL OPEN:** *how much* logic belongs in RLS before it becomes the un-version-controlled, untestable, DBA-bottleneck anti-pattern Side B warns about. There is no crisp line; it's a per-org judgment of policy complexity vs operability.
- **acorn decision rule (= [[OPINIONS]] §RLS):** RLS is the floor (tenant isolation, deny-by-default, tested as the un-privileged role); the moment a rule needs a risk score / time window / external call / cross-store join, it goes in the app layer. This reconciles "un-bypassable" with "too coarse for real authz" — and explains CVE-2025-48757 (teams skipped the floor because authz "lived in the app," but with PostgREST the DB *is* a public API, so a missing floor = open door). _Source: `field-03` DISPUTE 2, `field-01` §5._

### DISPUTE 3 — ORM vs raw SQL (with the agent-specific twist)
- **Side A — "ORMs are the cigarettes of data engineering" (anti-ORM).** Daniel, 2021-11-15 (still cited 2026), verbatim: "You don't learn SQL, and SQL is everywhere and is going nowhere"; "If you can't actually see the SQL … you are missing out on a lot"; observed senior engineers "bypassing the ORM but writing out the intricate SQL." Only concession: "probably fine for your small web app … not fine for anything else in a high volume production environment." Tiger Data cites "**4x throughput** … compared to popular ORMs" — but that's the **EdgeDB vendor benchmark** (they sell an alternative). _Source: `field-03` DISPUTE 3._
- **Side B — "fine productivity tool with a SQL escape hatch" (pragmatic).** ORMs "allow you to develop your entire project in a single language," simplify common queries, handle query safety. The pragmatic 2026 take: both Drizzle and Prisma are production-ready; **"ORM choice matters significantly less than data model design and business logic quality."** _Source: `field-03` DISPUTE 3._
- **What's SETTLED:** **ORM for ~90% CRUD, raw SQL for the hot/analytical 10%.** The N+1 (relation fetched in a loop) is the universal average-engineer tell.
- **What's STILL OPEN:** which specific queries cross the line to "drop to raw SQL" — workload-dependent, must be measured, not asserted.
- **acorn decision rule:** thin SQL-first ORM (Drizzle) so the drop-down is painless for an agent; profile the hot path and emit raw SQL where the ORM obscures the plan. The "4x" figure is **vendor-benchmarked** — cite magnitude, not gospel. _Source: `field-03` DISPUTE 3, `ecosystem-05` §4._

### DISPUTE 4 — "Is Supabase safe for production?" (security-tooling camp vs Supabase camp)
- **Side A — security-tooling/scanner camp** frames Supabase RLS as a minefield ("the RLS trap," CVE-everywhere) — but their business is selling scanners. _Source: `field-01` §5 (vibeappscanner)._
- **Side B — Supabase camp** (2025 security retro) argues the platform is now secure-by-default and the failures were *generated-code* (Lovable) failures, not Supabase failures. _Source: `field-01` §5._
- **acorn synthesis (both partly right):** the *platform default* improved (dashboard tables) but the *migration-driven path acorn uses* is still opt-in → **lint regardless of the platform default.** This is a framing dispute, not a technical one; capture both, act on the conservative reading. _Source: `field-01` §5, `field-04` §4._

---

## B. Facts research could NOT confirm — feature-detect / verify before relying

> These are version-gates, not opinions. acorn must **probe**, not assume. The DSIP external-intelligence watch should re-confirm these on a cadence and update [[TOOL-MATRIX]]/[[OPINIONS]].

### B1. PG18 availability on managed providers + native `uuidv7()` exposure
PG18 core **GA'd 2025-09-25 (confirmed)** with native `uuidv7()`. **NOT confirmed:** the exact date Supabase/Neon default new projects to PG18 or expose `uuidv7()` natively (Chris Longros 2026-03 implies broad Q1-2026 availability but not provider-specific). → **acorn must feature-detect:** run `SELECT uuidv7();` — if it errors, the managed PG is <18, fall back to `gen_random_uuid()` (or `pg_uuidv7` extension on PG17). Do NOT hard-code `uuidv7()` in a template that may run on PG15. _Source: `field-00` §C1, `field-04` §1, `ecosystem-02` §2._

### B2. "Drizzle overtook Prisma in npm downloads, May 2026"
Repeated by multiple secondary blogs; **NOT verified against npm-trends directly** (both FIELD and ECOSYSTEM independently flag this). → Treat as a **directional adoption signal, not a fact.** Don't cite it as settled in any decision doc; if it matters, pull npm-trends live. _Source: `field-00` §C2, `ecosystem-05` §1B._

### B3. "Drizzle's acute migration issues have settled"
Inferred from the **absence** of high-comment 2025+ issues (all the top pain — enum/`push` #2389, kit-churn #781, `compositePrimaryKeys` #2344 — is 2023-24 vintage). This is a **comment-volume inference, not a stability guarantee.** → The "never `drizzle-kit push` to prod; `generate`→review→`migrate`" precaution **still stands** regardless. _Source: `field-00` §C3, `field-05` §4._

### B4. The "4x throughput SQL vs ORM" number
It's the **EdgeDB marketing benchmark** (vendor selling an ORM alternative). Magnitude plausible for naive-ORM-vs-hand-SQL, but **not a neutral source.** → Cite as "vendor-benchmarked," never as a neutral fact. _Source: `field-00` "Bonus unconfirmed", `field-03` DISPUTE 3._

### B5. Supabase exact PG default major + PITR tier→retention numbers
ECOSYSTEM could not pin the exact June-2026 default Postgres major from a dated source (Supabase historically ships ~PG15-default with PG17 available, lagging core ~1 major). Supabase PITR exact tier→retention numbers "shift; verify current pricing page." → **Confirm at project-create time** and on the live pricing page, not from this brain. _Source: `field-00`/`ecosystem-01` §1 [FLAG], `ecosystem-11` §3 [FLAG]._

### B6. PG18 exact feature set on the day (skip-scan / virtual-generated-columns defaults)
PG18 headline items are confirmed GA, but a couple of behavioral defaults (virtual generated columns now default; skip-scan applicability) should be **verified against the release notes per use-case** before relying on them to change index-design advice. → Be explicit `STORED` when you want a generated column materialized for an index. _Source: `field-04` §1, `ecosystem-02` §2 [FLAG]._

### B7. pgvectorscale benchmark numbers (28× p95, 16× throughput vs Pinecone)
These are **Timescale's own vendor benchmarks** — directionally strong but self-reported. → If a product is choosing pgvectorscale over a dedicated vector DB, run a workload-specific benchmark; don't quote the vendor numbers as neutral. _Source: `ecosystem-09` §4 [FLAG]._

---

## C. Open questions — no good source; acorn must form its own view via experiments

> These have no authoritative answer in the research corpus. acorn should run a controlled experiment (ideally on a Neon/Supabase branch DB), record the result in `brain/ORG_MEMORY.md`, and promote a stance to [[OPINIONS]] once it has data. This is the "the employee forms its own view" mandate.

1. **bigint-identity vs UUIDv7 crossover point.** At what write-rate / table-size does UUIDv7's locality penalty (vs bigint) actually start to matter for an Energy-scale product? → **Experiment:** benchmark insert throughput + index size + cache-hit ratio for `bigint` vs `uuidv7()` vs `gen_random_uuid()` on a branch at 1M/10M/100M rows; write the crossover back. (DISPUTE 1 gives v4's numbers but not a v7-vs-bigint head-to-head.) _Source: `field-03` DISPUTE 1 (no v7-vs-bigint data exists)._
2. **Where exactly RLS stops scaling for Energy's tenancy.** Side B (Bytebase) asserts RLS is per-row-slow but Side A (`ecosystem-04`) says overhead is 1–5% with an indexed sargable predicate. → **Experiment:** measure RLS overhead at 10K/100K/1M/10M rows with `(select auth.uid())` + an indexed predicate, find where (if ever) it exceeds the app-filter alternative for Energy's actual query shapes. _Source: `field-03` DISPUTE 2 vs `ecosystem-04` §2 (they disagree on magnitude)._
3. **Supabase transaction-pooler (6543) × named prepared statements — current state.** Supavisor *added* named-prepared-statement support, but the research says "verify for your driver." → **Experiment:** test whether `prepare:true` works on 6543 for the current postgres-js/Drizzle/Prisma versions, or whether `prepare:false` is still mandatory. (The default stance stays `prepare:false` until proven otherwise.) _Source: `ecosystem-04` §3 (explicitly "verify for your driver")._
4. **Optimal `halfvec` vs Matryoshka-dim-reduction tradeoff for Energy's embedding model.** halfvec halves storage; reducing dims (512/256) cuts more but loses recall. → **Experiment:** measure recall@k for full-1536-`vector` vs `halfvec(1536)` vs reduced-dim on Energy's actual corpus before standardizing a default beyond "halfvec." _Source: `ecosystem-09` §3 (offers options, no Energy-specific data)._
5. **Self-host break-even (Supabase/Convex) vs managed for Energy's scale.** Research says self-host is operationally rough but gives no $ break-even for Energy. → **Experiment/cost-model** before any self-host decision; record the threshold. _Source: `ecosystem-10` §3, `ecosystem-03` §B3 (qualitative only)._

---

## D. Honest methodology gaps (what the research itself flagged)
- **X/Twitter practitioner signal was SKIPPED** — energy's scraper's search endpoint returns HTTP 404 (X rotated the GraphQL `SEARCH_DOC_ID`); the home-timeline worked but yielded only 2 tangential DB mentions. This corpus relies on GitHub issues + HN/Reddit/DEV/maintainer threads, **not** live X practitioner chatter. A future pass with a working X-search hash could add field signal. _Source: `field-00` "X/Twitter signal — SKIPPED"._
- **No primary npm-trends, no live provider-pricing pull, no head-to-head v7-vs-bigint benchmark** were performed (see B2, B5, C1). These are known holes, not silent omissions.
