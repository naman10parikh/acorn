#!/usr/bin/env node
// src/index.ts — the `acorn` CLI entry point (the employee's hands).
//
// B2: wire the full command tree (PLAN §4) onto commander+chalk. Every command group is its own factory
// (src/commands/*.ts); this file is pure wiring — it builds the root program, registers the subcommands,
// and parses argv. The lints called by `rls`/`migration` are deterministic SQL-text checks (B3, NO LLM,
// HARNESS-OVERRIDES §4). `provision` and `backup` are thin shells here: their live internals (the
// branch-DB lifecycle, the PITR plan) belong to the sandbox component (E3) — the shells state the contract
// and the precondition rather than faking a result, exactly like `rls test` / `migration apply`.
//
// Boundary (locked): acorn owns schema / migrations / RLS / the data layer ONLY — never app code, query
// call-sites, or API routes (that is turbo/pixel).

import { createRequire } from "node:module";
import { Command } from "commander";
import { rlsCommand } from "./commands/rls.js";
import { migrationCommand } from "./commands/migration.js";
import { vectorCommand } from "./commands/vector.js";
import { connCommand } from "./commands/conn.js";
import { schemaCommand } from "./commands/schema.js";
import { doctorCommand } from "./commands/doctor.js";
import { brainCommand } from "./commands/brain.js";
import { resolveSandbox, type SandboxProvider } from "./sandbox/branch-lifecycle.js";

/** Read the package version from package.json (ships at the package root; dist/ is one level down). */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildProgram(): Command {
  const program = new Command("acorn")
    .description(
      "acorn — the database employee. Schema, migrations, RLS, pgvector, and tenant isolation that survive production. Boundary: schema/data-layer only (not app code). Powered by Energy.",
    )
    .version(readVersion(), "-v, --version", "print the acorn version");

  // The full command tree (PLAN §4). Each group is a deterministic factory; schema is THE acceptance verb.
  program.addCommand(schemaCommand());
  program.addCommand(rlsCommand());
  program.addCommand(migrationCommand());
  program.addCommand(vectorCommand());
  program.addCommand(connCommand());
  program.addCommand(provisionCommand());
  program.addCommand(backupCommand());
  program.addCommand(doctorCommand());
  program.addCommand(brainCommand());

  return program;
}

/**
 * `acorn provision` — the agent-provision lifecycle (Neon branch ≤500ms | Supabase branch | supabase/postgres
 * container → migrate → verify → merge-or-destroy), gated branch/dev-only (E3). Resolves the sandbox target,
 * runs prodGuard (REFUSES a prod-looking URL), and reports the outcome. NEVER provisions or writes to prod.
 */
function provisionCommand(): Command {
  return new Command("provision")
    .option("--provider <p>", "supabase | neon | postgres", "supabase")
    .option("--json", "emit JSON for agent consumption")
    .description("agent-provision lifecycle: an ephemeral branch/dev DB → migrate → verify → merge-or-destroy (branch/dev only; refuses prod)")
    .action((opts: { provider: string; json?: boolean }) => {
      const provider = (["supabase", "neon", "postgres"].includes(opts.provider) ? opts.provider : "supabase") as SandboxProvider;
      const outcome = resolveSandbox(provider);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ready: outcome.ready, branch: outcome.branchId, guard: outcome.guard, notes: outcome.notes }, null, 2) + "\n");
      } else {
        process.stderr.write(`acorn provision (provider: ${provider}) — branch/dev only; acorn NEVER writes to production (SCENARIO #8).\n`);
        process.stderr.write(`  prodGuard: ${outcome.guard.allowed ? "ALLOWED" : "REFUSED"} — ${outcome.guard.reason}\n`);
        for (const n of outcome.notes) process.stderr.write(`  • ${n}\n`);
        process.stderr.write(outcome.ready ? `  → branch ready: ${outcome.branchId}\n` : "  → no branch provisioned (precondition above) — not a fake provision.\n");
      }
      // Exit 0 only when a real branch/dev DB is ready; non-zero (precondition) otherwise. A REFUSED prod URL
      // is exit 3 (distinct from "nothing available" = 2) so a caller can tell a safety-block from a missing DB.
      process.exitCode = outcome.ready ? 0 : outcome.guard.allowed ? 2 : process.env.DATABASE_URL ? 3 : 2;
    });
}

/**
 * `acorn backup plan` — the PITR/restore plan: monitored WAL gaps, the Supabase PITR-add-on check, Neon
 * Time-Travel; emits an explicit RPO/RTO + a restore-drill step. (JTBD 6; the executable DR harness is E3.)
 */
function backupCommand(): Command {
  const backup = new Command("backup").description("backup / DR: the PITR plan (monitored WAL gaps, PITR-add-on check, Time-Travel) with an explicit RPO/RTO + a restore drill");
  backup
    .command("plan")
    .option("--provider <p>", "supabase | neon | postgres", "supabase")
    .description("emit a PITR/restore plan: WAL-gap monitoring, Supabase PITR-add-on check / Neon branch-at-timestamp, RPO/RTO, a restore-drill step (JTBD 6)")
    .action((opts: { provider: string }) => {
      process.stderr.write(
        `acorn backup plan (provider: ${opts.provider}) — a never-restored backup is a hypothesis: schedule restore drills + monitor WAL-archive success (one missing 16MB segment silently breaks the recovery chain).\n` +
          (opts.provider === "neon"
            ? "Neon: branch at the pre-incident timestamp and inspect via Time-Travel BEFORE repointing main (cheapest way to confirm what changed).\n"
            : "Supabase: second-level PITR is a PAID add-on (Pro+); lower tiers have daily-only backups, so 'undo the last 10 minutes' may be unrecoverable. acorn first checks whether the add-on is enabled and states the ACTUAL recoverable window — not a generic 'yes we have backups'.\n") +
          "The executable DR/restore drill runs against a branch via the sandbox harness (E3).\n",
      );
    });
  return backup;
}

buildProgram().parse(process.argv);
