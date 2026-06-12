// src/sandbox/provision.ts — acorn's sandbox primitives (E3, SANDBOX/INFRA component).
//
// HARNESS-OVERRIDES §11 (OVERRIDE — the vertical's runtime IS a database): acorn's true sandbox is an
// ephemeral Postgres (a Neon branch ≤500ms / a Supabase branch / a `supabase/postgres` container in an E2B
// microVM). This module holds the SAFETY-CRITICAL, DB-agnostic primitives:
//   • prodGuard()      — the load-bearing invariant: REFUSE a production-looking DATABASE_URL. Pure +
//                        unit-testable WITHOUT a DB (the integration test asserts it always blocks prod).
//   • psqlAvailable()  — is the `psql` system client present? (the zero-npm-dep way to talk to Postgres —
//                        psql is a system binary like actionlint/gh, NOT a project dependency).
//   • applySql()       — run a .sql script against a branch/dev DB via psql (used by apply + the RLS tests).
//   • runRlsAsRole()   — run a probe SET ROLE to the UN-PRIVILEGED role (authenticated/anon) + a query — the
//                        flagship invariant (NEVER the SQL Editor / postgres / service_role).
//
// NO LLM, NO npm DB driver. When `psql` or a branch DB is absent (local dev: docker daemon down, no psql),
// the callers report the precondition HONESTLY (skip) — they never fabricate an apply or a query result.
// The prod-write refusal is enforced at THIS layer, before any psql call, so it holds even with a live DB.

import { spawnSync } from "node:child_process";

/**
 * Decide whether a DATABASE_URL is safe for acorn to MUTATE (apply migrations / write). acorn operates
 * BRANCH/DEV ONLY — it must never apply to production (OPINIONS §Backup, SCENARIO #8). This is deny-by-
 * default: a URL is allowed ONLY if it is positively recognized as ephemeral/local/branch.
 *
 * Allowed (branch/dev): localhost / 127.0.0.1 / a docker-network host / a Neon `-pooler`/branch endpoint
 * with a branch marker / an explicit ACORN_DEV_DB=1 override (the operator vouches it's a throwaway).
 * Refused (prod): everything else, and ANY url with an obvious prod marker (`prod`, `production`, a bare
 * Supabase project pooler host with no branch marker).
 */
export interface ProdGuardResult {
  readonly allowed: boolean;
  readonly reason: string;
}

export function prodGuard(databaseUrl: string | undefined, opts?: { devOverride?: boolean }): ProdGuardResult {
  const devOverride = opts?.devOverride ?? process.env.ACORN_DEV_DB === "1";

  if (!databaseUrl || databaseUrl.trim().length === 0) {
    return { allowed: false, reason: "no DATABASE_URL — acorn never guesses a target; provide a branch/dev URL." };
  }

  const url = databaseUrl.toLowerCase();

  // Hard refuse on any explicit production marker, even if a dev override is set (belt + suspenders).
  if (/\bprod\b|production|\bprd\b/.test(url)) {
    return { allowed: false, reason: "DATABASE_URL contains a production marker (prod/production) — acorn refuses to mutate production (SCENARIO #8). Use a branch/dev DB." };
  }

  // Positively-recognized ephemeral/local targets.
  const isLocal = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|postgres|db|host\.docker\.internal)[:\/]/.test(url) || /@\[::1\]/.test(url);
  const isNeonBranch = /\.neon\.tech\b/.test(url) && /(-pooler|br-|branch)/.test(url);
  const isSupabaseBranch = /supabase\.(co|com)\b/.test(url) && /(branch|-dev|preview)/.test(url);

  if (isLocal) return { allowed: true, reason: "local/containerized Postgres (localhost / docker host) — safe to mutate (ephemeral)." };
  if (isNeonBranch) return { allowed: true, reason: "Neon branch endpoint — safe to mutate (branch is throwaway, merged/destroyed on completion)." };
  if (isSupabaseBranch) return { allowed: true, reason: "Supabase database branch — safe to mutate (per-PR branch)." };

  if (devOverride) {
    return { allowed: true, reason: "ACORN_DEV_DB=1 override — operator vouches this is a throwaway dev DB (acorn still refuses any prod marker)." };
  }

  return {
    allowed: false,
    reason:
      "DATABASE_URL is not recognized as a branch/dev target (not localhost, not a Neon/Supabase branch). " +
      "acorn refuses to mutate it (could be production). Use a branch/dev DB, or set ACORN_DEV_DB=1 if you are CERTAIN it is throwaway.",
  };
}

/** Is the `psql` system client on PATH? (the zero-dep way acorn talks to Postgres.) */
export function psqlAvailable(): boolean {
  const res = spawnSync("psql", ["--version"], { encoding: "utf8" });
  return res.status === 0;
}

export interface SqlRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * Run a SQL script against a branch/dev DB via psql. ENFORCES prodGuard first — a prod URL is refused
 * before psql is ever invoked. Returns the captured result; the caller decides pass/fail. `ON_ERROR_STOP`
 * makes a mid-script failure non-zero (no half-applied state slips through silently).
 */
export function applySql(databaseUrl: string, sql: string, opts?: { devOverride?: boolean }): SqlRunResult {
  const guard = prodGuard(databaseUrl, opts);
  if (!guard.allowed) {
    return { ok: false, stdout: "", stderr: `acorn: refused — ${guard.reason}`, code: null };
  }
  if (!psqlAvailable()) {
    return { ok: false, stdout: "", stderr: "acorn: psql not on PATH — install postgresql-client to apply against a branch/dev DB.", code: null };
  }
  const res = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q"], {
    input: sql,
    encoding: "utf8",
  });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status };
}

/**
 * Run a query AS THE UN-PRIVILEGED ROLE — the flagship invariant (test RLS as authenticated/anon, NEVER as
 * postgres/service_role/the SQL Editor; OPINIONS top, SCENARIOS top). Wraps the query in a transaction that
 * SET ROLE <role> + (for authenticated) sets the request.jwt.claims GUC so auth.uid() resolves, then runs
 * the probe and ROLLBACKs (read-only-at-role by construction). Returns the probe output for the caller to
 * assert isolation against.
 */
export function runRlsAsRole(
  databaseUrl: string,
  role: "authenticated" | "anon",
  probeSql: string,
  opts?: { jwtSub?: string; devOverride?: boolean },
): SqlRunResult {
  const claims = role === "authenticated" && opts?.jwtSub ? opts.jwtSub : "";
  // Build the role-scoped probe. The set_config of request.jwt.claims lets Supabase's auth.uid() resolve to
  // the test subject; for anon there are no claims. BEGIN/ROLLBACK keeps it side-effect-free (inspection).
  const wrapped = [
    "BEGIN;",
    claims
      ? `SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: claims }).replace(/'/g, "''")}', true);`
      : "-- anon: no jwt claims",
    `SET LOCAL ROLE ${role};`,
    probeSql.trim().endsWith(";") ? probeSql.trim() : probeSql.trim() + ";",
    "ROLLBACK;",
  ].join("\n");
  return applySql(databaseUrl, wrapped, opts);
}
