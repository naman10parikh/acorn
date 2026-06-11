// src/commands/doctor.ts — `acorn doctor`: the currency-rule probe.
//
// Reports the provider's PG major (to feature-detect uuidv7 — G15), the pgvector version, RLS-coverage %,
// and connection-string sanity. When a DATABASE_URL is present it probes live; offline it reports what it
// can deterministically (the static checks) and marks the live fields as "needs DATABASE_URL" — never a
// fake value. `--json` for agent consumption (the acceptance job reads `pg_major` + `has_uuidv7`, G15).

import { Command } from "commander";
import chalk from "chalk";

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
  // With a URL present, the live `pg`-driver probe is wired in the sandbox component (E3) — it runs
  // `SHOW server_version_num`, `SELECT extversion FROM pg_extension WHERE extname='vector'`, the uuidv7
  // feature-probe, and the RLS-coverage query. The shell records that the URL is present and defers the
  // live read to E3 rather than inventing numbers.
  notes.push("DATABASE_URL present — live probe (PG major / uuidv7 / pgvector / RLS coverage) is performed by the sandbox driver (E3). Re-run after the provision harness lands to populate the live fields.");
  return { pg_major: null, has_uuidv7: null, pgvector_version: null, rls_coverage_pct: null, conn_string_sane: connSane, notes };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(20)} ${value}\n`);
}
