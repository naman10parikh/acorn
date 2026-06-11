// src/cli/render.ts — shared CLI output helpers (chalk for humans, JSON for agents).
//
// The employee-first rule: every lint/doctor command takes `--json` so a sibling agent (turbo, the hub)
// gets a machine-parseable result, while a human at the terminal gets colored, receipt-carrying output.
// Keeping this in one tiny module so every command renders violations identically.

import chalk from "chalk";
import type { LintResult, Violation } from "../lint/types.js";

/** Print a lint result; return the process exit code (0 = clean, 1 = ≥1 error-severity violation). */
export function renderLint(result: LintResult, opts: { json?: boolean; label: string }): number {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ violations: result.violations, failed: result.failed }, null, 2) + "\n");
    return result.failed ? 1 : 0;
  }
  if (result.violations.length === 0) {
    process.stdout.write(chalk.green(`✓ ${opts.label}: 0 violations\n`));
    return 0;
  }
  process.stdout.write(chalk.bold(`${opts.label}: ${result.violations.length} finding(s)\n`));
  for (const v of result.violations) {
    process.stdout.write(`${severityTag(v)} ${chalk.dim(`[${v.rule}]`)}${v.table ? ` ${chalk.cyan(v.table)}` : ""}${v.line ? chalk.dim(` L${v.line}`) : ""}\n`);
    process.stdout.write(`    ${v.message}\n`);
  }
  return result.failed ? 1 : 0;
}

function severityTag(v: Violation): string {
  return v.severity === "error" ? chalk.red("✗ error  ") : chalk.yellow("! warning");
}

/** Print a block of generated SQL / a plan, verbatim (no color so it's copy-pasteable). */
export function emitSql(sql: string): void {
  process.stdout.write(sql + "\n");
}

/** Print notes (the "why" receipts) under a generated artifact. */
export function emitNotes(notes: readonly string[]): void {
  if (notes.length === 0) return;
  process.stderr.write(chalk.dim("\n-- acorn notes --\n"));
  for (const n of notes) process.stderr.write(chalk.dim(`• ${n}\n`));
}
