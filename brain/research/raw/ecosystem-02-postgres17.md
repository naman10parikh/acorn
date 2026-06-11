# Ecosystem Research — PostgreSQL 17 (and the road to 18) — June 2026

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.

## 1. PG17 — released 2024-09-26, "turned one" Sept 2025. The deltas that matter for an agent-built app

_Primary source: <https://www.postgresql.org/about/news/postgresql-17-released-2936/> (2024-09-26) and release notes <https://www.postgresql.org/docs/17/release-17.html>._

### Backup / DR (directly relevant to acorn's backup/PITR ownership)
- **Incremental `pg_basebackup`** — backs up only blocks changed since the last base/incremental, using **WAL summarization**. `pg_combinebackup` reconstructs a full backup from base + incremental chain. Large-DB backup time drops sharply. _Source: <https://www.percona.com/blog/the-powerful-features-released-in-postgresql-17-beta-2/>; <https://www.enterprisedb.com/blog/postgresql-17-unveiled-key-highlights-data-backup-data-warehousing-and-more>._
  - **Gotcha:** requires `summarize_wal = on` BEFORE the base backup, else there's nothing to diff against. Incremental backups are useless without the WAL summarizer enabled in advance.
- **`pg_dump --filter`** — file-driven include/exclude of objects (cleaner than long `-t`/`-T` lists).

### Replication / HA
- **Logical replication slot failover** — `pg_create_logical_replication_slot()` gains a 5th arg + `sync_replication_slots = on` so logical slots survive a primary failover (slot sync to standby). Before PG17, a failover orphaned logical subscribers and forced a full resync. _Source: <https://www.instaclustr.com/blog/postgresql-17-turns-one-reflecting-on-a-year-of-innovation/>; release notes._
- **`pg_createsubscriber`** — converts a physical standby into a logical replica fast (no initial table copy).
- **`pg_upgrade` preserves logical replication slots/subscription state** — future major upgrades no longer drop replication. This is a big operational win for zero-downtime major upgrades.

### Performance
- **New memory mgmt for `VACUUM`** — up to ~20x less memory, faster vacuums on large tables (the dead-tuple store switched to a TID-store/radix structure). _Source: release notes; Percona blog._
- **Streaming I/O for sequential scans / `ANALYZE`** — read-ahead improves large scans.
- **B-tree improvements for `IN (...)` / `= ANY(...)`** — multiple values handled in one index scan.
- **`JSON_TABLE()` + SQL/JSON constructors** (`JSON`, `JSON_SCALAR`, `JSON_QUERY`, `JSON_VALUE`, `JSON_EXISTS`) — SQL:2023 JSON path support; turn JSON into relational rows in a query.
- **`MERGE` gains `RETURNING`** and a `WHEN NOT MATCHED BY SOURCE` clause.

### Dev-facing
- **`COPY ... ON_ERROR ignore`** + `log_verbosity` — bulk loads don't abort on one bad row (huge for agent-driven data imports).
- **`random(min, max)`** built-in.
- **`transaction_timeout`** GUC — kill any txn (incl. idle-in-txn) past a deadline. Useful guardrail for agent-run sessions that might leave a txn open.

## 2. PG18 status (June 2026)
PG18 is the 2025 annual major (PG follows a ~yearly Sept cadence: 17 in 2024, 18 in 2025). Known PG18 headline items widely reported: **async I/O (io_uring) subsystem**, **UUIDv7 generation built-in (`uuidv7()`)**, **virtual generated columns**, **skip-scan for B-tree**, **OAuth/JWT auth for connections**. _Source: PostgreSQL release cadence + <https://pulse.support/kb/postgresql-releases> ("What's New in PG 16, 17, and 18")._ **[FLAG — exact PG18 GA date + final feature set need a dated postgresql.org confirmation; treat the above as high-probability, verify in synthesis. See GAPS.]**

### Why PG18 matters to acorn
- **`uuidv7()` in core** — time-ordered UUIDs = far better index locality than `gen_random_uuid()` (UUIDv4, random → index bloat + cache misses on inserts). energy uses `gen_random_uuid()` everywhere; **acorn should recommend UUIDv7 for high-insert tables once on PG18** (or the `pg_uuidv7` extension on PG17). _Source: pg_uuidv7 extension <https://github.com/fboulnois/pg_uuidv7>._
- **Async I/O** — meaningful throughput gains for read-heavy agent workloads.
- **Virtual generated columns** — the modern replacement for energy's *functional* FTS GIN index: a `GENERATED ... STORED` (or virtual) `tsvector` column the planner always uses (see internal ref B7).

## 3. Managed-provider lag (the practical gotcha)
You rarely run vanilla PG. Supabase, Neon, RDS, Cloud SQL each lag core by 0–12 months and may withhold a feature (e.g. some don't expose `summarize_wal`/incremental basebackup, or restrict `io_uring`). **Always check the provider's supported-version + supported-extension page, not postgresql.org.** Neon, for example, is a re-architected storage engine (not stock PG storage), so PG17's incremental-basebackup is irrelevant there — Neon does branching/PITR its own way (see `ecosystem-03-neon.md`). _Source: provider docs; reasoning._

## 4. Agent-operating notes
- CLIs an agent uses: `psql`, `pg_dump`/`pg_restore`, `pg_basebackup`, `pg_combinebackup` (PG17), `pgbench` (load test). On managed providers most are gated — the provider CLI/MCP replaces them.
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` is the agent's primary perf tool; pair with `auto_explain` + `pg_stat_statements` (enable both for any acorn-managed DB).
