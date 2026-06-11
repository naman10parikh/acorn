// src/lint/types.ts — shared shapes for acorn's deterministic lints.
//
// The lints are pure SQL-text/regex checks — NO LLM calls (HARNESS-OVERRIDES §4: deterministic-tool
// preference). Both the RLS lint (P1-P9) and the migration lint (P10-P15) emit a `Violation[]`; the CLI
// renders them (chalk or --json) and the MCP tools (C1) return them verbatim.

export type Severity = "error" | "warning";

export interface Violation {
  /** The pitfall id this maps to, e.g. "P1", "P10". Traces to brain/KNOWN-PITFALLS.md. */
  readonly rule: string;
  /** The table the violation concerns, if determinable (else ""). */
  readonly table: string;
  /** 1-based source line of the offending statement (0 if not line-anchored). */
  readonly line: number;
  /** error = blocks (exit non-zero); warning = advisory (does not fail the lint by itself). */
  readonly severity: Severity;
  /** Human-readable, receipt-carrying message (cites the lock class / CVE / fix). */
  readonly message: string;
}

export interface LintResult {
  readonly violations: readonly Violation[];
  /** true when there is ≥1 `error`-severity violation (the CLI exits non-zero on this). */
  readonly failed: boolean;
}

/** Build a LintResult, deriving `failed` from whether any error-severity violation exists. */
export function toResult(violations: readonly Violation[]): LintResult {
  return {
    violations,
    failed: violations.some((v) => v.severity === "error"),
  };
}
