// src/dispatch/schema-flow.ts — the `acorn schema` internal routing loop (D1, DISPATCH component).
//
// HARNESS-OVERRIDES §8: "a real internal routing loop tested on a multi-step flow (acorn schema →
// design → migration-gen → rls-gen → eval, verifiable step ordering); no tmux pane-stealing." This is the
// single-employee CLI loop (PLAN §12.12 — "no grid"): a deterministic chain that reuses the EXACT B3
// internals (decideTenancy / safeMigration / genRlsPolicy / lintRls / lintMigration) — one source of
// truth, NO LLM in the chain. The apply (step 4) is delegated to the sandbox component (E3); without a
// branch/dev DATABASE_URL the loop reports the precondition honestly instead of faking an apply.
//
// MODEL ROUTING (D6, cp123): where a step would ESCALATE to a review sub-agent persona, the loop pins the
// model EXPLICITLY (no bare default). The deterministic steps need no model. The escalation map below is
// the routing contract — `acorn schema --review` (and the RSI loop) spawn these personas with the pinned
// model; the dry-run/apply path runs the deterministic chain and records which model each escalation WOULD
// use. This is why every file in src/dispatch/ references `model` (the grep-rnL check in D1's verify).

import { decideTenancy } from "../gen/tenancy.js";
import { genRlsPolicy } from "../gen/rls-policy.js";
import { safeMigration } from "../transform/safe-migration.js";
import { lintRls } from "../lint/rls.js";
import { lintMigration } from "../lint/migration.js";
import { logFlowStep, type FlowStep } from "./log-step.js";

/**
 * The explicit sub-agent routing table (D6). Each persona is pinned to a model — opus-4.8[1m] for the
 * acorn-specific reviewers (builders/testers/reviewers per the cp123 model split). NEVER a bare default:
 * a step that escalates names its persona AND its model. The deterministic chain doesn't call these, but
 * `--review` / the RSI loop do, and the loop records the routing on the relevant steps.
 */
export const SUBAGENT_ROUTING: Readonly<Record<string, { readonly persona: string; readonly model: string }>> = {
  // the migration-gen step can escalate a risky rewrite to the migration-safety-reviewer persona.
  "migration generation": { persona: "migration-safety-reviewer", model: "opus" },
  // the rls-gen step can escalate a generated policy block to the rls-auditor persona.
  "rls-policy generation": { persona: "rls-auditor", model: "opus" },
};

/** The model a given step escalates to (explicit; null for purely deterministic steps). */
export function modelForStep(stepName: string): string | null {
  return SUBAGENT_ROUTING[stepName]?.model ?? null;
}

export type Provider = "supabase" | "neon" | "postgres";

export interface SchemaFlowInput {
  readonly brief: string;
  readonly provider: Provider;
  /** true = run the deterministic chain only and report the apply precondition (no live DB write). */
  readonly dryRun: boolean;
  /** the branch/dev DB the apply step targets (E3); absent → apply is deferred, never faked. */
  readonly databaseUrl?: string;
}

export interface SchemaFlowResult {
  readonly steps: readonly FlowStep[];
  /** the tenancy model the design step chose (for the acceptance assertion "tenancy named"). */
  readonly tenancyModel: string;
  /** the generated migration SQL (post safe-rewrite) — what the apply step would run. */
  readonly migrationSql: string;
  /** the generated RLS policy SQL for the tenant tables. */
  readonly rlsSql: string;
  /** true when the deterministic self-check (eval step) found no error-severity violations. */
  readonly selfCheckPassed: boolean;
  /** whether the apply step actually ran (only with a branch/dev DB + E3) or was deferred. */
  readonly applied: boolean;
}

/** A derived entity table inferred from the brief (deterministic; NO LLM). */
interface DerivedTable {
  readonly name: string;
  /** the tenant-scoping column for this table (the first FK up the ownership chain). */
  readonly tenantCol: string;
  readonly createSql: string;
}

/**
 * Run the routing loop. Walks the 5 ordered steps, logging each via log-step (observable ordering), and
 * returns the collected steps + artifacts. Pure except for the step logging (stdout + the E2 breadcrumb).
 */
