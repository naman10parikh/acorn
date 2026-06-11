// src/transform/safe-migration.ts — `acorn migration safe`: rewrite unsafe DDL into the safe form.
//
// The load-bearing transform (golden task G5, SCENARIO #4 — the 84M-row CHECK that locked for 4h12m;
// the NOT VALID/VALIDATE two-step did it in 42min/$0). Deterministic text rewrite, NO LLM. Applies:
//   • inject `SET lock_timeout = '3s';` at the top (P14, OPINIONS §Migrations)
//   • bare ADD CONSTRAINT CHECK / ADD FK          → `... NOT VALID;` + a follow-up `VALIDATE CONSTRAINT`
//   • SET NOT NULL                                → a `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL`
//   • CREATE INDEX                                → `CREATE INDEX CONCURRENTLY`
//   • bare RENAME COLUMN                          → an expand→backfill→contract scaffold (commented)
//
// [EXPERTISE-MAP §3d, SCENARIO #4/#5]

import { splitStatements, type Statement } from "../lint/sql-util.js";

const LOCK_TIMEOUT_STMT = "SET lock_timeout = '3s';";

export interface SafeRewrite {
  /** the rewritten SQL script (ready to review → apply on a branch) */
  readonly sql: string;
  /** human-readable notes on what was changed and why (one line per change) */
  readonly notes: readonly string[];
}

export function safeMigration(input: string): SafeRewrite {
  const statements = splitStatements(input);
  const notes: string[] = [];
  const out: string[] = [];

  const alreadyHasLockTimeout = statements.some((s) => /\bset\s+lock_timeout\b/i.test(s.sql));
  if (!alreadyHasLockTimeout) {
    out.push(`${LOCK_TIMEOUT_STMT}  -- acorn: fail fast, never queue behind a long query (P14)`);
    notes.push("Injected SET lock_timeout='3s' (P14 — a waiting AccessExclusive lock freezes the whole table).");
  }

  for (const st of statements) {
    const rewritten = rewriteStatement(st, notes);
    out.push(rewritten);
  }

  return { sql: out.join("\n"), notes };
}

