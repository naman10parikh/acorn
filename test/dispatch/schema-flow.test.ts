// test/dispatch/schema-flow.test.ts — the D1 routing-loop contract.
//
// Asserts the HARNESS-OVERRIDES §8 dispatch criterion: a real internal routing loop with VERIFIABLE STEP
// ORDERING (design → migration-gen → rls-gen → apply → eval), that the loop reuses the B3 internals to
// generate REAL lintable SQL (the self-check passes), that the apply leg is deferred (never faked) without
// a branch/dev DB, and that the model routing is EXPLICIT (D6) on the escalation steps.

import { describe, it, expect } from "vitest";
import { runSchemaFlow, deriveSchema, modelForStep, SUBAGENT_ROUTING } from "../../src/dispatch/schema-flow.js";

// A sink that discards the per-step log output (we assert on the returned structure, not stdout).
const devnull = { write: () => true } as unknown as NodeJS.WritableStream;

const CANONICAL = "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages";

describe("schema-flow routing loop (D1)", () => {
  it("runs the 5 steps in order: design → migration → rls → apply → eval", () => {
    const r = runSchemaFlow({ brief: CANONICAL, provider: "postgres", dryRun: true }, devnull);
    expect(r.steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(r.steps.map((s) => s.name)).toEqual([
      "design (tenancy + columns)",
      "migration generation",
      "rls-policy generation",
      "apply to branch",
      "eval / verify",
    ]);
  });

  it("derives the 4 entity tables from the canonical brief, tenant-rooted at orgs", () => {
    const tables = deriveSchema(CANONICAL);
    expect(tables.map((t) => t.name)).toEqual(["orgs", "members", "tickets", "messages"]);
    // orgs is the tenant root (its own id is the boundary); the rest are tenant-scoped by org_id.
    expect(tables[0].tenantCol).toBe("id");
    expect(tables[1].tenantCol).toBe("org_id");
    expect(tables[3].tenantCol).toBe("org_id");
  });

  it("generates SQL that passes acorn's OWN deterministic self-check (0 error violations)", () => {
    // The loop dog-foods its lints: the migration + RLS it generates must lint clean. This proves the loop
    // produces CORRECT SQL (RLS enabled, wrapped auth, USING+WITH CHECK, indexed predicate), not just any.
    const r = runSchemaFlow({ brief: CANONICAL, provider: "postgres", dryRun: true }, devnull);
    expect(r.selfCheckPassed).toBe(true);
    // RLS-enable lives in the rls-gen artifact (step 3), not the migration (step 2). The self-check lints
    // the COMBINED SQL, so RLS-on is satisfied for every table → 0 P1 violations.
    expect(r.rlsSql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(r.rlsSql).toMatch(/\(select auth\.uid\(\)\)/i);
    expect(r.rlsSql).toMatch(/with check/i);
    expect(r.migrationSql).toMatch(/CREATE TABLE public\.orgs/i);
  });

  it("defers the apply step without a branch/dev DB (never a fake apply)", () => {
    const r = runSchemaFlow({ brief: CANONICAL, provider: "postgres", dryRun: true }, devnull);
    expect(r.applied).toBe(false);
    const applyStep = r.steps.find((s) => s.name === "apply to branch");
    expect(applyStep?.status).toBe("deferred");
    expect(applyStep?.detail).toMatch(/not a fake apply/i);
  });

  it("routes the escalation steps to an EXPLICIT model (D6 — no bare default)", () => {
    // migration-gen → migration-safety-reviewer@opus; rls-gen → rls-auditor@opus. The deterministic steps
    // (design/apply/eval) carry no model. Every escalation names BOTH a persona and a model.
    expect(modelForStep("migration generation")).toBe("opus");
    expect(modelForStep("rls-policy generation")).toBe("opus");
    expect(modelForStep("design (tenancy + columns)")).toBeNull();
    for (const route of Object.values(SUBAGENT_ROUTING)) {
      expect(route.persona).toBeTruthy();
      expect(route.model).toBeTruthy();
    }
  });

  it("picks the Clerk ::text cast when the brief mentions Clerk auth", () => {
    const r = runSchemaFlow({ brief: "a Clerk-authed SaaS: orgs have members", provider: "supabase", dryRun: true }, devnull);
    expect(r.rlsSql).toMatch(/::text/i);
  });
});
