#!/usr/bin/env node
/**
 * acorn observability — the runs.jsonl aggregator view (E2, OBSERVABILITY component).
 *
 * HARNESS-OVERRIDES §10 requires "an aggregator view" over the append-only audit trail. This reads
 * logs/runs.jsonl and prints a compact summary: total runs, a per-tool breakdown, the DB-verdict
 * distribution (the load-bearing field — how many runs were safe / rewritten / blocked), and the most
 * recent N records (so the cockpit Run-Log view and the chairman can see WHAT the employee did at a glance).
 *
 * Usage:
 *   node scripts/runs-aggregate.mjs            # human summary
 *   node scripts/runs-aggregate.mjs --json     # machine summary (the cockpit reads this)
 *   node scripts/runs-aggregate.mjs --tail 20  # show the last 20 records too
 *
 * NO LLM — pure read + reduce.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_JSONL = join(REPO, "logs", "runs.jsonl");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Read + parse the JSONL; skip blank lines and the per-step dispatch breadcrumbs (kind:"dispatch-step"). */
function readRuns() {
  if (!existsSync(RUNS_JSONL)) return [];
  const lines = readFileSync(RUNS_JSONL, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const runs = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // The canonical whole-run records have a `verdict` object; dispatch breadcrumbs have kind:"dispatch-step".
      if (obj.kind === "dispatch-step") continue;
      runs.push(obj);
    } catch {
      // a malformed line never breaks the aggregate — skip it (the audit trail is append-only + best-effort).
    }
  }
  return runs;
}

/** Reduce runs into a summary object. */
function aggregate(runs) {
  const byTool = {};
  const bySafety = {};
  const byLock = {};
  let mutating = 0; // runs that carried a branch id (state-mutating DB actions)
  let coverageSum = 0;
  let coverageCount = 0;
  for (const r of runs) {
    byTool[r.tool ?? "unknown"] = (byTool[r.tool ?? "unknown"] ?? 0) + 1;
    const safety = r.verdict?.safety_class ?? "unknown";
    const lock = r.verdict?.lock_class ?? "none";
    bySafety[safety] = (bySafety[safety] ?? 0) + 1;
    byLock[lock] = (byLock[lock] ?? 0) + 1;
    if (r.branch) mutating++;
    if (typeof r.verdict?.rls_coverage_pct === "number") {
      coverageSum += r.verdict.rls_coverage_pct;
      coverageCount++;
    }
  }
  return {
    total: runs.length,
    by_tool: byTool,
    by_safety_class: bySafety,
    by_lock_class: byLock,
    state_mutating_runs: mutating,
    avg_rls_coverage_pct: coverageCount > 0 ? Math.round(coverageSum / coverageCount) : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = readRuns();
  const summary = aggregate(runs);

  if (args.json) {
    const out = { summary };
    if (args.tail) out.tail = runs.slice(-Number(args.tail === true ? 10 : args.tail));
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  process.stdout.write(`acorn runs — ${summary.total} record(s)\n`);
  process.stdout.write(`  by tool:        ${fmt(summary.by_tool)}\n`);
  process.stdout.write(`  by DB verdict:  ${fmt(summary.by_safety_class)}\n`);
  process.stdout.write(`  by lock class:  ${fmt(summary.by_lock_class)}\n`);
  process.stdout.write(`  state-mutating: ${summary.state_mutating_runs} (carried a branch id)\n`);
  process.stdout.write(`  avg RLS cov:    ${summary.avg_rls_coverage_pct === null ? "n/a" : summary.avg_rls_coverage_pct + "%"}\n`);

  if (args.tail) {
    const n = Number(args.tail === true ? 10 : args.tail);
    process.stdout.write(`\n  last ${n}:\n`);
    for (const r of runs.slice(-n)) {
      const v = r.verdict ?? {};
      process.stdout.write(
        `    ${r.ts}  ${(r.tool ?? "?").padEnd(16)} ${(v.safety_class ?? "?").padEnd(10)} ${(v.lock_class ?? "?").padEnd(18)} ${r.branch ? "branch=" + r.branch : ""}\n`,
      );
    }
  }
}

function fmt(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "(none)";
  return keys.map((k) => `${k}=${obj[k]}`).join("  ");
}

main();
