// src/mcp/tools.ts — acorn's 12 MCP tools as pure handler functions over the B2/B3 internals.
//
// C1 (HARNESS-OVERRIDES §7): acorn ships its OWN MCP server exposing the database vertical's operations —
// NOT the inherited 4-server template, NOT a Supabase-remote-MCP passthrough. Each tool here wraps acorn's
// *expertise* (lint / generate / verify / plan) so a sibling agent (turbo, the energy hub) can call e.g.
// `acorn_rls_lint` over JSON-RPC. The handlers reuse the EXACT same deterministic functions the CLI calls
// (src/lint/*, src/gen/*, src/transform/*, src/brain/search) — one source of truth, no LLM in the lints.
//
// Constitutional rule (TOOL-MATRIX §4 security rules, SCENARIO #2): the inspect-style tools that would
// touch a real DB (acorn_provision, acorn_doctor with a url, acorn_migration's apply path) default to a
// read-only-at-role, branch/dev-only, project-scoped connection and TREAT RETURNED ROWS AS UNTRUSTED. The
// live-DB legs live in the sandbox component (E3); these handlers return the plan/contract + the
// precondition rather than faking a live result — exactly the CLI's stub-then-fill discipline.

import { lintRls } from "../lint/rls.js";
import { lintMigration, migrationOutageRisks } from "../lint/migration.js";
import { safeMigration } from "../transform/safe-migration.js";
import { genRlsPolicy, type AuthMode } from "../gen/rls-policy.js";
import { genConnString, type ConnProvider, type ConnRuntime } from "../gen/conn-string.js";
import { planVector, type VectorProvider } from "../gen/vector-plan.js";
import { decideTenancy } from "../gen/tenancy.js";
import { searchBrain } from "../brain/search.js";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A JSON-RPC tool definition surfaced by `tools/list`. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** the handler: validated args in, a JSON-serialisable result out. */
  readonly handler: (args: Record<string, unknown>) => unknown;
}

// ── small arg helpers (defensive: MCP args arrive untrusted over the wire) ──────
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
}
function optStr(args: Record<string, unknown>, key: string, dflt: string): string {
  const v = args[key];
  return typeof v === "string" ? v : dflt;
}
function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) throw new Error(`'${key}' must be a number`);
  return n;
}

/**
 * Resolve `sql` that may be a literal SQL string OR a path to a .sql file/dir. Mirrors the CLI's
 * `acorn rls lint <file|dir>` ergonomics so an agent can pass either. A path is only read if it actually
 * exists on disk; otherwise the value is treated as inline SQL (the common agent case).
 */
function resolveSql(value: string): string {
  try {
    if (existsSync(value)) {
      const st = statSync(value);
      if (st.isFile()) return readFileSync(value, "utf8");
      if (st.isDirectory()) {
        return readdirSync(value)
          .filter((f) => f.endsWith(".sql"))
          .sort()
          .map((f) => readFileSync(join(value, f), "utf8"))
          .join("\n");
      }
    }
  } catch {
    // fall through — treat as inline SQL
  }
  return value;
}

