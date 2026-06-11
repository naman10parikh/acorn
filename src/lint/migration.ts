// src/lint/migration.ts — acorn's deterministic migration lint (the 5 outage-makers, P10-P15).
//
// Pure SQL-text analysis, NO LLM (HARNESS-OVERRIDES §4). Each rule is a brain pitfall + its lock class:
//   P10  bare ADD CONSTRAINT CHECK / SET NOT NULL / ADD FK  → AccessExclusive full scan   [SCENARIO #4, 84M rows/4h12m]
//   P11  ALTER COLUMN TYPE on a table                       → table rewrite under AccessExclusive
//   P12  CREATE INDEX without CONCURRENTLY                   → AccessExclusive for the build duration
//   P13  bare RENAME / DROP COLUMN                           → breaks the still-running old app version
//   P14  no `SET lock_timeout` in the migration             → a waiting lock freezes the whole table
//
// (P15 staging-scale mismatch is a process rule, not statically detectable from one .sql — surfaced in
//  the skill, not the lint.) `acorn migration lint` flags these; exit non-zero on an error-severity hit.

import { splitStatements } from "./sql-util.js";
import { toResult, type LintResult, type Violation } from "./types.js";

/** The Postgres lock class a flagged op takes (carried in the message + the MCP `lock_class`). */
export type LockClass = "AccessExclusive" | "ShareUpdateExclusive" | "none";

export function lintMigration(sql: string): LintResult {
  const statements = splitStatements(sql);
  const violations: Violation[] = [];

  const hasLockTimeout = statements.some((st) => /\bset\s+lock_timeout\b/i.test(st.sql));
  let sawHotDdl = false;

  for (const st of statements) {
    const s = st.sql;

    // P10 — bare ADD CONSTRAINT CHECK / ADD FK validated immediately.
    if (/\badd\s+constraint\b/i.test(s) && /\bcheck\b/i.test(s) && !/\bnot\s+valid\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P10", st.line, "error", "AccessExclusive",
        `Bare 'ADD CONSTRAINT ... CHECK' validates against every existing row under AccessExclusive (a full scan you can't cancel — 84M rows = 4h12m/$52,400). Use 'ADD CONSTRAINT ... CHECK (...) NOT VALID;' then a separate 'VALIDATE CONSTRAINT' (run 'acorn migration safe' to rewrite).`));
    }
    if (/\badd\s+(?:constraint\s+\w+\s+)?foreign\s+key\b/i.test(s) && !/\bnot\s+valid\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P10", st.line, "error", "AccessExclusive",
        `Bare 'ADD ... FOREIGN KEY' validates immediately under AccessExclusive. Add it 'NOT VALID' then 'VALIDATE CONSTRAINT' separately (weaker ShareUpdateExclusive, reads/writes continue).`));
    }
    // P10 — SET NOT NULL scans the whole table under AccessExclusive.
    if (/\balter\s+column\b/i.test(s) && /\bset\s+not\s+null\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P10", st.line, "error", "AccessExclusive",
        `'SET NOT NULL' scans the whole table under AccessExclusive. On PG12+ add a 'CHECK (col IS NOT NULL) NOT VALID' → 'VALIDATE' first, then 'SET NOT NULL' skips the scan (run 'acorn migration safe').`));
    }

    // P11 — ALTER COLUMN ... TYPE rewrites the table under AccessExclusive.
    if (/\balter\s+column\b/i.test(s) && /\b(set\s+data\s+)?type\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P11", st.line, "error", "AccessExclusive",
        `'ALTER COLUMN ... TYPE' rewrites the entire table under AccessExclusive — the classic outage maker. Use expand/contract: add a new column of the new type, dual-write, backfill in batches, swap, drop the old. Never a bare in-place type change on a hot table.`));
    }

    // P12 — CREATE INDEX without CONCURRENTLY.
    if (/\bcreate\b/i.test(s) && /\bindex\b/i.test(s) && !/\bconcurrently\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P12", st.line, "error", "AccessExclusive",
        `'CREATE INDEX' without CONCURRENTLY holds AccessExclusive for the whole build, blocking writes. Use 'CREATE INDEX CONCURRENTLY' (caveat: can't run in a txn block; on failure leaves an INVALID index to DROP + retry).`));
    }

    // P13 — bare RENAME / DROP COLUMN breaks the old app version mid rolling-deploy.
    if (/\brename\s+(column|to)\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P13", st.line, "warning", "AccessExclusive",
        `A bare RENAME breaks the still-running old app version during a rolling deploy. Expand→dual-write→backfill→contract: add the new name, backfill, switch reads, drop the old a release later.`));
    }
    if (/\bdrop\s+column\b/i.test(s)) {
      sawHotDdl = true;
      violations.push(mk("P13", st.line, "warning", "AccessExclusive",
        `A bare DROP COLUMN 500s old app instances that still reference it mid-deploy. Drop the old column a release AFTER the code stops using it (the contract phase).`));
    }

    // P20 (related ORM bite-zone) — drizzle-kit push is never lintable here but a literal `DROP TABLE` warns.
    if (/\bdrop\s+table\b/i.test(s) && !/\bif\s+exists\b/i.test(s)) {
      violations.push(mk("P13", st.line, "warning", "AccessExclusive",
        `'DROP TABLE' (no IF EXISTS) is destructive and breaks any still-running consumer. Confirm no app version references it; prefer a deprecation window.`));
    }
  }

  // P14 — if the migration does any hot DDL but never SET lock_timeout, flag it once.
  if (sawHotDdl && !hasLockTimeout) {
    violations.push(mk("P14", statements[0]?.line ?? 1, "error", "none",
      `This migration runs lock-taking DDL but never 'SET lock_timeout'. A waiting AccessExclusive lock freezes every query behind it. Add 'SET lock_timeout = '3s';' at the top — better to fail and retry than queue behind a long query and cascade into an outage.`));
  }

  return toResult(violations);
}

function mk(
  rule: string,
  line: number,
  severity: Violation["severity"],
  _lockClass: LockClass,
  message: string,
): Violation & { lockClass: LockClass } {
  return { rule, table: "", line, severity, message, lockClass: _lockClass };
}

/** Convenience for the MCP layer: lint and surface lock classes alongside violations. */
export interface OutageRisk {
  readonly rule: string;
  readonly lockClass: LockClass;
  readonly line: number;
  readonly severity: Violation["severity"];
  readonly message: string;
}

export function migrationOutageRisks(sql: string): OutageRisk[] {
  const result = lintMigration(sql);
  return result.violations.map((v) => ({
    rule: v.rule,
    lockClass: (v as Violation & { lockClass?: LockClass }).lockClass ?? "none",
    line: v.line,
    severity: v.severity,
    message: v.message,
  }));
}
