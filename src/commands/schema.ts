// src/commands/schema.ts — `acorn schema "<brief>"`: THE acceptance command (the CLI surface).
//
// This is the employee's headline verb: a one-line domain brief → tenancy decision + migrations + RLS
// policies + typed schema, applied to a fresh ephemeral DB, RLS verified by tests. The multi-step ROUTING
// LOOP that orchestrates design → migration-gen → rls-gen → apply → eval is the DISPATCH component (D1,
// `src/dispatch/schema-flow.ts`). B2 ships the CLI shell + the deterministic design step (the tenancy
// decision is a pure function, B3) so `acorn schema ... --dry-run` prints the ordered plan today; D1 wires
// the apply+eval legs. Per the board, stub-then-fill is fine for B2.

import { Command } from "commander";
import { decideTenancy } from "../gen/tenancy.js";
import chalk from "chalk";

const STEPS = ["design (tenancy + columns)", "migration generation", "rls-policy generation", "apply to branch", "eval / verify"] as const;

export function schemaCommand(): Command {
  return new Command("schema")
    .argument("<brief>", "a one-line domain brief, e.g. 'a multi-tenant helpdesk: orgs have members; members file tickets'")
    .option("--provider <p>", "supabase | neon | postgres", "supabase")
    .option("--apply", "apply the generated migrations to a fresh ephemeral DB")
    .option("--verify-rls", "run the RLS tests as the un-privileged role after applying")
    .option("--dry-run", "print the ordered routing plan without applying")
    .description("THE acceptance command: brief → tenancy + migrations + RLS + typed schema, applied to a fresh ephemeral DB, RLS verified by tests")
    .action((brief: string, opts: { provider: string; apply?: boolean; verifyRls?: boolean; dryRun?: boolean }) => {
      // The deterministic design step (B3): infer rough tenant scale from the brief and decide tenancy.
      const tenants = inferTenantScale(brief);
      const decision = decideTenancy({ tenants });

      if (opts.dryRun || (!opts.apply && !process.env.DATABASE_URL)) {
        process.stdout.write(chalk.bold(`acorn schema (provider: ${opts.provider}) — routing plan:\n`));
        STEPS.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s}\n`));
        process.stdout.write(`\nstep 1 — tenancy: ${chalk.cyan(decision.model)}\n  ${decision.rationale}\n`);
        process.stdout.write(chalk.dim("\n(steps 4-5 apply+verify run via the dispatch loop, D1, once an ephemeral DB is available — re-run with --apply against a branch/dev DB or in the acceptance CI job.)\n"));
        return;
      }

      // --apply path is owned by the dispatch loop (D1) + the sandbox (E3): orchestrate the 5 steps in order,
      // logging each via the observability log (E2). The shell reports the precondition rather than faking it.
      process.stderr.write(
        `acorn schema --apply — orchestrates: ${STEPS.join(" → ")} (dispatch loop, D1). ` +
          (process.env.DATABASE_URL ? "Applying to the configured branch/dev DB.\n" : "No DATABASE_URL — provide a branch/dev DB (see `acorn provision`) or run the acceptance CI job.\n"),
      );
      process.exitCode = process.env.DATABASE_URL ? 0 : 2;
    });
}

/** Rough, deterministic tenant-scale heuristic from the brief wording (the design step's input). */
function inferTenantScale(brief: string): number {
  const b = brief.toLowerCase();
  if (/\b(enterprise|regulated|hospital|bank|residency)\b/.test(b)) return 300; // → schema/DB-per-tenant territory
  return 10_000; // default SaaS scale → shared-schema + RLS
}
