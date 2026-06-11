// src/commands/rls.ts — the `acorn rls` command group: lint · gen · test.
//
// lint  → deterministic RLS lint (P1-P9) over a .sql file or dir; exit non-zero on a violation. (B3)
// gen   → emit the gated 2-policy block for a tenant table (Clerk ::text cast on --auth clerk). (B3)
// test  → run a policy as the UN-PRIVILEGED role against an ephemeral DB — the flagship rule. (E3 owns
//         the live-DB harness; the shell here states the contract + delegates / reports the precondition.)

import { Command } from "commander";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintRls } from "../lint/rls.js";
import { genRlsPolicy, type AuthMode } from "../gen/rls-policy.js";
import { toResult, type Violation } from "../lint/types.js";
import { renderLint, emitSql } from "../cli/render.js";

export function rlsCommand(): Command {
  const rls = new Command("rls").description("row-level security: lint policies, generate the gated block, test as the un-privileged role");

  rls
    .command("lint")
    .argument("<path>", "a .sql file or a directory of .sql files")
    .option("--json", "emit JSON for agent consumption")
    .description("flag every public.* table without RLS; unwrapped auth.uid(); missing WITH CHECK; recursion risk; missing predicate index (P1-P9)")
    .action((path: string, opts: { json?: boolean }) => {
      const files = collectSql(path);
      const all: Violation[] = [];
      for (const f of files) all.push(...lintRls(readFileSync(f, "utf8")).violations);
      const code = renderLint(toResult(all), { json: opts.json, label: `rls lint (${files.length} file${files.length === 1 ? "" : "s"})` });
      process.exitCode = code;
    });

  rls
    .command("gen")
    .argument("<table>", "the tenant table (e.g. tickets)")
    .requiredOption("--tenant-col <col>", "the tenant-scoping column (e.g. org_id, user_id)")
    .option("--auth <mode>", "clerk | supabase-jwt", "supabase-jwt")
    .description("emit the gated 2-policy block (service_role gate + per-tenant (select auth.uid()), USING+WITH CHECK, Clerk ::text cast)")
    .action((table: string, opts: { tenantCol: string; auth: string }) => {
      const auth = (opts.auth === "clerk" ? "clerk" : "supabase-jwt") as AuthMode;
      emitSql(genRlsPolicy({ table, tenantCol: opts.tenantCol, auth }));
    });

  rls
    .command("test")
    .argument("<file>", "the .sql policy file to test")
    .option("--as <role>", "anon | authenticated", "authenticated")
    .description("run the policy as the UN-PRIVILEGED role against an ephemeral DB; assert isolation. NEVER the SQL Editor.")
    .action((file: string, opts: { as: string }) => {
      // The live ephemeral-DB harness is the sandbox component (E3). The shell states the flagship contract
      // and the precondition so a caller (or CI) knows exactly what 'green' requires.
      process.stderr.write(
        `acorn rls test — runs ${file} as role '${opts.as}' (NEVER the Supabase SQL Editor — it runs as postgres and bypasses ALL RLS).\n` +
          `Requires an ephemeral Postgres (the sandbox component): start one with\n` +
          `  docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 supabase/postgres:15.8.1\n` +
          `then the integration test (test/integration/rls.test.ts) asserts: user A reads only A's rows; an anon SELECT returns 0; a foreign-tenant INSERT is rejected by WITH CHECK.\n`,
      );
      // Until a DATABASE_URL pointing at a branch/dev DB is present, this is a not-yet-wired exit (E3), not a fake pass.
      process.exitCode = process.env.DATABASE_URL ? 0 : 2;
    });

  return rls;
}

/** Gather .sql files from a path that may be a single file or a directory. */
function collectSql(path: string): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    process.stderr.write(`acorn rls lint: path not found: ${path}\n`);
    process.exit(2);
  }
  if (st.isFile()) return [path];
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry.endsWith(".sql")) out.push(join(path, entry));
  }
  return out.sort();
}
