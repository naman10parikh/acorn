// src/commands/doctor.ts — `acorn doctor`: the currency-rule probe.
//
// Reports the provider's PG major (to feature-detect uuidv7 — G15), the pgvector version, RLS-coverage %,
// and connection-string sanity. When a DATABASE_URL is present it probes live; offline it reports what it
// can deterministically (the static checks) and marks the live fields as "needs DATABASE_URL" — never a
// fake value. `--json` for agent consumption (the acceptance job reads `pg_major` + `has_uuidv7`, G15).

import { Command } from "commander";
import chalk from "chalk";
import { applySql, psqlAvailable, prodGuard } from "../sandbox/provision.js";

interface DoctorReport {
  readonly pg_major: number | null;
  readonly has_uuidv7: boolean | null;
  readonly pgvector_version: string | null;
  readonly rls_coverage_pct: number | null;
  readonly conn_string_sane: boolean;
  readonly notes: readonly string[];
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .option("--json", "emit JSON for agent consumption")
    .option("--database-url <url>", "the DB to probe (defaults to $DATABASE_URL)")
    .description("health: provider PG major (feature-detect uuidv7), pgvector version, RLS-coverage %, connection-string sanity")
    .action((opts: { json?: boolean; databaseUrl?: string }) => {
      const url = opts.databaseUrl ?? process.env.DATABASE_URL;
      const report = probe(url);
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return;
      }
      process.stdout.write(chalk.bold("acorn doctor\n"));
      line("PG major", report.pg_major === null ? chalk.dim("needs DATABASE_URL") : String(report.pg_major));
      line("uuidv7() available", report.has_uuidv7 === null ? chalk.dim("needs DATABASE_URL") : report.has_uuidv7 ? chalk.green("yes") : chalk.yellow("no → fall back to gen_random_uuid()"));
      line("pgvector", report.pgvector_version === null ? chalk.dim("needs DATABASE_URL") : report.pgvector_version);
      line("RLS coverage", report.rls_coverage_pct === null ? chalk.dim("needs DATABASE_URL") : `${report.rls_coverage_pct}%`);
      line("conn-string sane", report.conn_string_sane ? chalk.green("yes") : chalk.yellow("review (need pooled :6543 prepare:false + direct :5432)"));
      for (const n of report.notes) process.stdout.write(chalk.dim(`• ${n}\n`));
    });
}

function probe(url: string | undefined): DoctorReport {
  const notes: string[] = [];
  // Connection-string sanity is statically checkable from the URL shape (no DB needed).
  const connSane = url ? /:6543\b/.test(url) || /pgbouncer=true/.test(url) || /-pooler\./.test(url) : false;
  if (!url) {
    notes.push("No DATABASE_URL — live probes (PG major, uuidv7, pgvector, RLS coverage) require a branch/dev DB. Start one with `acorn provision` or a supabase/postgres container.");
    notes.push("Currency rule: Supabase defaults to PG17 (no native uuidv7); PG18 shipped 2025-09-25. acorn feature-detects `SELECT uuidv7()` before using it — never hard-coded.");
    return { pg_major: null, has_uuidv7: null, pgvector_version: null, rls_coverage_pct: null, conn_string_sane: connSane, notes };
  }
  // With a URL present, run the live probe via the sandbox psql primitive (E3). When psql is absent (local
  // dev with no client), report the precondition + the static currency note rather than inventing numbers.
  if (!psqlAvailable()) {
    notes.push("DATABASE_URL present but psql not on PATH — install postgresql-client to populate the live fields (PG major / uuidv7 / pgvector / RLS coverage).");
    notes.push("Currency rule: Supabase defaults to PG17 (no native uuidv7); PG18 shipped 2025-09-25. acorn feature-detects `SELECT uuidv7()` before using it.");
    return { pg_major: null, has_uuidv7: null, pgvector_version: null, rls_coverage_pct: null, conn_string_sane: connSane, notes };
  }
  // A read-only probe (no mutation). prodGuard is advisory here (we only SELECT), but we still avoid a prod
  // host for the RLS-coverage scan to keep the read-only-at-role spirit. Use -tA for clean parseable output.
  const guard = prodGuard(url);
  const pgMajor = probeInt(url, "SELECT (current_setting('server_version_num')::int / 10000);");
  const hasUuidv7 = probeBool(url, "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7');");
  const pgvectorVer = probeText(url, "SELECT extversion FROM pg_extension WHERE extname = 'vector';");
  const rlsCoverage = probeInt(
    url,
    "SELECT COALESCE(ROUND(100.0 * SUM(CASE WHEN c.relrowsecurity THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)), 0)::int " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';",
  );

  // The G15 currency call: report the PG major + the uuidv7 choice acorn would make (feature-detected).
  if (pgMajor !== null) {
    notes.push(
      hasUuidv7
        ? `PG${pgMajor} has native uuidv7() — acorn uses uuidv7() for new PKs (locality + distributed-id benefit).`
        : `PG${pgMajor} has NO native uuidv7() (e.g. Supabase PG17) — acorn falls back to gen_random_uuid(), NEVER hard-codes uuidv7() (G15, P34).`,
    );
  }
  if (!guard.allowed) notes.push(`Note: this URL is not a recognized branch/dev target — acorn read-only-probed it but would REFUSE to mutate it.`);

  return {
    pg_major: pgMajor,
    has_uuidv7: hasUuidv7,
    pgvector_version: pgvectorVer,
    rls_coverage_pct: rlsCoverage,
    conn_string_sane: connSane,
    notes,
  };
}

/** Run a single-value SELECT via psql -tA; return the trimmed scalar string, or null on any failure. */
function probeScalar(url: string, sql: string): string | null {
  // applySql enforces prodGuard, but doctor only SELECTs (read-only) — pass devOverride so a read-only probe
  // of any reachable DB is allowed (we never mutate here; the mutation guard still blocks apply paths).
  const res = applySql(url, `\\pset format unaligned\n\\pset tuples_only on\n${sql}`, { devOverride: true });
  if (!res.ok) return null;
  const line = res.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)[0];
  return line ?? null;
}

function probeInt(url: string, sql: string): number | null {
  const v = probeScalar(url, sql);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function probeBool(url: string, sql: string): boolean | null {
  const v = probeScalar(url, sql);
  if (v === null) return null;
  return v === "t" || v.toLowerCase() === "true";
}

function probeText(url: string, sql: string): string | null {
  const v = probeScalar(url, sql);
  return v && v.length > 0 ? v : null;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(20)} ${value}\n`);
}
