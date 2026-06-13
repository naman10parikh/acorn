// test/cli/bad-paths.test.ts — CLI-level graceful-error contract (T-user QA, CP123 Wave B).
//
// Locks the fixes for three first-time-user findings: the `acorn migration` verbs and `acorn schema`
// must FAIL GRACEFULLY on hostile input — a clean stderr message + a non-zero exit — NEVER a raw
// node:fs `ERR_FS`/`ENOENT` stack trace (which a real user / a sibling agent reading exit+stderr would
// see as a crash). Mirrors the `acorn rls lint` "path not found" convention already in src/commands/rls.ts.
//
// These spawn the BUILT binary (dist/index.js) — the surface a user actually invokes — so they also guard
// the exit-code contract end-to-end (PLAN §4: "exits 0 on success / non-zero on violation"). They require
// a prior `pnpm build` (CI runs build before test; the acceptance job does too).

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(process.cwd(), "dist", "index.js");

/** Run the built acorn CLI with args; capture stdout/stderr/exit. No DB, no network. */
function acorn(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync("node", [BIN, ...args], { encoding: "utf8" });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const NODE_FS_CRASH = /node:fs|ERR_FS|readFileUtf8|ENOENT.*open|at Object\.readFileSync/;

describe("acorn CLI — graceful errors on bad input (no raw fs stack traces)", () => {
  beforeAll(() => {
    // Built binary is the unit under test; fail loud if the build is missing rather than silently skipping.
    expect(existsSync(BIN), `built CLI missing at ${BIN} — run 'pnpm build' first`).toBe(true);
  });

  it("migration lint <missing-file> → clean 'file not found', exit 2, NOT an fs crash", () => {
    const out = acorn(["migration", "lint", join(tmpdir(), "acorn-no-such-file-xyz.sql")]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/file not found/i);
    expect(out.stderr).not.toMatch(NODE_FS_CRASH);
  });

  it("migration safe <missing-file> → clean 'file not found', exit 2, NOT an fs crash", () => {
    const out = acorn(["migration", "safe", join(tmpdir(), "acorn-no-such-file-xyz.sql")]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/file not found/i);
    expect(out.stderr).not.toMatch(NODE_FS_CRASH);
  });

  it("migration lint <directory> → clean 'is a directory' hint, exit 2, NOT an fs crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "acorn-dir-"));
    const out = acorn(["migration", "lint", dir]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/is a directory/i);
    expect(out.stderr).not.toMatch(NODE_FS_CRASH);
  });

  it("schema with an empty brief → clean rejection, exit 2, never fabricates a schema", () => {
    const out = acorn(["schema", ""]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/empty brief/i);
    // It must NOT have run the routing loop / invented a `records` table.
    expect(out.stdout).not.toMatch(/routing loop/i);
  });

  it("schema with a whitespace-only brief → also rejected (exit 2)", () => {
    const out = acorn(["schema", "   "]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/empty brief/i);
  });

  // Positive control: a REAL file still lints (the guard didn't break the happy path).
  it("migration lint <real safe file> → exit 0 (guard preserves the happy path)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "acorn-ok-")), "ok.sql");
    writeFileSync(f, "SET lock_timeout='3s';\nALTER TABLE public.t ADD CONSTRAINT c CHECK (x > 0) NOT VALID;\nALTER TABLE public.t VALIDATE CONSTRAINT c;\n");
    const out = acorn(["migration", "lint", f]);
    expect(out.code).toBe(0);
    expect(out.stderr).not.toMatch(NODE_FS_CRASH);
  });
});
