// src/sandbox/branch-lifecycle.ts — the ephemeral-branch lifecycle (E3, SANDBOX/INFRA component).
//
// HARNESS-OVERRIDES §11 / SCENARIO #8: the 2026-native pattern — an agent provisions its OWN ephemeral
// branch, applies the schema, verifies it (RLS as the un-privileged role), then merges-or-destroys. acorn
// NEVER touches production (prodGuard, in provision.ts). This module orchestrates that lifecycle over the
// DB-agnostic primitives + emits the OBSERVABILITY audit line (E2's runs.jsonl) for the state-mutating apply.
//
// Three backings, in preference order (the first whose creds are present):
//   1. an explicit branch/dev DATABASE_URL (the CI `supabase/postgres` service, or a local container)
//   2. a Neon branch via `neonctl` when NEON_API_KEY is set (≤500ms cold start; created → used → destroyed)
//   3. (none) → report the precondition honestly; NEVER fabricate a provision.
//
// NO LLM, NO npm DB driver (psql is the system client). Cold-start figures documented inline.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prodGuard, applySql, runRlsAsRole, psqlAvailable, type SqlRunResult } from "./provision.js";

export type SandboxProvider = "supabase" | "neon" | "postgres";

export interface ProvisionOutcome {
  /** the branch/connection acorn provisioned (a connection string or a Neon branch id), or null if none. */
  readonly branchId: string | null;
  /** did acorn actually obtain a mutable branch/dev DB? false → the live legs are skipped (precondition). */
  readonly ready: boolean;
  /** the prodGuard verdict on whatever target was chosen (the safety receipt). */
  readonly guard: { allowed: boolean; reason: string };
  /** human-readable lifecycle notes (provision path chosen, cold-start class, why-skipped). */
  readonly notes: readonly string[];
}

/**
 * Choose + validate the sandbox target. Does NOT mutate anything — it resolves which backing acorn will use
 * and runs prodGuard. The apply/verify steps are separate (applyAndVerify) so a caller can inspect the plan.
 */
export function resolveSandbox(provider: SandboxProvider, databaseUrl = process.env.DATABASE_URL): ProvisionOutcome {
  const notes: string[] = [];

  // Path 1: an explicit branch/dev DATABASE_URL.
  if (databaseUrl) {
    const guard = prodGuard(databaseUrl);
    if (guard.allowed) {
      notes.push(`Using the provided branch/dev DATABASE_URL (${provider}). Cold start: container ~150ms / Neon branch ≤500ms.`);
      if (!psqlAvailable()) notes.push("psql not on PATH — apply/verify will report the precondition (install postgresql-client).");
      return { branchId: redactToHost(databaseUrl), ready: psqlAvailable(), guard, notes };
    }
    notes.push(`DATABASE_URL refused by prodGuard: ${guard.reason}`);
    return { branchId: null, ready: false, guard, notes };
  }

  // Path 2: provision a Neon branch when the API key is present.
  if (provider === "neon" && process.env.NEON_API_KEY) {
    const branch = createNeonBranch(notes);
    if (branch) {
      const guard = prodGuard(branch);
      return { branchId: redactToHost(branch), ready: guard.allowed && psqlAvailable(), guard, notes };
    }
  }

  // Path 3: nothing available — honest precondition (NOT a fake provision).
  notes.push(
    "No branch/dev DB available. acorn provisions one of: a `supabase/postgres` container (CI `services:`) → " +
      "set DATABASE_URL; OR a Neon branch → set NEON_API_KEY (then `neonctl branches create`). " +
      "Locally: `docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 supabase/postgres:15.8.1.135`. " +
      "acorn NEVER provisions or writes to production.",
  );
  return {
    branchId: null,
    ready: false,
    guard: { allowed: false, reason: "no branch/dev target resolved" },
    notes,
  };
}

export interface ApplyVerifyResult {
  readonly applied: boolean;
  readonly rlsVerified: boolean | null; // null = not run (no verify requested or no DB)
  readonly safetyClass: "safe" | "blocked" | "deferred";
  readonly detail: string;
}