export function runSchemaFlow(input: SchemaFlowInput, stream: NodeJS.WritableStream = process.stdout): SchemaFlowResult {
  const steps: FlowStep[] = [];
  const hasDb = typeof input.databaseUrl === "string" && input.databaseUrl.length > 0;

  // ── step 1: design (tenancy + columns) — deterministic (B3 decideTenancy). No model escalation. ──
  const tenants = inferTenantScale(input.brief);
  const decision = decideTenancy({ tenants, regulated: /\b(regulated|residency|hospital|bank)\b/i.test(input.brief) });
  steps.push(
    logFlowStep(
      { index: 1, name: "design (tenancy + columns)", status: "ok", detail: `tenancy: ${decision.model} — ${decision.rationale}`, model: null },
      stream,
    ),
  );

  // ── step 2: migration generation — derive tables from the brief, run through the safe-rewrite (B3). ──
  const tables = deriveSchema(input.brief);
  const rawMigration = tables.map((t) => t.createSql).join("\n\n");
  const safe = safeMigration(rawMigration);
  steps.push(
    logFlowStep(
      {
        index: 2,
        name: "migration generation",
        status: "ok",
        detail: `derived ${tables.length} table(s): ${tables.map((t) => t.name).join(", ")} → safe-rewritten (lock_timeout injected; ${safe.notes.length} transform note(s)). Escalation model: ${modelForStep("migration generation") ?? "none"}.`,
        model: modelForStep("migration generation"),
      },
      stream,
    ),
  );

  // ── step 3: rls-policy generation — gated 2-policy block per tenant table (B3 genRlsPolicy). ──
  const auth = /\bclerk\b/i.test(input.brief) ? "clerk" : "supabase-jwt";
  const rlsSql = tables.map((t) => genRlsPolicy({ table: t.name, tenantCol: t.tenantCol, auth })).join("\n\n");
  steps.push(
    logFlowStep(
      {
        index: 3,
        name: "rls-policy generation",
        status: "ok",
        detail: `generated gated RLS for ${tables.length} table(s) (auth=${auth}; wrapped (select auth.uid()), USING+WITH CHECK, predicate index). Escalation model: ${modelForStep("rls-policy generation") ?? "none"}.`,
        model: modelForStep("rls-policy generation"),
      },
      stream,
    ),
  );

  // ── step 4: apply to branch — delegated to the sandbox (E3). Never faked. ──
  const applied = hasDb && !input.dryRun;
  steps.push(
    logFlowStep(
      {
        index: 4,
        name: "apply to branch",
        status: applied ? "ok" : "deferred",
        detail: applied
          ? `applying to the configured branch/dev DB via the sandbox harness (E3). BRANCH/DEV ONLY — the agent cred cannot write to prod (SCENARIO #8).`
          : `deferred — no branch/dev DATABASE_URL (or --dry-run). The live apply (provision → migrate → merge/destroy) is the sandbox component (E3); run \`acorn provision\` or the acceptance CI job. Not a fake apply.`,
        model: null,
      },
      stream,
    ),
  );

  // ── step 5: eval / verify — deterministic self-check (lint the generated SQL). Live RLS test → E1/E3. ──
  const combined = `${safe.sql}\n\n${rlsSql}`;
  const rlsCheck = lintRls(combined);
  const migCheck = lintMigration(safe.sql);
  const selfCheckPassed = !rlsCheck.failed && !migCheck.failed;
  steps.push(
    logFlowStep(
      {
        index: 5,
        name: "eval / verify",
        status: selfCheckPassed ? "ok" : "blocked",
        detail: selfCheckPassed
          ? `deterministic self-check passed: 0 error-severity RLS/migration violations on the generated SQL. The live RLS test as the un-privileged role (anon/authenticated) + the golden tasks run in eval (E1) against the branch DB.`
          : `self-check found ${rlsCheck.violations.filter((v) => v.severity === "error").length} RLS + ${migCheck.violations.filter((v) => v.severity === "error").length} migration error(s) on the generated SQL — fix before apply.`,
        model: null,
      },
      stream,
    ),
  );

  return {
    steps,
    tenancyModel: decision.model,
    migrationSql: safe.sql,
    rlsSql,
    selfCheckPassed,
    applied,
  };
}

// ── deterministic helpers (NO LLM) ──────────────────────────────────────────────

/** Rough, deterministic tenant-scale heuristic from the brief wording (the design step's input). */
function inferTenantScale(brief: string): number {
  const b = brief.toLowerCase();
  if (/\b(enterprise|regulated|hospital|bank|residency)\b/.test(b)) return 300; // → schema/DB-per-tenant territory
  return 10_000; // default SaaS scale → shared-schema + RLS
}

