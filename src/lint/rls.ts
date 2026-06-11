// src/lint/rls.ts — acorn's deterministic RLS lint (pitfalls P1-P9).
//
// Pure SQL-text analysis, NO LLM (HARNESS-OVERRIDES §4). Every rule is a brain pitfall:
//   P1  every public.* table must `ENABLE ROW LEVEL SECURITY`        [KNOWN-PITFALLS P1, SCENARIO #1, CVE-2025-48757]
//   P2  unwrapped `auth.uid()` (want `(select auth.uid())`)          [P3, OPINIONS §RLS]   (numbered P2 in PLAN's P1-P9 lint band)
//   P3  a policy with `USING` but no `WITH CHECK` on a write path    [P5]
//   P4  recursive-policy risk: a policy body that SELECTs a table    [P6, SCENARIO #3]  → suggest SECURITY DEFINER helper
//   P5  missing index on the RLS predicate column                   [P4]
//   P7  Clerk auth compared without `::text` cast                    [P7, SCENARIO B2]
//   P9  `using (true)` with no role gate = RLS-off for anon          [P9, energy 001_user_memories.sql footgun]
//
// PLAN §4: `acorn rls lint` flags "every public.* table without RLS; unwrapped auth.uid(); missing
// WITH CHECK; recursive-policy risk; missing predicate index (P1-P9)". exit non-zero on violation.

import { splitStatements, tableNameFrom, type Statement } from "./sql-util.js";
import { toResult, type LintResult, type Violation } from "./types.js";

interface Mut {
  push(v: Violation): void;
}

