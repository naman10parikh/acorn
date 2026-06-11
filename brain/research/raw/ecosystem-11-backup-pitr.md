# Ecosystem Research — Backup & Point-in-Time Recovery (Postgres, June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.
> energy has NO backup/PITR story in any migration file — acorn OWNS this end-to-end.

## 1. PITR fundamentals (the mechanism every agent must understand)
PITR = **base backup + replayed archived WAL** to reach any moment. Enable continuous archiving:
- `wal_level = replica` (or higher),
- `archive_mode = on`,
- `archive_command = '...'` (ship each completed WAL segment to durable, off-box storage).
_Source: <https://www.postgresql.org/docs/current/continuous-archiving.html>; <https://www.jusdb.com/blog/postgresql-point-in-time-recovery-pitr>._

**THE killer gotcha:** WAL segments are **16 MB each**; if you archive every segment between two base backups **with no gaps**, you can recover to **any microsecond** in that window — **but a SINGLE missing WAL segment breaks the chain** and caps recovery at the last segment before the gap. → **WAL archiving must be monitored for gaps/failures; a silently-failing `archive_command` = silent loss of recoverability.** _Source: postgresql.org continuous-archiving + search corpus._

## 2. Tooling (self-managed)
- **pgBackRest** — the modern default: full + **incremental + differential** backups, parallel processing, encryption, compression, backup *validation*, S3/GCS/Azure backends. **Parallel restore RTO for a 500 GB DB is typically <30 min on modern storage.** _Source: <https://dev.to/mohhddhassan/postgresql-backups-and-point-in-time-recovery-with-pgbackrest-13gp>; <https://www.percona.com/blog/postgresql-backup-strategy-enterprise-grade-environment/>._
- **Barman** — DR-focused alt: remote backups, PITR, parallel ops, compression. pgBackRest vs Barman is the standard self-managed bake-off. _Source: <https://severalnines.com/blog/automating-backups-and-disaster-recovery-in-postgresql-at-scale-pgbackrest-vs-barman/>._
- **PG17 angle:** incremental `pg_basebackup` + `pg_combinebackup` make the base-backup half cheaper (see `ecosystem-02`), but pgBackRest already did incrementals — PG17 mainly helps the no-extra-tooling path.

## 3. Managed providers — PITR is mostly handed to you (but know the limits)
- **Neon** — storage engine natively saves WAL + snapshots and **reconstructs any point in time**; supports **Time Travel queries** (query the DB *as of* a past timestamp via a branch) BEFORE you commit to a restore. Restore = create a branch at timestamp T, repoint. This is the slickest PITR UX in the space (branch-based, instant, no WAL-replay wait). _Source: <https://neon.com/blog/point-in-time-recovery-in-postgres>._
- **Supabase** — PITR is a **paid add-on** (Pro+), built on WAL archiving + the underlying infra; daily backups on lower tiers, PITR (down to the second, configurable retention) on higher tiers. Free/lower tiers get only daily logical/physical backups, NOT second-level PITR. _Source: Supabase backups docs <https://supabase.com/docs/guides/platform/backups>; [FLAG — exact tier→retention numbers shift; verify current pricing page. See GAPS.]_
- **RDS/Aurora/Cloud SQL** — automated backups + PITR within a retention window (default ~7 days, max ~35) via continuous WAL to object storage.

## 4. The rule everyone violates: TEST YOUR RESTORES
"A backup you have never restored is a hypothesis, not a backup." Best practices (all sources agree): **regularly test restores**, automate backup jobs, **monitor backup success/failure** (alert on `archive_command` failures + WAL gaps), store backups **off the primary** and in a **different region**, define explicit **RPO** (how much data you can lose) and **RTO** (how long to recover), and document the runbook. _Source: percona + jusdb + oneuptime 2026-01-21._

### RPO / RTO quick definitions for the harness brain
- **RPO** = max acceptable data loss (e.g. "5 min" → WAL must ship ≥ every 5 min; use `archive_timeout`).
- **RTO** = max acceptable downtime to recover (e.g. "30 min" → pick tooling/infra that restores in time; pgBackRest parallel restore for ~500GB ≈ <30 min).

## 5. acorn house rules (draft)
1. Every acorn-managed DB has continuous WAL archiving (or a managed equiv) + **monitored archive success** (alert on gap/failure).
2. **Restore drills** scheduled (e.g. monthly) into a throwaway env; record the measured RTO.
3. State explicit RPO/RTO per product in the brain; choose tooling to meet them.
4. Supabase products that matter → enable the **PITR add-on** (don't rely on daily-only backups).
5. Neon products → use **branch-based PITR + Time Travel** to *inspect* before restoring (cheaper than full restore to debug "what changed").
6. Before any risky migration → take/confirm a fresh base backup or branch point (so the migration is reversible by restore, not just by down-migration).

## 6. Agent-operating notes
- An agent rarely runs `pg_basebackup`/`pgBackRest` directly on managed providers — it uses the provider API/CLI/MCP to trigger a backup or create a restore-branch. On self-host, it drives pgBackRest via shell.
- For "undo the last 10 minutes" requests: Neon Time-Travel/branch is fastest; Supabase needs the PITR add-on + a restore (slower); raw PG needs WAL replay to a `recovery_target_time`.