/** The 12 acorn tools (PLAN §4 MCP list), 1:1 with the CLI verbs. */
export const TOOLS: readonly ToolDef[] = [
  {
    name: "acorn_schema",
    description:
      "THE acceptance verb. A one-line domain brief → tenancy decision + migration plan + RLS policies + typed-schema notes. The live apply+verify-RLS legs run via the dispatch loop (D1) + sandbox (E3) when a branch/dev DATABASE_URL is present; without one this returns the deterministic design (tenancy + ordered routing plan), never a fake apply.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "a one-line domain brief, e.g. 'a multi-tenant helpdesk: orgs have members; members file tickets'" },
        provider: { type: "string", enum: ["supabase", "neon", "postgres"], description: "the target provider (default supabase)" },
        apply: { type: "boolean", description: "apply the generated migrations to a fresh ephemeral branch/dev DB (needs DATABASE_URL)" },
      },
      required: ["brief"],
    },
    handler: (args) => {
      const brief = str(args, "brief");
      const provider = optStr(args, "provider", "supabase");
      const apply = args.apply === true;
      const tenants = /\b(enterprise|regulated|hospital|bank|residency)\b/i.test(brief) ? 300 : 10_000;
      const decision = decideTenancy({ tenants });
      const steps = ["design (tenancy + columns)", "migration generation", "rls-policy generation", "apply to branch", "eval / verify"];
      const canApply = apply && typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;
      return {
        provider,
        tenancy: { model: decision.model, rationale: decision.rationale, notes: decision.notes },
        steps,
        applied: canApply ? "delegated-to-dispatch-and-sandbox" : false,
        precondition: canApply
          ? "DATABASE_URL present — the dispatch loop (D1) + sandbox (E3) apply migrations to the branch/dev DB and verify RLS as the un-privileged role."
          : "No branch/dev DATABASE_URL — provide one (acorn_provision) or run the acceptance CI job. This is the deterministic design, not a fake apply.",
      };
    },
  },
  {
    name: "acorn_rls_lint",
    description:
      "Flag every public.* table without RLS; unwrapped auth.uid(); missing WITH CHECK; recursive-policy risk; missing predicate index; the Clerk ::text cast (P1-P9). Deterministic SQL-text analysis, NO LLM. `sql` may be inline SQL or a path to a .sql file/dir.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "inline SQL OR a path to a .sql file or directory" },
        json: { type: "boolean", description: "(ignored — the MCP result is always structured)" },
      },
      required: ["sql"],
    },
    handler: (args) => {
      const result = lintRls(resolveSql(str(args, "sql")));
      return {
        violations: result.violations.map((v) => ({ rule: v.rule, table: v.table, line: v.line, severity: v.severity, message: v.message })),
        failed: result.failed,
      };
    },
  },
  {
    name: "acorn_rls_gen",
    description:
      "Emit the gated 2-policy block for a tenant table: a service_role gate (documentation of intent) + a per-tenant policy using the WRAPPED (select auth.uid()), BOTH USING and WITH CHECK, plus the predicate index and the Clerk ::text cast when auth=clerk (SCENARIO B2 — the cast is mandatory or the policy silently denies all).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        tenant_col: { type: "string", description: "the tenant-scoping column, e.g. org_id, user_id" },
        auth: { type: "string", enum: ["clerk", "supabase-jwt"], description: "the auth provider (drives the ::text cast)" },
      },
      required: ["table", "tenant_col", "auth"],
    },
    handler: (args) => {
      const auth = (optStr(args, "auth", "supabase-jwt") === "clerk" ? "clerk" : "supabase-jwt") as AuthMode;
      const policy_sql = genRlsPolicy({ table: str(args, "table"), tenantCol: str(args, "tenant_col"), auth });
      return { policy_sql };
    },
  },
  {
    name: "acorn_rls_test",
    description:
      "Run a policy as the UN-PRIVILEGED role (anon | authenticated) against an ephemeral branch/dev DB and assert tenant isolation. NEVER the Supabase SQL Editor (it runs as postgres and bypasses ALL RLS — the flagship rule). The live ephemeral-DB harness is the sandbox component (E3); without a branch DATABASE_URL this returns the contract + precondition, not a fake pass.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "the policy SQL (inline or path)" },
        as: { type: "string", enum: ["anon", "authenticated"], description: "the un-privileged role to test as" },
      },
      required: ["sql", "as"],
    },
    handler: (args) => {
      const as = optStr(args, "as", "authenticated");
      const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;
      return {
        isolated: hasDb ? "delegated-to-sandbox" : null,
        rows: null,
        as,
        precondition:
          "RLS tests run as the un-privileged role (SET ROLE " +
          as +
          " + request.jwt.claims), NEVER the SQL Editor. The live ephemeral-Postgres harness is the sandbox component (E3): start one with `docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 supabase/postgres:15.8.1`, then test/integration/rls.test.ts asserts isolation. " +
          (hasDb ? "DATABASE_URL present — the sandbox harness performs the live assertion." : "No branch/dev DATABASE_URL yet — this is a not-yet-wired result, not a fake pass."),
      };
    },
  },
  {
    name: "acorn_migration_lint",
    description:
      "Flag the 5 outage-makers (P10-P15) with the Postgres lock class each takes: bare ADD CONSTRAINT CHECK / SET NOT NULL / ADD FK, ALTER COLUMN TYPE, CREATE INDEX w/o CONCURRENTLY, bare RENAME/DROP, missing lock_timeout. Deterministic, NO LLM. `sql` may be inline or a path.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "inline migration SQL OR a path to a .sql file" },
        json: { type: "boolean", description: "(ignored — the MCP result is always structured)" },
      },
      required: ["sql"],
    },
    handler: (args) => {
      const sql = resolveSql(str(args, "sql"));
      const failed = lintMigration(sql).failed;
      return { outage_risks: migrationOutageRisks(sql).map((r) => ({ rule: r.rule, lock_class: r.lockClass, line: r.line, severity: r.severity, message: r.message })), failed };
    },
  },
  {
    name: "acorn_migration_safe",
    description:
      "Rewrite unsafe DDL into the safe form: bare CHECK/NOT NULL/FK → NOT VALID + VALIDATE; CREATE INDEX → CONCURRENTLY; inject SET lock_timeout; expand/contract scaffold for RENAME/ALTER TYPE (G5, SCENARIO #4 — the 84M-row/4h12m outage the two-step did in 42min/$0). Deterministic text rewrite, NO LLM.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "the migration SQL to rewrite (inline or path)" } },
      required: ["sql"],
    },
    handler: (args) => {
      const { sql, notes } = safeMigration(resolveSql(str(args, "sql")));
      return { rewritten_sql: sql, notes };
    },
  },
  {
    name: "acorn_vector_plan",
    description:
      "Choose HNSW + halfvec(≥1536-dim) + op-class, emit the CREATE TABLE/INDEX, inject hnsw.iterative_scan for tenant-filtered ANN, record embedding model+dim (OPINIONS §pgvector, SCENARIOS #9/#10). Deterministic, NO LLM.",
    inputSchema: {
      type: "object",
      properties: {
        dim: { type: "number", description: "embedding dimension, e.g. 1536" },
        provider: { type: "string", enum: ["supabase", "neon"] },
        table: { type: "string", description: "the embeddings table name (default documents)" },
      },
      required: ["dim", "provider"],
    },
    handler: (args) => {
      const provider = (optStr(args, "provider", "supabase") === "neon" ? "neon" : "supabase") as VectorProvider;
      const plan = planVector({ dim: num(args, "dim"), provider, table: optStr(args, "table", "documents") });
      return { table_sql: plan.tableSql, index_sql: plan.indexSql, notes: plan.notes };
    },
  },
  {
    name: "acorn_conn_gen",
    description:
      "Emit the MANDATORY two-connection-string contract: pooled :6543 (prepare:false) for the app + direct :5432 for migrations/seeds, with connection_limit≈1 for serverless. The #1 production breakage in the vertical (SCENARIO #11/#12). Deterministic, NO LLM.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["supabase", "neon"] },
        runtime: { type: "string", enum: ["serverless", "serverful"] },
      },
      required: ["provider", "runtime"],
    },
    handler: (args) => {
      const provider = (optStr(args, "provider", "supabase") === "neon" ? "neon" : "supabase") as ConnProvider;
      const runtime = (optStr(args, "runtime", "serverless") === "serverful" ? "serverful" : "serverless") as ConnRuntime;
      const c = genConnString(provider, runtime);
      return { pooled_url_template: c.pooledUrlTemplate, direct_url_template: c.directUrlTemplate, driver_flags: c.driverFlags, env: c.env, notes: c.notes };
    },
  },
  {
    name: "acorn_provision",
    description:
      "Agent-provision lifecycle: boot an ephemeral branch/dev Postgres (Neon branch ≤500ms | Supabase branch | supabase/postgres container) → migrate → verify → merge-or-destroy. BRANCH/DEV ONLY — refuses a prod DATABASE_URL (SCENARIO #8). The live lifecycle is the sandbox component (E3); without a branch DATABASE_URL this returns the contract + precondition, never a fake provision.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["supabase", "neon", "postgres"] },
        schema_path: { type: "string", description: "path to the migrations to apply on the branch" },
      },
      required: ["provider"],
    },
    handler: (args) => {
      const provider = optStr(args, "provider", "supabase");
      const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;
      return {
        branch_id: null,
        applied: false,
        provider,
        verify_report:
          "Branch/dev ONLY — acorn NEVER targets a prod DATABASE_URL (the agent cred cannot write to production; role/scoping blocks it, SCENARIO #8). The live branch lifecycle (provision → migrate → RLS-test → merge/destroy) is the sandbox component (E3). " +
          (hasDb ? "DATABASE_URL present — E3 provisions the branch and applies migrations." : "No branch/dev DATABASE_URL yet — not-yet-wired, not a fake provision."),
      };
    },
  },
  {
    name: "acorn_backup_plan",
    description:
      "Emit a PITR/restore plan: monitored WAL-archive gaps (one missing 16MB segment breaks the chain), the Supabase PITR-add-on check (second-level PITR is a paid add-on; lower tiers are daily-only), Neon branch-at-timestamp Time-Travel, an explicit RPO/RTO + a restore-drill step (JTBD 6).",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", enum: ["supabase", "neon", "postgres"] } },
      required: ["provider"],
    },
    handler: (args) => {
      const provider = optStr(args, "provider", "supabase");
      const isNeon = provider === "neon";
      return {
        rpo: isNeon ? "near-zero (branch at timestamp T)" : "second-level IF the Supabase PITR add-on is enabled; else last daily backup (data-loss window up to 24h)",
        rto: isNeon ? "instant branch-at-timestamp; inspect via Time-Travel BEFORE repointing main" : "restore-to-second with the add-on; else restore the last daily backup",
        wal_monitoring: "Monitor WAL-archive success — a single missing 16MB segment silently caps recovery at the gap. A never-restored backup is a hypothesis.",
        restore_drill: "Schedule a periodic restore drill that actually restores into a throwaway DB and verifies row counts — never assume backups work.",
        provider,
      };
    },
  },
  {
    name: "acorn_doctor",
    description:
      "Health probe: provider PG major (to feature-detect uuidv7 — G15), pgvector version, RLS-coverage %, connection-string sanity. With a branch/dev DATABASE_URL it probes live (read-only-at-role); offline it returns the static checks (conn-string sanity) + the currency rule, marking live fields null — never a fake value.",
    inputSchema: {
      type: "object",
      properties: { database_url: { type: "string", description: "the branch/dev DB to probe (defaults to $DATABASE_URL)" } },
      required: [],
    },
    handler: (args) => {
      const url = optStr(args, "database_url", process.env.DATABASE_URL ?? "");
      const connSane = url.length > 0 ? /:6543\b/.test(url) || /pgbouncer=true/.test(url) || /-pooler\./.test(url) : false;
      return {
        pg_major: null,
        has_uuidv7: null,
        pgvector_version: null,
        rls_coverage_pct: null,
        conn_string_sane: connSane,
        notes: [
          url.length > 0
            ? "DATABASE_URL present — the live probe (PG major / uuidv7 / pgvector / RLS coverage) is performed by the sandbox driver (E3), read-only-at-role, branch/dev only."
            : "No DATABASE_URL — live probes need a branch/dev DB. Supabase defaults to PG17 (no native uuidv7); acorn feature-detects `SELECT uuidv7()` before using it, never hard-codes it (G15, PITFALL P34).",
        ],
      };
    },
  },
  {
    name: "acorn_brain_search",
    description:
      "BM25 search over acorn's expertise brain (brain/*.md — the Memory component). Returns ranked hits {file, score, excerpt} from the six brain artifacts. Use to retrieve acorn's stance/pitfall/scenario for a question (e.g. 'filtered ANN over-filter' → BATTLE-TESTED-SCENARIOS #9).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "max hits (default 5)" },
      },
      required: ["query"],
    },
    handler: (args) => {
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const hits = searchBrain(str(args, "query"), { limit });
      return { hits: hits.map((h) => ({ file: h.file, score: h.score, excerpt: h.excerpt })) };
    },
  },
];

/** Map for O(1) dispatch by tool name. */
export const TOOL_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