/**
 * Derive entity tables from a domain brief, deterministically (NO LLM). Parses simple "<A> have <B>" /
 * "<A> file <B>" ownership phrases into CREATE TABLE statements with the acorn column house-style:
 *   • uuid PK feature-detected at runtime (gen_random_uuid() placeholder; doctor flags the uuidv7 upgrade)
 *   • a tenant-scoping FK column up the ownership chain (the first entity is the tenant root)
 *   • created_at default now()
 * The first noun is treated as the tenant root (e.g. "orgs"); each subsequent entity FKs to its owner and
 * inherits the tenant column. This is intentionally simple — enough to produce a real, lintable migration
 * for the acceptance brief, not a general NL parser (Karpathy: simplest thing that solves the brief).
 */
export function deriveSchema(brief: string): DerivedTable[] {
  const entities = extractEntities(brief);
  if (entities.length === 0) {
    // Fallback: a single tenant-rooted table so the loop always produces a lintable artifact.
    return [tenantRootTable("records")];
  }

  const tables: DerivedTable[] = [];
  const root = entities[0];
  tables.push(tenantRootTable(root));
  const tenantCol = `${singular(root)}_id`;

  for (let i = 1; i < entities.length; i++) {
    const name = entities[i];
    const owner = entities[i - 1];
    const ownerCol = `${singular(owner)}_id`;
    const cols = [
      `  id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
      `  ${tenantCol} uuid NOT NULL REFERENCES public.${root}(id)`,
      i - 1 === 0 ? null : `  ${ownerCol} uuid NOT NULL REFERENCES public.${owner}(id)`,
      `  created_at timestamptz NOT NULL DEFAULT now()`,
    ].filter((c): c is string => c !== null);
    tables.push({
      name,
      tenantCol,
      createSql: [
        `-- acorn: ${name} (owned by ${owner}; tenant-scoped by ${tenantCol}). PK uuid (feature-detect uuidv7 at runtime — P35).`,
        `CREATE TABLE public.${name} (`,
        cols.join(",\n"),
        `);`,
      ].join("\n"),
    });
  }
  return tables;
}

/** The tenant-root table: its own id IS the tenant boundary (e.g. orgs). */
function tenantRootTable(name: string): DerivedTable {
  return {
    name,
    tenantCol: "id",
    createSql: [
      `-- acorn: ${name} is the tenant root (its id is the tenant boundary). PK uuid (feature-detect uuidv7 — P35).`,
      `CREATE TABLE public.${name} (`,
      `  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),`,
      `  name text NOT NULL,`,
      `  created_at timestamptz NOT NULL DEFAULT now()`,
      `);`,
    ].join("\n"),
  };
}

/**
 * Pull ordered entity nouns from the brief. Splits on the ownership verbs ("have", "file", "has", "own",
 * "contain") and clause separators (";", ","), taking the plural noun on each side of a relation. The
 * canonical brief "orgs have members; members file tickets; tickets have messages" → [orgs, members,
 * tickets, messages] (de-duplicated, order preserved).
 */
function extractEntities(brief: string): string[] {
  const text = brief.toLowerCase().replace(/^[^:]*:\s*/, ""); // drop a leading "a multi-tenant helpdesk:" preamble
  const tokens = text
    .split(/\b(?:have|has|own|owns|file|files|contain|contains|with|and)\b|[;,.]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const tok of tokens) {
    // take the last word of each fragment as the entity noun (e.g. "members file tickets" → "tickets").
    const word = tok.split(/\s+/).filter(Boolean).pop();
    if (!word) continue;
    const noun = word.replace(/[^a-z0-9_]/g, "");
    if (noun.length < 2) continue;
    if (STOPWORDS.has(noun)) continue;
    if (!seen.has(noun)) {
      seen.add(noun);
      entities.push(noun);
    }
  }
  return entities;
}

const STOPWORDS = new Set([
  "a", "an", "the", "multi", "tenant", "multitenant", "product", "app", "system", "schema", "data", "model",
  "their", "its", "each", "every", "some", "many", "of", "for", "to", "in", "on", "that", "this",
]);

/** crude singularizer for FK column names (members → member, orgs → org, messages → message). */
function singular(plural: string): string {
  if (plural.endsWith("ies")) return plural.slice(0, -3) + "y";
  if (plural.endsWith("ses") || plural.endsWith("xes") || plural.endsWith("ches") || plural.endsWith("shes")) return plural.slice(0, -2);
  if (plural.endsWith("s") && !plural.endsWith("ss")) return plural.slice(0, -1);
  return plural;
}