/** Lint a SQL script for the 9 RLS pitfalls. */
export function lintRls(sql: string): LintResult {
  const statements = splitStatements(sql);
  const violations: Violation[] = [];
  const sink: Mut = { push: (v) => violations.push(v) };

  // ---- pass 1: catalog the schema ----
  const createdTables = new Map<string, Statement>(); // table → its CREATE TABLE statement
  const rlsEnabled = new Set<string>(); // tables that got ENABLE ROW LEVEL SECURITY
  const policiesByTable = new Map<string, Statement[]>();
  const indexedColsByTable = new Map<string, Set<string>>();

  for (const st of statements) {
    const s = st.sql;
    if (/\bcreate\s+table\b/i.test(s)) {
      const t = tableNameFrom(s);
      if (t) createdTables.set(t, st);
    } else if (/\balter\s+table\b/i.test(s) && /\benable\s+row\s+level\s+security\b/i.test(s)) {
      const t = tableNameFrom(s);
      if (t) rlsEnabled.add(t);
    } else if (/\bcreate\s+policy\b/i.test(s)) {
      const t = policyTarget(s);
      if (t) {
        const arr = policiesByTable.get(t) ?? [];
        arr.push(st);
        policiesByTable.set(t, arr);
      }
    } else if (/\bcreate\b.*\bindex\b/i.test(s)) {
      const { table, cols } = indexTarget(s);
      if (table) {
        const set = indexedColsByTable.get(table) ?? new Set<string>();
        for (const c of cols) set.add(c);
        indexedColsByTable.set(table, set);
      }
    }
  }

  // ---- pass 2: the rules ----
  // P1 — every created public table must have RLS enabled.
  for (const [table, st] of createdTables) {
    if (!rlsEnabled.has(table)) {
      sink.push({
        rule: "P1",
        table,
        line: st.line,
        severity: "error",
        message: `RLS not enabled on public.${table}. Add 'ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;' — migration-created tables are NOT covered by Supabase's secure-by-default; the anon key reads everything (CVE-2025-48757, 170 apps).`,
      });
    }
  }

  // Per-policy rules (P2 wrapping, P3 WITH CHECK, P4 recursion, P7 Clerk cast, P9 using(true)).
  for (const [table, policies] of policiesByTable) {
    for (const st of policies) {
      const s = st.sql;

      // P2 — unwrapped auth.uid()/auth.jwt()/current_setting re-evaluates per row.
      if (hasUnwrappedAuth(s)) {
        sink.push({
          rule: "P2",
          table,
          line: st.line,
          severity: "error",
          message: `Unwrapped auth function in the policy on public.${table}. Wrap as '(select auth.uid())' so the planner caches it once as an initPlan — bare auth.uid() re-evaluates per row (a 5ms policy becomes 5s on 100K rows).`,
        });
      }

      // P9 — `using (true)` with no role gate is RLS-off for anon too.
      if (/\busing\s*\(\s*true\s*\)/i.test(s) && !/\bauth\.(role|jwt)\b|\bservice_role\b/i.test(s)) {
        sink.push({
          rule: "P9",
          table,
          line: st.line,
          severity: "error",
          message: `Policy on public.${table} uses 'using (true)' with no role gate — that is effectively RLS-off for everyone including anon (energy's 001_user_memories.sql footgun). Gate on service_role AND add a per-tenant '(select auth.uid())::text = user_id' policy.`,
        });
      }

      // P7 — Clerk text id compared to auth.uid() (uuid) without ::text → silently denies all.
      if (looksLikeClerkCast(s)) {
        sink.push({
          rule: "P7",
          table,
          line: st.line,
          severity: "warning",
          message: `Policy on public.${table} compares auth.uid() (uuid) to a text id without a '::text' cast — Clerk ids are non-uuid text, so the type mismatch silently denies every row. Use '(select auth.uid())::text = user_id'.`,
        });
      }

      // P4 — a policy whose body SELECTs another table risks runtime recursion (a 500, not a migrate error).
      if (/\busing\b/i.test(s) && /\bselect\b/i.test(afterUsing(s)) && /\bfrom\b/i.test(afterUsing(s))) {
        sink.push({
          rule: "P4",
          table,
          line: st.line,
          severity: "warning",
          message: `Policy on public.${table} queries another table in its body — if that table's own policy references back, Postgres raises 'infinite recursion detected in policy' at runtime (a user-facing 500, never caught at migrate time). Move the lookup into a SECURITY DEFINER helper in a private schema.`,
        });
      }
    }

    // P3 — a tenant table whose policies cover writes (ALL/INSERT/UPDATE) must carry WITH CHECK somewhere.
    const coversWrite = policies.some((p) => /\bfor\s+(all|insert|update)\b/i.test(p.sql));
    const hasWithCheck = policies.some((p) => /\bwith\s+check\b/i.test(p.sql));
    if (coversWrite && !hasWithCheck) {
      const first = policies[0];
      sink.push({
        rule: "P3",
        table,
        line: first.line,
        severity: "error",
        message: `Write policy on public.${table} has no WITH CHECK clause — USING filters reads, WITH CHECK validates writes. Without it a user can INSERT/UPDATE a row under another tenant's id. Add WITH CHECK and test INSERT/UPDATE/DELETE as 'authenticated'.`,
      });
    }

    // P5 — the RLS predicate column should be indexed (seq scan under the policy on large tables otherwise).
    const predicateCols = predicateColumns(policies);
    const indexed = indexedColsByTable.get(table) ?? new Set<string>();
    for (const col of predicateCols) {
      if (!indexed.has(col)) {
        sink.push({
          rule: "P5",
          table,
          line: (policiesByTable.get(table)?.[0] ?? statements[0]).line,
          severity: "warning",
          message: `RLS predicate column public.${table}.${col} is not indexed — a policy filtering on it falls back to a seq scan (>100x slower on large tables). Add an index on ${col} (tenant_id first in any composite index).`,
        });
      }
    }
  }

  return toResult(violations);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** the table a `CREATE POLICY ... ON <table>` targets. */
function policyTarget(sql: string): string {
  const m = /\bon\s+(?:only\s+)?([a-zA-Z0-9_."]+)/i.exec(sql);
  if (!m) return "";
  return m[1].replace(/"/g, "").replace(/^public\./i, "");
}

/** detect a bare auth.uid()/auth.jwt()/auth.role() or current_setting() NOT wrapped in a subselect. */
function hasUnwrappedAuth(sql: string): boolean {
  // strip every `( select ... auth.uid() ... )` wrapped occurrence, then see if any bare call remains.
  const withoutWrapped = sql.replace(/\(\s*select\b[^)]*?auth\.\w+\s*\([^)]*\)[^)]*\)/gi, " ");
  const withoutWrappedSetting = withoutWrapped.replace(
    /\(\s*select\b[^)]*?current_setting\s*\([^)]*\)[^)]*\)/gi,
    " ",
  );
  return /\bauth\.(uid|jwt|role)\s*\(/i.test(withoutWrappedSetting) ||
    /\bcurrent_setting\s*\(/i.test(withoutWrappedSetting);
}

/** does the policy compare auth.uid() to a column without a ::text cast (Clerk footgun)? */
function looksLikeClerkCast(sql: string): boolean {
  // an auth.uid() (or wrapped) compared with `=` to an identifier, with no ::text on either side.
  if (!/auth\.uid\s*\(\s*\)/i.test(sql)) return false;
  if (/::\s*text/i.test(sql)) return false; // already cast → fine
  // a comparison `auth.uid() = something` or `something = auth.uid()`
  return /auth\.uid\s*\(\s*\)\s*=\s*[a-z_]/i.test(sql) || /[a-z_]\w*\s*=\s*\(?\s*select?[^=]*auth\.uid/i.test(sql);
}

/** text after the first USING in a policy (where a recursive subquery would live). */
function afterUsing(sql: string): string {
  const m = /\busing\b/i.exec(sql);
  return m ? sql.slice(m.index) : "";
}

/** best-effort: pull column names that appear as RLS predicate filters (`<col> = ...`). */
function predicateColumns(policies: readonly Statement[]): Set<string> {
  const cols = new Set<string>();
  for (const p of policies) {
    const body = afterUsing(p.sql);
    // patterns like `tenant_id = (select auth.uid())` or `org_id = ...`
    const re = /\b([a-z_][a-z0-9_]*)\s*=\s*\(?\s*select|\b([a-z_][a-z0-9_]*)\s*=\s*auth\./gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const col = m[1] ?? m[2];
      if (col && !["select", "auth"].includes(col.toLowerCase())) cols.add(col.toLowerCase());
    }
  }
  return cols;
}

/** {table, cols} from a CREATE INDEX ... ON <table> (col, col). */
function indexTarget(sql: string): { table: string; cols: string[] } {
  const m = /\bon\s+(?:only\s+)?([a-zA-Z0-9_."]+)\s*(?:using\s+\w+\s*)?\(([^)]*)\)/i.exec(sql);
  if (!m) return { table: "", cols: [] };
  const table = m[1].replace(/"/g, "").replace(/^public\./i, "");
  const cols = m[2]
    .split(",")
    .map((c) => c.trim().replace(/"/g, "").split(/\s+/)[0].toLowerCase())
    .filter((c) => c.length > 0);
  return { table, cols };
}