function rewriteStatement(st: Statement, notes: string[]): string {
  // Strip leading full-line `--` comments and the trailing `;` from the raw slice. A statement's raw text
  // can carry preceding comment lines (splitStatements anchors on the `;`), and a stray `ADD CONSTRAINT
  // CHECK …` inside such a comment would otherwise hijack the name/target regexes below (parsing the
  // comment instead of the DDL) AND fold the comment into the emitted `… NOT VALID;` as malformed SQL.
  const raw = stripLeadingComments(st.raw).replace(/;?\s*$/, "");
  const s = st.sql;

  // CREATE INDEX → CREATE INDEX CONCURRENTLY (P12)
  if (/\bcreate\b/i.test(s) && /\bindex\b/i.test(s) && !/\bconcurrently\b/i.test(s)) {
    const fixed = raw.replace(/\bcreate\s+(unique\s+)?index\b/i, (_m, uniq) =>
      `CREATE ${uniq ? "UNIQUE " : ""}INDEX CONCURRENTLY`,
    );
    notes.push("CREATE INDEX → CONCURRENTLY (P12). Note: cannot run inside a txn block; on failure DROP the INVALID index and retry.");
    return `${fixed};`;
  }

  // ADD CONSTRAINT ... CHECK (not already NOT VALID) → NOT VALID + VALIDATE (P10)
  if (/\badd\s+constraint\b/i.test(s) && /\bcheck\b/i.test(s) && !/\bnot\s+valid\b/i.test(s)) {
    const name = constraintName(raw);
    const table = alterTarget(raw);
    notes.push(`ADD CONSTRAINT CHECK split into NOT VALID + VALIDATE (P10/G5 — the 84M-row outage maker).`);
    return `${raw} NOT VALID;\nALTER TABLE ${table} VALIDATE CONSTRAINT ${name};  -- acorn: weaker ShareUpdateExclusive, reads/writes continue`;
  }

  // ADD FOREIGN KEY → NOT VALID + VALIDATE (P10)
  if (/\badd\s+(?:constraint\s+\w+\s+)?foreign\s+key\b/i.test(s) && !/\bnot\s+valid\b/i.test(s)) {
    const name = constraintName(raw);
    const table = alterTarget(raw);
    notes.push("ADD FOREIGN KEY split into NOT VALID + VALIDATE (P10).");
    if (name) {
      return `${raw} NOT VALID;\nALTER TABLE ${table} VALIDATE CONSTRAINT ${name};  -- acorn: validate without the AccessExclusive scan`;
    }
    return `${raw} NOT VALID;  -- acorn: then VALIDATE CONSTRAINT <name> in a separate statement`;
  }

  // SET NOT NULL → CHECK NOT VALID → VALIDATE → SET NOT NULL (P10, PG12+ skips the scan)
  if (/\balter\s+column\b/i.test(s) && /\bset\s+not\s+null\b/i.test(s)) {
    const table = alterTarget(raw);
    const col = columnFromSetNotNull(raw);
    const cname = `${stripSchema(table)}_${col}_not_null`;
    notes.push(`SET NOT NULL rewritten as CHECK NOT VALID → VALIDATE → SET NOT NULL (P10 — PG12+ then skips the table scan).`);
    return [
      `ALTER TABLE ${table} ADD CONSTRAINT ${cname} CHECK (${col} IS NOT NULL) NOT VALID;`,
      `ALTER TABLE ${table} VALIDATE CONSTRAINT ${cname};`,
      `${raw};  -- acorn: PG12+ uses the validated CHECK, skips the AccessExclusive scan`,
    ].join("\n");
  }

  // ALTER COLUMN TYPE → an expand/contract scaffold (cannot be auto-rewritten safely; emit the plan) (P11)
  if (/\balter\s+column\b/i.test(s) && /\b(set\s+data\s+)?type\b/i.test(s)) {
    const table = alterTarget(raw);
    notes.push("ALTER COLUMN TYPE replaced with an expand/contract scaffold (P11 — a bare type change rewrites the table under AccessExclusive).");
    return [
      `-- acorn (P11): a bare 'ALTER COLUMN ... TYPE' rewrites ${table} under AccessExclusive. Do this instead:`,
      `--   1. ADD COLUMN <new> <newtype>;`,
      `--   2. backfill in batches: UPDATE ${table} SET <new> = <old>::<newtype> WHERE id BETWEEN ...;`,
      `--   3. dual-write <new> from the app; switch reads to <new>;`,
      `--   4. DROP COLUMN <old>; rename <new> → <old> a release later.`,
      `-- original (do NOT ship as-is): ${raw};`,
    ].join("\n");
  }

  // RENAME COLUMN → expand→backfill→contract scaffold (P13)
  if (/\brename\s+column\b/i.test(s)) {
    const { table, from, to } = renameParts(raw);
    notes.push("RENAME COLUMN replaced with an expand→backfill→contract scaffold (P13 — a bare rename breaks the running old app version).");
    return [
      `-- acorn (P13): a bare RENAME breaks the still-running old app version. Expand→backfill→contract:`,
      `ALTER TABLE ${table} ADD COLUMN ${to} <type>;  -- step 1: expand (new column)`,
      `UPDATE ${table} SET ${to} = ${from};            -- step 2: backfill`,
      `-- step 3: dual-write ${to} from the app, switch reads to ${to}`,
      `-- step 4 (a release LATER): ALTER TABLE ${table} DROP COLUMN ${from};`,
      `-- original (do NOT ship as-is): ${raw};`,
    ].join("\n");
  }

  // nothing to rewrite — pass through verbatim.
  return `${raw};`;
}

// ── parse helpers (best-effort, deterministic) ────────────────────────────────

/** Drop leading whitespace-only and full-line `-- …` comment lines from a raw statement slice. */
function stripLeadingComments(raw: string): string {
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.length === 0 || t.startsWith("--")) i++;
    else break;
  }
  return lines.slice(i).join("\n");
}

function alterTarget(sql: string): string {
  const m = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-zA-Z0-9_."]+)/i.exec(sql);
  return m ? m[1] : "<table>";
}

function stripSchema(t: string): string {
  return t.replace(/"/g, "").replace(/^[a-z0-9_]+\./i, "");
}

function constraintName(sql: string): string {
  const m = /\badd\s+constraint\s+([a-zA-Z0-9_"]+)/i.exec(sql);
  return m ? m[1] : "<constraint>";
}

function columnFromSetNotNull(sql: string): string {
  const m = /\balter\s+column\s+([a-zA-Z0-9_"]+)/i.exec(sql);
  return m ? m[1].replace(/"/g, "") : "<col>";
}

function renameParts(sql: string): { table: string; from: string; to: string } {
  const table = alterTarget(sql);
  const m = /\brename\s+column\s+([a-zA-Z0-9_"]+)\s+to\s+([a-zA-Z0-9_"]+)/i.exec(sql);
  return {
    table,
    from: m ? m[1].replace(/"/g, "") : "<old>",
    to: m ? m[2].replace(/"/g, "") : "<new>",
  };
}
