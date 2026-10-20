// test/cli/verify-rls.test.ts — `acorn schema --verify-rls` fails the run when anon can read rows.
//
// The verdict is checked on canned psql results (always runs), and on a real anon probe of a table anon can
// read (DB-gated, like test/integration/rls.test.ts: it runs in the acceptance job and skips locally). The
// live leg works in its own schema and drops it, so it never touches the tables the acceptance job applies.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { anonProbeVerdict } from "../../src/commands/schema.js";
import { applySql, prodGuard, psqlAvailable, runRlsAsRole } from "../../src/sandbox/provision.js";

const BIN = join(process.cwd(), "dist", "index.js");
const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", code: 0 });
const failed = (stderr: string) => ({ ok: false, stdout: "", stderr, code: 3 });

describe("--verify-rls verdict on the anon probe (no DB)", () => {
  it("anon reading rows fails the run (exit 1) and names the table", () => {
    const v = anonProbeVerdict("public.tickets", ok(" n \n---\n 3\n(1 row)\n\n"));
    expect(v.exitCode).toBe(1);
    expect(v.line).toMatch(/public\.tickets/);
    expect(v.line).toMatch(/3 row/);
  });

  it("anon reading 0 rows passes (exit 0)", () => {
    const v = anonProbeVerdict("app.notes", ok(" n \n---\n 0\n(1 row)\n\n"));
    expect(v.exitCode).toBe(0);
    expect(v.line).toMatch(/app\.notes/);
  });

  it("anon denied by a missing GRANT passes (exit 0)", () => {
    const v = anonProbeVerdict("public.tickets", failed("ERROR:  permission denied for table tickets"));
    expect(v.exitCode).toBe(0);
  });

  it("a probe that could not run is not a pass (exit 2)", () => {
    const v = anonProbeVerdict("public.nope", failed('ERROR:  relation "public.nope" does not exist'));
    expect(v.exitCode).toBe(2);
    expect(v.line).toMatch(/not verified/);
  });
});

describe("--rls-table (no DB)", () => {
  it("rejects a value that is not a plain table name, exit 2", () => {
    expect(existsSync(BIN), `built CLI missing at ${BIN} — run 'pnpm build' first`).toBe(true);
    const res = spawnSync(
      "node",
      [BIN, "schema", "orgs have members", "--apply", "--verify-rls", "--rls-table", "public.t; drop table x"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--rls-table must be a plain table name/);
  });
});

const DB = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DB) && psqlAvailable() && prodGuard(DB).allowed;

describe.skipIf(!HAVE_DB)("--verify-rls on a live table anon can read (DATABASE_URL present)", () => {
  const schema = "acorn_probe_" + Math.random().toString(36).slice(2, 8);
  const table = `${schema}.leaky`;

  beforeAll(() => {
    const res = applySql(
      DB!,
      `CREATE SCHEMA ${schema};
       CREATE TABLE ${table} (id int);
       INSERT INTO ${table} VALUES (1), (2);
       GRANT USAGE ON SCHEMA ${schema} TO anon;
       GRANT SELECT ON ${table} TO anon;`,
    );
    expect(res.ok, res.stderr).toBe(true);
  });

  afterAll(() => {
    applySql(DB!, `DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
  });

  it("the real anon probe sees 2 rows, so the run fails (exit 1)", () => {
    const v = anonProbeVerdict(table, runRlsAsRole(DB!, "anon", `SELECT count(*) AS n FROM ${table}`));
    expect(v.exitCode).toBe(1);
    expect(v.line).toMatch(/2 row/);
  });
});
