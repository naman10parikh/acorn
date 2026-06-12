// src/commands/schema.ts — `acorn schema "<brief>"`: THE acceptance command (the CLI surface).
//
// This is the employee's headline verb: a one-line domain brief → tenancy decision + migrations + RLS
// policies + typed schema, applied to a fresh ephemeral DB, RLS verified by tests. The multi-step ROUTING
// LOOP that orchestrates design → migration-gen → rls-gen → apply → eval is the DISPATCH component (D1,
// `src/dispatch/schema-flow.ts`). This command is a thin CLI shell over `runSchemaFlow`: it parses argv,
// runs the loop (which logs each step in order — the §8 "verifiable step ordering" criterion), and prints
// the generated artifacts. The apply leg (step 4) is delegated to the sandbox (E3); without a branch/dev
// DATABASE_URL the loop reports the precondition honestly rather than faking an apply.

import { Command } from "commander";
import chalk from "chalk";
import { runSchemaFlow, type Provider } from "../dispatch/schema-flow.js";

export function schemaCommand(): Command {
  return new Command("schema")
    .argument("<brief>", "a one-line domain brief, e.g. 'a multi-tenant helpdesk: orgs have members; members file tickets'")
    .option("--provider <p>", "supabase | neon | postgres", "supabase")
    .option("--apply", "apply the generated migrations to a fresh ephemeral DB")
    .option("--verify-rls", "run the RLS tests as the un-privileged role after applying")
    .option("--dry-run", "print the ordered routing plan without applying")
    .description("THE acceptance command: brief → tenancy + migrations + RLS + typed schema, applied to a fresh ephemeral DB, RLS verified by tests")
    .action((brief: string, opts: { provider: string; apply?: boolean; verifyRls?: boolean; dryRun?: boolean }) => {
      const provider = (["supabase", "neon", "postgres"].includes(opts.provider) ? opts.provider : "supabase") as Provider;
      // --dry-run (or no --apply and no DB) runs the deterministic chain only and reports the apply precondition.
      const dryRun = opts.dryRun === true || (!opts.apply && !process.env.DATABASE_URL);

      process.stdout.write(chalk.bold(`acorn schema (provider: ${provider}) — routing loop:\n`));
      const result = runSchemaFlow({ brief, provider, dryRun, databaseUrl: process.env.DATABASE_URL });

      process.stdout.write(`\n${chalk.bold("tenancy")}: ${chalk.cyan(result.tenancyModel)}\n`);
      process.stdout.write(
        chalk.dim(
          `\n(migration + RLS SQL generated; the apply+verify-RLS legs run via the sandbox component (E3) against a branch/dev DB — re-run with --apply against a branch/dev DB, or in the acceptance CI job.)\n`,
        ),
      );

      // Honest exit: the deterministic chain succeeded if the self-check passed. If --apply was requested
      // without a branch/dev DB, the apply step was DEFERRED (not failed) — signal the precondition with a
      // non-zero code so a caller/CI can tell "design ran but nothing was applied" apart from a clean apply.
      if (opts.apply && !result.applied) process.exitCode = 2;
      else if (!result.selfCheckPassed) process.exitCode = 1;
    });
}
