#!/usr/bin/env node
/**
 * acorn observability — append a structured run record to logs/runs.jsonl (E2, OBSERVABILITY component).
 *
 * HARNESS-OVERRIDES §10 (OVERRIDE — the load-bearing field is the DB VERDICT): every acorn run appends a
 * JSONL line carrying model + duration + tool-calls **+ the DB verdict** (the migration safety / lock-risk
 * class, the RLS-coverage %). This reuses the energy-hub `log-run.mjs` → `runs.jsonl` pattern (cp122 NOTES).
 *
 * runs.jsonl is APPEND-ONLY and committable (NOT gitignored) — it is the audit trail for any state-mutating
 * DB action (a migration applied to a branch carries its branch id), per the checklist §10 "append-only
 * audit trail for any state-mutating action". The dispatch loop (D1) writes thin per-step breadcrumbs
 * through src/dispatch/log-step.ts; THIS script writes the canonical WHOLE-RUN record with the full schema.
 *
 * Usage (the employee's runs call this; --test seeds a self-check line):
 *   node scripts/log-run.mjs --test
 *   node scripts/log-run.mjs --tool migration-apply --model opus --duration-ms 820 \
 *        --verdict safe --lock-class none --rls-coverage 100 --branch acorn-pr-42 --status ok
 *   echo '{"tool":"schema","verdict":"safe",...}' | node scripts/log-run.mjs --stdin
 *
 * The record shape (one JSON object per line):
 *   { ts, tool, model, duration_ms, tool_calls, status,
 *     verdict: { safety_class, lock_class, rls_coverage_pct }, branch, detail }
 *
 * NO LLM here — pure I/O (the same house style as the hand-rolled MCP server). Failures are non-fatal to a
 * run: a broken audit write must never break the work, but it IS logged to stderr (typescript.md: never
 * swallow silently).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS_DIR = join(REPO, "logs");
const RUNS_JSONL = join(LOGS_DIR, "runs.jsonl");

/** The DB-verdict safety classes acorn assigns a run (the load-bearing observability field). */
const SAFETY_CLASSES = ["safe", "rewritten", "blocked", "deferred", "unknown"];
/** The Postgres lock class a migration in this run would take (carried for the audit trail). */
const LOCK_CLASSES = ["none", "ShareUpdateExclusive", "AccessExclusive", "unknown"];

/** Parse `--flag value` / `--flag` argv into a flat map. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true; // bare flag
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Build a run record from flags (or a self-test line). The verdict object is the OVERRIDE field: a DB
 * employee's runs are graded on the safety/lock/coverage verdict, not just duration.
 */
function buildRecord(args) {
  const test = Boolean(args.test);
  const safetyClass = String(args.verdict ?? (test ? "safe" : "unknown"));
  const lockClass = String(args["lock-class"] ?? "none");
  return {
    ts: new Date().toISOString(),
    tool: String(args.tool ?? (test ? "self-test" : "unknown")),
    model: args.model ? String(args.model) : null, // deterministic runs have no model (null is honest)
    duration_ms: args["duration-ms"] !== undefined ? Number(args["duration-ms"]) : test ? 0 : null,
    tool_calls: args["tool-calls"] !== undefined ? Number(args["tool-calls"]) : 0,
    status: String(args.status ?? "ok"),
    // The DB verdict — the load-bearing field (HARNESS-OVERRIDES §10 override).
    verdict: {
      safety_class: SAFETY_CLASSES.includes(safetyClass) ? safetyClass : "unknown",
      lock_class: LOCK_CLASSES.includes(lockClass) ? lockClass : "unknown",
      rls_coverage_pct: args["rls-coverage"] !== undefined ? Number(args["rls-coverage"]) : null,
    },
    // branch id — present for any state-mutating DB action (a migration applied to a branch). null when none.
    branch: args.branch ? String(args.branch) : null,
    detail: args.detail ? String(args.detail) : test ? "log-run.mjs --test self-check line" : "",
  };
}

/** Append one record (object) to runs.jsonl, creating the logs/ dir if needed. Returns the record. */
export function logRun(record) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(RUNS_JSONL, JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`[log-run] runs.jsonl append failed: ${err.message}\n`);
  }
  return record;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  let record;
  if (args.stdin) {
    // Read a JSON record from stdin (the dispatch/MCP path can pipe a fully-formed record).
    const raw = readFileSync(0, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : {};
    // Always stamp ts + ensure the verdict shape exists (honest defaults).
    record = {
      ts: new Date().toISOString(),
      tool: parsed.tool ?? "unknown",
      model: parsed.model ?? null,
      duration_ms: parsed.duration_ms ?? null,
      tool_calls: parsed.tool_calls ?? 0,
      status: parsed.status ?? "ok",
      verdict: {
        safety_class: parsed.verdict?.safety_class ?? "unknown",
        lock_class: parsed.verdict?.lock_class ?? "none",
        rls_coverage_pct: parsed.verdict?.rls_coverage_pct ?? null,
      },
      branch: parsed.branch ?? null,
      detail: parsed.detail ?? "",
    };
  } else {
    record = buildRecord(args);
  }

  logRun(record);
  // Echo the appended record to stdout so a caller can confirm what was written.
  process.stdout.write(JSON.stringify(record) + "\n");
}

// Only run main when invoked directly (allow `import { logRun }` from other scripts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
