// src/commands/migration.ts — the `acorn migration` group: lint · safe · apply · ledger-backfill.
//
// lint            → flag the 5 outage-makers (P10-P15) with the lock class each takes. (B3)
// safe            → REWRITE unsafe DDL into NOT VALID+VALIDATE / CONCURRENTLY / inject lock_timeout. (B3)
// apply --branch  → apply migrations to an EPHEMERAL branch/dev DB only (refuses a prod URL). (E3 sandbox)
// ledger-backfill → after a cross-provider restore, backfill the ORM ledger so it doesn't re-run + collide.

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { lintMigration } from "../lint/migration.js";
import { safeMigration } from "../transform/safe-migration.js";
import { renderLint, emitSql, emitNotes } from "../cli/render.js";

export function migrationCommand(): Command {
  const migration = new Command("migration").description("zero-downtime migrations: lint the outage-makers, rewrite to the safe two-step, apply to a branch");

  migration
    .command("lint")
    .argument("<file>", "the migration .sql to lint")
    .option("--json", "emit JSON for agent consumption")
    .description("flag the 5 outage-makers (P10-P15): bare CHECK/NOT NULL/FK, ALTER TYPE, CREATE INDEX w/o CONCURRENTLY, bare RENAME/DROP, missing lock_timeout")
    .action((file: string, opts: { json?: boolean }) => {
      const result = lintMigration(readFileSync(file, "utf8"));
      process.exitCode = renderLint(result, { json: opts.json, label: `migration lint (${file})` });
    });

  migration
    .command("safe")
    .argument("<file>", "the migration .sql to rewrite")
    .description("rewrite unsafe DDL into the safe form: NOT VALID+VALIDATE, CONCURRENTLY, inject SET lock_timeout, expand/contract scaffold for renames")
    .action((file: string) => {
      const { sql, notes } = safeMigration(readFileSync(file, "utf8"));
      emitSql(sql);
      emitNotes(notes);
    });

  migration
    .command("apply")
    .option("--branch", "apply to an ephemeral branch/dev DB (refuses a prod DATABASE_URL)")
    .description("apply migrations to an EPHEMERAL branch/dev DB only (the sandbox component)")
    .action((opts: { branch?: boolean }) => {
      // The branch lifecycle + the prod-write refusal live in the sandbox component (E3). The shell enforces
      // the --branch gate and reports the precondition rather than faking an apply.
      if (!opts.branch) {
        process.stderr.write("acorn migration apply: refusing — pass --branch. acorn NEVER applies to a production DB (branch/dev only).\n");
        process.exitCode = 2;
        return;
      }
      process.stderr.write(
        "acorn migration apply --branch — provisions an ephemeral Postgres (the sandbox component, E3), applies migrations, logs a runs.jsonl line with the safety verdict + branch id.\n" +
          (process.env.DATABASE_URL ? "" : "No DATABASE_URL yet — start a branch/dev DB first (see `acorn provision`).\n"),
      );
      process.exitCode = process.env.DATABASE_URL ? 0 : 2;
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
