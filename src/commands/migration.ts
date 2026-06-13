// src/commands/migration.ts — the `acorn migration` group: lint · safe · apply · ledger-backfill.
//
// lint            → flag the 5 outage-makers (P10-P15) with the lock class each takes. (B3)
// safe            → REWRITE unsafe DDL into NOT VALID+VALIDATE / CONCURRENTLY / inject lock_timeout. (B3)
// apply --branch  → apply migrations to an EPHEMERAL branch/dev DB only (refuses a prod URL). (E3 sandbox)
// ledger-backfill → after a cross-provider restore, backfill the ORM ledger so it doesn't re-run + collide.

import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { lintMigration } from "../lint/migration.js";
import { safeMigration } from "../transform/safe-migration.js";
import { renderLint, emitSql, emitNotes } from "../cli/render.js";
import { resolveSandbox, applyAndVerify, type SandboxProvider } from "../sandbox/branch-lifecycle.js";

/**
 * Read a single migration .sql file with a graceful error instead of a raw fs stack trace.
 * `migration lint`/`safe`/`apply` operate on ONE file (unlike `rls lint`, which globs a dir),
 * so a missing path or a directory is a user error → a clear message + exit 2 (the same
 * "path not found" convention `rls lint` uses), NEVER an uncaught ERR_FS exception.
 */
function readMigrationFile(file: string, verb: string): string {
  let st;
  try {
    st = statSync(file);
  } catch {
    process.stderr.write(`acorn migration ${verb}: file not found: ${file}\n`);
    process.exit(2);
  }
  if (st.isDirectory()) {
    process.stderr.write(
      `acorn migration ${verb}: ${file} is a directory — pass a single .sql migration file (use 'acorn rls lint <dir>' to scan a directory).\n`,
    );
    process.exit(2);
  }
  return readFileSync(file, "utf8");
}

export function migrationCommand(): Command {
  const migration = new Command("migration").description("zero-downtime migrations: lint the outage-makers, rewrite to the safe two-step, apply to a branch");

  migration
    .command("lint")
    .argument("<file>", "the migration .sql to lint")
    .option("--json", "emit JSON for agent consumption")
    .description("flag the 5 outage-makers (P10-P15): bare CHECK/NOT NULL/FK, ALTER TYPE, CREATE INDEX w/o CONCURRENTLY, bare RENAME/DROP, missing lock_timeout")
    .action((file: string, opts: { json?: boolean }) => {
      const result = lintMigration(readMigrationFile(file, "lint"));
      process.exitCode = renderLint(result, { json: opts.json, label: `migration lint (${file})` });
    });

  migration
    .command("safe")
    .argument("<file>", "the migration .sql to rewrite")
    .description("rewrite unsafe DDL into the safe form: NOT VALID+VALIDATE, CONCURRENTLY, inject SET lock_timeout, expand/contract scaffold for renames")
    .action((file: string) => {
      const { sql, notes } = safeMigration(readMigrationFile(file, "safe"));
      emitSql(sql);
      emitNotes(notes);
    });

  migration
    .command("apply")
    .argument("[file]", "the migration .sql to apply (the sandbox applies it to a branch/dev DB)")
    .option("--branch", "apply to an ephemeral branch/dev DB (refuses a prod DATABASE_URL)")
    .option("--provider <p>", "supabase | neon | postgres", "postgres")
    .description("apply migrations to an EPHEMERAL branch/dev DB only (the sandbox component, E3)")
    .action((file: string | undefined, opts: { branch?: boolean; provider: string }) => {
      // --branch is REQUIRED: acorn never applies to a non-branch (could be prod). The prod-write refusal is
      // enforced at the sandbox layer (prodGuard) before any psql call, so it holds even with a live DB.
      if (!opts.branch) {
        process.stderr.write("acorn migration apply: refusing — pass --branch. acorn NEVER applies to a production DB (branch/dev only).\n");
        process.exitCode = 2;
        return;
      }
      const provider = (["supabase", "neon", "postgres"].includes(opts.provider) ? opts.provider : "postgres") as SandboxProvider;
      const outcome = resolveSandbox(provider);
      for (const n of outcome.notes) process.stderr.write(`  • ${n}\n`);

      // Read the migration to apply (or note that the schema-flow would supply it). Without a file we still
      // exercise the lifecycle + the audit line, but apply nothing (no fabricated SQL). A bad path is a
      // graceful error (readMigrationFile), not a raw fs stack trace.
      const sql = file ? readMigrationFile(file, "apply") : "-- acorn: no migration file given; provision-only lifecycle check.\n";
      const result = applyAndVerify(outcome, process.env.DATABASE_URL, sql, { verifyRls: false });
      process.stderr.write(`  → ${result.detail}\n`);
      // Exit 0 only on a real apply; otherwise signal the precondition (deferred/blocked), never a fake pass.
      process.exitCode = result.applied ? 0 : 2;
    });

  migration
    .command("ledger-backfill")
    .argument("<dump>", "the restored schema dump")
    .description("after a cross-provider restore, backfill __drizzle_migrations/_prisma_migrations so the ORM doesn't re-run + collide (SCENARIO #6)")
    .action((dump: string) => {
      process.stderr.write(
        `acorn migration ledger-backfill — after restoring ${dump}, the ORM ledger is empty so it re-runs every migration against the populated schema (DrizzleQueryError: type "X" already exists, SCENARIO #6).\n` +
          "Backfill the ledger: insert each migration's id/hash/timestamp into __drizzle_migrations (Prisma: _prisma_migrations) so the ORM believes they already ran. Then `drizzle-kit migrate` reports 'no migrations to apply'.\n",
      );
      // The executable ledger write is part of the provision/apply harness (E3) — the shell documents the contract.
    });

  return migration;
}
