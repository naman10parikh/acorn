// src/dispatch/log-step.ts — the dispatch step logger (D1).
//
// The routing loop (schema-flow.ts) emits one line per step so the step ordering is OBSERVABLE — the
// HARNESS-OVERRIDES §8 dispatch DONE-criterion is "verifiable step ordering". Each step prints a numbered
// line to stdout AND, when an observability sink already exists, appends a JSONL record to logs/runs.jsonl.
//
// Boundary with E2 (observability): E2 owns the canonical `scripts/log-run.mjs` → `logs/runs.jsonl` schema
// (model + duration + tool-calls + the DB verdict) for a WHOLE run. This helper only appends a thin
// per-STEP breadcrumb when the logs/ directory is already present — it does NOT create the dir or claim
// E2's full schema (that would be faking an un-owned component). The D1 verify line is satisfied by the
// stdout ordering ("prints the steps in order … to stdout OR logs/runs.jsonl"); the JSONL append is the
// forward-compatible hook E2 fills out. NO LLM here — pure I/O.

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The lifecycle state of a routing step as the loop walks the chain. */
export type StepStatus = "ok" | "deferred" | "blocked";

/** One step of the `acorn schema` routing loop, as logged. */
export interface FlowStep {
  /** 1-based position in the ordered chain (design=1 … eval=5). */
  readonly index: number;
  /** the step name, e.g. "design (tenancy + columns)". */
  readonly name: string;
  /** ok = ran deterministically; deferred = needs a live DB (E3); blocked = a precondition failed. */
  readonly status: StepStatus;
  /** a one-line, receipt-carrying detail (what it decided / why it deferred). */
  readonly detail: string;
  /**
   * The model that would run this step if it escalates to a sub-agent persona (D6: explicit routing, no
   * bare default). Deterministic steps carry `null` (no model needed); steps that can escalate to a review
   * persona carry the persona's pinned model (e.g. "opus" for rls-auditor / migration-safety-reviewer).
   */
  readonly model: string | null;
}

const RUNS_JSONL = join(process.cwd(), "logs", "runs.jsonl");

/**
 * Emit a single routing step. Prints a numbered, status-tagged line to the given stream (default stdout)
 * and appends a thin JSONL breadcrumb to logs/runs.jsonl IFF the logs/ directory already exists (E2's sink).
 * Returns the step unchanged so callers can collect the ordered list for assertions/tests.
 */
export function logFlowStep(step: FlowStep, stream: NodeJS.WritableStream = process.stdout): FlowStep {
  const tag = step.status === "ok" ? "✓" : step.status === "deferred" ? "→" : "✗";
  const modelNote = step.model ? `  [model: ${step.model}]` : "";
  stream.write(`  ${step.index}. ${tag} ${step.name}${modelNote}\n     ${step.detail}\n`);

  // Forward-compatible breadcrumb: only when E2's logs/ dir is already present (never create it here).
  if (existsSync(join(process.cwd(), "logs"))) {
    try {
      const record = JSON.stringify({
        ts: new Date().toISOString(),
        kind: "dispatch-step",
        index: step.index,
        step: step.name,
        status: step.status,
        model: step.model,
        detail: step.detail,
      });
      appendFileSync(RUNS_JSONL, record + "\n");
    } catch (err) {
      // Intentionally non-fatal: a breadcrumb write must never break the routing loop. E2 owns the
      // durable audit trail; this is best-effort. (typescript.md: log, don't swallow silently.)
      process.stderr.write(`[dispatch] runs.jsonl breadcrumb skipped: ${(err as Error).message}\n`);
    }
  }
  return step;
}
