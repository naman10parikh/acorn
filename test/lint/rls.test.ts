// test/lint/rls.test.ts — unit tests for acorn's deterministic RLS lint (P1-P9).
//
// Each test pins a brain pitfall (brain/KNOWN-PITFALLS.md) to a concrete detection:
// the lint must FLAG the footgun fixtures and pass the correctly-hardened fixture clean.
// Pure SQL-text checks, no DB, no LLM (HARNESS-OVERRIDES §4).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintRls } from "../../src/lint/rls.js";

const fixture = (name: string): string => readFileSync(join("test/fixtures", name), "utf8");
const rules = (sql: string): string[] => lintRls(sql).violations.map((v) => v.rule);

describe("lintRls — P1: RLS not enabled on a migration-created table (CVE-2025-48757)", () => {
  it("flags a public table with no ENABLE ROW LEVEL SECURITY as an error", () => {
    const result = lintRls(fixture("no-rls.sql"));
    expect(result.failed).toBe(true);
    const p1 = result.violations.find((v) => v.rule === "P1");
    expect(p1).toBeDefined();
    expect(p1?.severity).toBe("error");
    expect(p1?.table).toBe("tickets");
    expect(p1?.message).toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });

  it("does NOT flag P1 when RLS is enabled", () => {
    expect(rules(fixture("safe-rls.sql"))).not.toContain("P1");
  });
});

describe("lintRls — P2: unwrapped auth.uid() re-evaluates per row", () => {
  it("flags a bare auth.uid() in a policy as an error", () => {
    const result = lintRls(fixture("unwrapped-auth.sql"));
    const p2 = result.violations.find((v) => v.rule === "P2");
    expect(p2).toBeDefined();
    expect(p2?.severity).toBe("error");
    expect(p2?.message).toMatch(/\(select auth\.uid\(\)\)/i);
  });

  it("does NOT flag P2 when the auth call is wrapped in a subselect", () => {
    expect(rules(fixture("safe-rls.sql"))).not.toContain("P2");
  });
});

describe("lintRls — P3: a write policy with no WITH CHECK permits cross-tenant writes", () => {
  it("flags a FOR ALL policy missing WITH CHECK as an error", () => {
    // unwrapped-auth.sql has `FOR ALL ... USING (...)` with no WITH CHECK.
    const p3 = lintRls(fixture("unwrapped-auth.sql")).violations.find((v) => v.rule === "P3");
    expect(p3).toBeDefined();
    expect(p3?.severity).toBe("error");
    expect(p3?.message).toMatch(/WITH CHECK/i);
  });

  it("does NOT flag P3 when both USING and WITH CHECK are present", () => {
    expect(rules(fixture("safe-rls.sql"))).not.toContain("P3");
  });
});

describe("lintRls — P4: a policy body that queries another table risks runtime recursion", () => {
  it("warns and suggests a SECURITY DEFINER helper", () => {
    const sql = `
      CREATE TABLE public.docs (id uuid PRIMARY KEY, org_id uuid);
      ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "docs_member" ON public.docs FOR SELECT TO authenticated
        USING (org_id IN (SELECT org_id FROM public.memberships WHERE user_id = (select auth.uid())));
    `;
    const p4 = lintRls(sql).violations.find((v) => v.rule === "P4");
    expect(p4).toBeDefined();
    expect(p4?.severity).toBe("warning");
    expect(p4?.message).toMatch(/SECURITY DEFINER/i);
  });
});

describe("lintRls — P5: the RLS predicate column should be indexed", () => {
  it("warns when the predicate column has no index", () => {
    // a hardened-looking policy but NO index on the user_id predicate column.
    const sql = `
      CREATE TABLE public.events (id uuid PRIMARY KEY, user_id uuid NOT NULL);
      ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "events_owner" ON public.events FOR ALL TO authenticated
        USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
    `;
    const p5 = lintRls(sql).violations.find((v) => v.rule === "P5");
    expect(p5).toBeDefined();
    expect(p5?.severity).toBe("warning");
    expect(p5?.message).toMatch(/seq scan|index/i);
  });

  it("does NOT flag P5 when the predicate column is indexed", () => {
    expect(rules(fixture("safe-rls.sql"))).not.toContain("P5");
  });
});

describe("lintRls — P7: Clerk text id compared to auth.uid() without ::text silently denies all", () => {
  it("warns when a bare auth.uid() (uuid) is compared without a ::text cast", () => {
    const sql = `
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id text NOT NULL);
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      CREATE INDEX profiles_user_id_idx ON public.profiles (user_id);
      CREATE POLICY "profiles_owner" ON public.profiles FOR ALL TO authenticated
        USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    `;
    const p7 = lintRls(sql).violations.find((v) => v.rule === "P7");
    expect(p7).toBeDefined();
    expect(p7?.message).toMatch(/::text/i);
  });

  it("does NOT flag P7 when a ::text cast is present", () => {
    const sql = `
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id text NOT NULL);
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      CREATE INDEX profiles_user_id_idx ON public.profiles (user_id);
      CREATE POLICY "profiles_owner" ON public.profiles FOR ALL TO authenticated
        USING ((select auth.uid())::text = user_id) WITH CHECK ((select auth.uid())::text = user_id);
    `;
    expect(rules(sql)).not.toContain("P7");
  });
});

describe("lintRls — P9: using(true) with no role gate is RLS-off for anon too", () => {
  it("flags an ungated using(true) policy as an error (energy footgun)", () => {
    const sql = `
      CREATE TABLE public.user_memories (id uuid PRIMARY KEY, user_id uuid);
      ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "full_access" ON public.user_memories FOR ALL USING (true) WITH CHECK (true);
    `;
    const p9 = lintRls(sql).violations.find((v) => v.rule === "P9");
    expect(p9).toBeDefined();
    expect(p9?.severity).toBe("error");
    expect(p9?.message).toMatch(/service_role/i);
  });

  it("does NOT flag P9 when using(true) is gated on service_role", () => {
    // the gated service_role policy in safe-rls.sql restricts to service_role → not RLS-off for anon.
    expect(rules(fixture("safe-rls.sql"))).not.toContain("P9");
  });
});

describe("lintRls — the hardened fixture is clean", () => {
  it("finds ZERO error-severity violations on safe-rls.sql", () => {
    const result = lintRls(fixture("safe-rls.sql"));
    const errors = result.violations.filter((v) => v.severity === "error");
    expect(errors).toEqual([]);
    expect(result.failed).toBe(false);
  });
});

describe("lintRls — comments and strings never false-trigger (sql-util noise stripping)", () => {
  it("ignores a CREATE TABLE that appears only inside a comment", () => {
    const sql = `
      -- CREATE TABLE public.ghost (id uuid); this is a comment, not a table
      CREATE TABLE public.real_table (id uuid PRIMARY KEY, user_id uuid);
      ALTER TABLE public.real_table ENABLE ROW LEVEL SECURITY;
    `;
    const tables = lintRls(sql).violations.map((v) => v.table);
    expect(tables).not.toContain("ghost");
  });
});
