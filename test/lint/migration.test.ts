// test/lint/migration.test.ts — unit tests for acorn's deterministic migration lint (P10-P15)
// and the `acorn migration safe` rewrite transform.
//
// Each test pins a brain pitfall (brain/KNOWN-PITFALLS.md) + its Postgres lock class to a concrete
// detection or rewrite: the lint must FLAG the outage-makers and pass the correctly-hardened fixture
// clean; the transform must rewrite a bare AccessExclusive op into the NOT VALID / VALIDATE two-step
// (SCENARIO #4 — the 84M-row CHECK that locked prod for 4h12m). Pure SQL-text, no DB, no LLM
// (HARNESS-OVERRIDES §4).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintMigration, migrationOutageRisks } from "../../src/lint/migration.js";
import { safeMigration } from "../../src/transform/safe-migration.js";

const fixture = (name: string): string => readFileSync(join("test/fixtures", name), "utf8");
const rules = (sql: string): string[] => lintMigration(sql).violations.map((v) => v.rule);

describe("lintMigration — P10: bare ADD CONSTRAINT CHECK validates under AccessExclusive (SCENARIO #4)", () => {
  it("flags a bare ADD CONSTRAINT CHECK as an error", () => {
    const result = lintMigration(fixture("bare-check.sql"));
    expect(result.failed).toBe(true);
    const p10 = result.violations.find((v) => v.rule === "P10");
    expect(p10).toBeDefined();
    expect(p10?.severity).toBe("error");
    expect(p10?.message).toMatch(/NOT VALID/i);
  });

  it("flags a bare SET NOT NULL as a P10 error", () => {
    const sql = `ALTER TABLE public.users ALTER COLUMN phone SET NOT NULL;`;
    expect(rules(sql)).toContain("P10");
  });

  it("flags a bare ADD FOREIGN KEY as a P10 error", () => {
    const sql = `ALTER TABLE public.orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id);`;
    expect(rules(sql)).toContain("P10");
  });

  it("does NOT flag P10 when the constraint is added NOT VALID", () => {
    const sql = `SET lock_timeout = '3s';\nALTER TABLE public.orders ADD CONSTRAINT c CHECK (amount > 0) NOT VALID;`;
    expect(rules(sql)).not.toContain("P10");
  });
});

describe("lintMigration — P11: ALTER COLUMN TYPE rewrites the table under AccessExclusive", () => {
  it("flags an in-place type change as an error", () => {
    const sql = `SET lock_timeout = '3s';\nALTER TABLE public.orders ALTER COLUMN amount TYPE numeric(12,2);`;
    const p11 = lintMigration(sql).violations.find((v) => v.rule === "P11");
    expect(p11).toBeDefined();
    expect(p11?.severity).toBe("error");
    expect(p11?.message).toMatch(/expand\/contract|rewrite/i);
  });
});

describe("lintMigration — P12: CREATE INDEX without CONCURRENTLY blocks writes", () => {
  it("flags a plain CREATE INDEX", () => {
    const sql = `SET lock_timeout = '3s';\nCREATE INDEX orders_customer_idx ON public.orders (customer_id);`;
    const p12 = lintMigration(sql).violations.find((v) => v.rule === "P12");
    expect(p12).toBeDefined();
    expect(p12?.message).toMatch(/CONCURRENTLY/i);
  });

  it("does NOT flag P12 when CONCURRENTLY is present", () => {
    const sql = `CREATE INDEX CONCURRENTLY orders_customer_idx ON public.orders (customer_id);`;
    expect(rules(sql)).not.toContain("P12");
  });
});

describe("lintMigration — P13: bare RENAME / DROP breaks the running old app version", () => {
  it("warns on a bare RENAME COLUMN", () => {
    const sql = `ALTER TABLE public.users RENAME COLUMN full_name TO display_name;`;
    const p13 = lintMigration(sql).violations.find((v) => v.rule === "P13");
    expect(p13).toBeDefined();
    expect(p13?.severity).toBe("warning");
  });

  it("warns on a bare DROP COLUMN", () => {
    const sql = `ALTER TABLE public.users DROP COLUMN legacy_flag;`;
    expect(rules(sql)).toContain("P13");
  });
});

describe("lintMigration — P14: a lock-taking migration with no SET lock_timeout", () => {
  it("flags the missing lock_timeout once when the migration does hot DDL", () => {
    const p14 = lintMigration(fixture("bare-check.sql")).violations.filter((v) => v.rule === "P14");
    expect(p14.length).toBe(1);
    expect(p14[0].severity).toBe("error");
    expect(p14[0].message).toMatch(/lock_timeout/i);
  });

  it("does NOT flag P14 when SET lock_timeout is present", () => {
    expect(rules(fixture("safe-migration.sql"))).not.toContain("P14");
  });
});

describe("lintMigration — the hardened fixture is clean", () => {
  it("finds ZERO error-severity violations on safe-migration.sql", () => {
    const result = lintMigration(fixture("safe-migration.sql"));
    expect(result.violations.filter((v) => v.severity === "error")).toEqual([]);
    expect(result.failed).toBe(false);
  });
});

describe("migrationOutageRisks — surfaces the Postgres lock class for the MCP layer (C1)", () => {
  it("tags the bare CHECK with AccessExclusive", () => {
    const risks = migrationOutageRisks(fixture("bare-check.sql"));
    const p10 = risks.find((r) => r.rule === "P10");
    expect(p10?.lockClass).toBe("AccessExclusive");
  });
});

describe("safeMigration — rewrites a bare CHECK into NOT VALID + VALIDATE (G5, SCENARIO #4)", () => {
  it("injects lock_timeout and splits the constraint into the two-step", () => {
    const { sql } = safeMigration(fixture("bare-check.sql"));
    expect(sql).toMatch(/SET lock_timeout = '3s'/);
    expect(sql).toMatch(/NOT VALID/);
    expect(sql).toMatch(/VALIDATE CONSTRAINT/);
  });

  it("VALIDATEs the REAL constraint name, not a keyword from a preceding comment (regression)", () => {
    // bare-check.sql opens with a comment containing the words "ADD CONSTRAINT CHECK". The parse must
    // skip the comment and pick the actual constraint `orders_amount_positive`, never `CHECK`.
    const { sql } = safeMigration(fixture("bare-check.sql"));
    expect(sql).toContain("VALIDATE CONSTRAINT orders_amount_positive");
    expect(sql).not.toContain("VALIDATE CONSTRAINT CHECK");
  });

  it("rewrites a SET NOT NULL into CHECK NOT VALID → VALIDATE → SET NOT NULL", () => {
    const { sql } = safeMigration(`ALTER TABLE public.users ALTER COLUMN phone SET NOT NULL;`);
    expect(sql).toMatch(/ADD CONSTRAINT \w+ CHECK \(phone IS NOT NULL\) NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT/i);
    expect(sql).toMatch(/SET NOT NULL/i);
  });

  it("rewrites CREATE INDEX into CREATE INDEX CONCURRENTLY", () => {
    const { sql } = safeMigration(`CREATE INDEX orders_customer_idx ON public.orders (customer_id);`);
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY/i);
  });

  it("is idempotent on lock_timeout — does not double-inject when one already exists", () => {
    const occurrences = (safeMigration(fixture("safe-migration.sql")).sql.match(/SET lock_timeout/gi) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
