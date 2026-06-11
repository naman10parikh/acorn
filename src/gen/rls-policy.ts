// src/gen/rls-policy.ts — `acorn rls gen`: emit the gated 2-policy block for a tenant table.
//
// The output is deny-by-default + a service_role gate (documentation of intent) + a per-tenant policy
// using the WRAPPED (select auth.uid()), with BOTH USING and WITH CHECK, and the Clerk `::text` cast when
// --auth clerk (SCENARIO B2 — the type mismatch silently denies every row). Deterministic, NO LLM.
// [OPINIONS §RLS, PLAN §4 `acorn rls gen`]

export type AuthMode = "clerk" | "supabase-jwt";

export interface RlsGenInput {
  readonly table: string;
  /** the tenant-scoping column (e.g. user_id, org_id, tenant_id) */
  readonly tenantCol: string;
  readonly auth: AuthMode;
}

export function genRlsPolicy(input: RlsGenInput): string {
  const table = input.table.replace(/^public\./i, "");
  const col = input.tenantCol;
  // Clerk ids are text → cast auth.uid() to text. Supabase-JWT ids are uuid → no cast.
  const subject = input.auth === "clerk" ? "(select auth.uid())::text" : "(select auth.uid())";
  const castNote =
    input.auth === "clerk"
      ? "-- acorn: ::text cast is mandatory for Clerk — auth.uid() is uuid, Clerk ids are text; without it the policy silently denies everything (SCENARIO B2)."
      : "-- acorn: Supabase-Auth JWT — auth.uid() is uuid, compared to a uuid tenant column (no cast).";

  return [
    `-- acorn rls gen: gated 2-policy block for public.${table} (deny-by-default + service_role gate + per-tenant).`,
    `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
    ``,
    `-- (1) service_role gate: documents intent. service_role already bypasses RLS, so this is NOT the enforcement (P8).`,
    `CREATE POLICY "${table}_service_role" ON public.${table}`,
    `  FOR ALL TO service_role USING (true) WITH CHECK (true);`,
    ``,
    `-- (2) per-tenant isolation: the real gate. Wrapped subselect = evaluated once as an initPlan (P3).`,
    castNote,
    `CREATE POLICY "${table}_tenant_isolation" ON public.${table}`,
    `  FOR ALL TO authenticated`,
    `  USING (${col} = ${subject})`,
    `  WITH CHECK (${col} = ${subject});`,
    ``,
    `-- acorn: index the predicate column so the policy doesn't fall back to a seq scan (P4).`,
    `CREATE INDEX IF NOT EXISTS ${table}_${col}_idx ON public.${table} (${col});`,
    ``,
    `-- acorn: TEST this as the un-privileged role — 'SET ROLE authenticated' + request.jwt.claims, NEVER the SQL Editor (it runs as postgres and bypasses ALL RLS).`,
  ].join("\n");
}
