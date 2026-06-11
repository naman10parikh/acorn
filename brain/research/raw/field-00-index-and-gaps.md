# Field Intelligence — Index + GAPS-AND-DISPUTES Handoff

> Researcher: FIELD-INTELLIGENCE (acorn / Database harness, CP123 Wave-R). Captured 2026-06-11.
> The practitioner/incident layer. Complements (does NOT duplicate) the sibling ECOSYSTEM files (`ecosystem-00..12`),
> which cover the tooling landscape. This set is war-stories, named breaches, quoted taste, and verbatim disputes.

## Files in this set
- `field-01-rls-production-footguns.md` — CVE-2025-48757 (170 apps, Matt Palmer), Supabase MCP lethal trifecta (Willison), the 8-row catalog of RLS mistakes that pass tests and leak, Clerk `::text` gotcha (verified in energy source).
- `field-02-migration-war-stories.md` — transaction-pooler × prepared-statements (the universal breakage), full Neon→Supabase+Drizzle war story with verbatim errors, Supavisor "max connections" (downvoted 12×), Convex's own Aurora→PlanetScale re-platform, migrating-away-from-Convex friction, Drizzle rename=DROP+ADD.
- `field-03-taste-and-disputes.md` — THREE verbatim disputes (UUIDv4-vs-bigint, RLS-vs-app-authz, ORM-vs-raw-SQL), 7 taste nuggets. This is the primary GAPS-AND-DISPUTES feed.
- `field-04-2026-invalidates-2025.md` — PG18 (2025-09-25, uuidv7/AIO/skip-scan), Prisma 7 ("a Prisma that no longer exists"), Neon=Databricks / Drizzle=PlanetScale, secure-by-default-is-dashboard-only trap, agent-DB threat model is post-2024.
- `field-05-migration-disasters-and-pgvector-field-reality.md` — the 4-hour/$52K/84M-row postmortem (with the one-line fix they missed), the cross-confirmed 5-mistakes canon, pgvector "defaults are for a demo" + halfvec 50% + HNSW-vs-IVFFlat.

## The 3 DISPUTES (both sides cited verbatim in field-03) — for GAPS-AND-DISPUTES
1. **PK type:** "Avoid UUIDv4, use bigint identity" (Andy Atkinson, hard numbers: 8.5M vs 27K buffer hits) vs "UUIDs preferable for distributed/no-round-trip ids" (pganalyze/brandur). **Resolved 2026 by PG18 `uuidv7()`** — v4 is the agreed-wrong default; live split is bigint-identity vs UUIDv7.
2. **Authorization:** "Put authz IN the DB, it's un-bypassable" (PostgREST/Supabase/Neon doctrine) vs "RLS is too coarse/slow/untestable for real authz, use app+OPA" (Bytebase/Permit). **2026 consensus = hybrid:** RLS as the floor (tenant isolation), app-layer for rich rules.
3. **ORM:** "ORMs are the cigarettes of data engineering" (anti-ORM, 4x throughput claim) vs "fine productivity tool with a SQL escape hatch" (Tiger Data/pragmatic). **Mature line:** ORM for 90% CRUD, raw SQL for the hot 10% — which favors a thin SQL-first ORM (Drizzle) for an agent.

## The 3 things I could NOT confirm (hand to GAPS-AND-DISPUTES)
1. **PG18 GA on managed providers + native `uuidv7()` exposure.** PG18 core GA'd 2025-09-25 (confirmed). I did NOT confirm the exact date Supabase/Neon default new projects to PG18 or expose `uuidv7()`. → acorn must **feature-detect** (`SELECT uuidv7()` probe), fall back to `gen_random_uuid()` if <18. _(Sources: postgresql.org PG18 news; chrislongros 2026-03 implies broad Q1-2026 availability but not provider-specific.)_
2. **"Drizzle overtook Prisma in npm downloads, May 2026."** Repeated by multiple secondary blogs; NOT verified against npm-trends directly (both FIELD and ECOSYSTEM flag this). Treat as directional adoption signal, not fact.
3. **"Drizzle's acute migration issues have settled."** Inferred from the ABSENCE of 2025+ high-comment issues (top pain is all 2023-24 vintage); this is a comment-volume inference, not a stability guarantee. The "never `drizzle-kit push` to prod" precaution still stands.

### Bonus unconfirmed (vendor-benchmark caution)
- The "**4x throughput SQL vs ORM**" number is the **EdgeDB** benchmark (a vendor selling an ORM alternative) — magnitude plausible for naive-ORM-vs-hand-SQL, but not a neutral source. Cite as "vendor-benchmarked."

## X/Twitter signal — SKIPPED (honestly reported)
Attempted via energy's `scripts/x-content-intel/scrape.py` + the `~/.claude/x-auth/x-session.json` (April-2024-era) session. The **home-timeline endpoint works** (pulled 35 tweets), but the **search endpoint returns HTTP 404** — X has rotated the `SEARCH_DOC_ID` GraphQL query hash, so topic-relevant search (the useful path) is broken. The home feed (Naman's personalized For You) yielded only 2 tangential DB mentions (one PHP/no-framework SaaS stack; one Convex mention by @ivanburazin / Daytona founder re: a Fable+Daytona+Convex "Replit clone" oneshot) — not substantive practitioner signal. **Per mission rules, X-search is noted as skipped; this report relies on GitHub issues + HN/Reddit/DEV/maintainer threads via WebSearch/WebFetch.**

## The single highest-leverage finding for acorn (if you read one line)
**The test-environment privilege mismatch is why RLS bugs ship.** Devs validate policies as `postgres`/`service_role`/SQL-Editor (where RLS is invisible), then ship to a world where `anon`/`authenticated` is what hits the policy → CVE-2025-48757 (170 apps). **acorn's eval pyramid MUST run RLS tests as the un-privileged role.** This one rule prevents the most common, most expensive class of failure in the entire vertical.