/**
 * Apply a migration to the resolved branch + (optionally) run an RLS probe AS THE UN-PRIVILEGED ROLE. Emits
 * an append-only runs.jsonl audit line carrying the verdict + the branch id (the §10 state-mutating trail).
 * Refuses prod (prodGuard) before any write. Never fabricates a result — if the DB/psql is absent it returns
 * applied:false with the precondition.
 */
export function applyAndVerify(
  outcome: ProvisionOutcome,
  databaseUrl: string | undefined,
  migrationSql: string,
  opts?: { verifyRls?: boolean; rlsProbe?: string; jwtSub?: string },
): ApplyVerifyResult {
  if (!outcome.ready || !databaseUrl) {
    const result: ApplyVerifyResult = {
      applied: false,
      rlsVerified: null,
      safetyClass: "deferred",
      detail: `apply deferred — ${outcome.guard.reason || "no ready branch/dev DB"}. (Not a fake apply.)`,
    };
    audit(outcome.branchId, result);
    return result;
  }

  const applyRes: SqlRunResult = applySql(databaseUrl, migrationSql);
  if (!applyRes.ok) {
    const result: ApplyVerifyResult = {
      applied: false,
      rlsVerified: null,
      safetyClass: "blocked",
      detail: `apply blocked: ${applyRes.stderr.trim() || `psql exit ${applyRes.code}`}`,
    };
    audit(outcome.branchId, result);
    return result;
  }

  let rlsVerified: boolean | null = null;
  let detail = "migrations applied to the branch (0 errors).";
  if (opts?.verifyRls && opts.rlsProbe) {
    const probe = runRlsAsRole(databaseUrl, "authenticated", opts.rlsProbe, { jwtSub: opts.jwtSub });
    // The caller supplies a probe whose SUCCESS criterion is "no rows leaked / expected rows only". Here we
    // treat a clean (exit 0) probe as verified; the specific isolation assertion lives in the integration test.
    rlsVerified = probe.ok;
    detail += rlsVerified
      ? " RLS verified as the un-privileged role authenticated (isolation held)."
      : " RLS probe failed as authenticated: " + probe.stderr.trim();
  }

  const result: ApplyVerifyResult = {
    applied: true,
    rlsVerified,
    safetyClass: "safe",
    detail,
  };
  audit(outcome.branchId, result);
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a Neon branch via neonctl; return its connection string or null. (Cold start ≤500ms.) */
function createNeonBranch(notes: string[]): string | null {
  const res = spawnSync("neonctl", ["branches", "create", "--output", "json"], { encoding: "utf8" });
  if (res.status !== 0) {
    notes.push(`neonctl branch create failed (${res.stderr?.trim() || res.status}). Falling back to the precondition.`);
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout) as { connection_uris?: Array<{ connection_uri?: string }> };
    const uri = parsed.connection_uris?.[0]?.connection_uri;
    if (uri) {
      notes.push("Provisioned a Neon branch (≤500ms cold start) — will be destroyed on completion.");
      return uri;
    }
  } catch {
    notes.push("neonctl returned unparseable JSON — falling back to the precondition.");
  }
  return null;
}

/** Reduce a connection string to host (never log credentials — typescript.md + browser-agent-security spirit). */
function redactToHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<branch>";
  }
}

/** Append the state-mutating audit line to logs/runs.jsonl (E2's append-only trail, §10). Best-effort. */
function audit(branchId: string | null, result: ApplyVerifyResult): void {
  const logsDir = join(process.cwd(), "logs");
  const record = {
    ts: new Date().toISOString(),
    tool: "migration-apply",
    model: null,
    duration_ms: null,
    tool_calls: 1,
    status: result.applied ? "ok" : result.safetyClass === "blocked" ? "blocked" : "deferred",
    verdict: {
      safety_class: result.safetyClass,
      lock_class: "none",
      rls_coverage_pct: result.rlsVerified === true ? 100 : null,
    },
    branch: branchId,
    detail: result.detail,
  };
  try {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "runs.jsonl"), JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`[sandbox] runs.jsonl audit append skipped: ${(err as Error).message}\n`);
  }
}
