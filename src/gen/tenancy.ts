// src/gen/tenancy.ts — the tenancy decision tree as a pure function (JTBD 1c).
//
// acorn defaults shared-schema + tenant_id + RLS (the model energy already uses), and NAMES the dispute
// rather than pretending it's universal (OPINIONS §Platform selection: NEVER table-prefix — even Convex
// abandoned it). Deterministic, NO LLM. PLAN §4 / EXPERTISE-MAP JTBD 1c.

export type TenancyModel = "shared-schema-rls" | "schema-per-tenant" | "database-per-tenant";

export interface TenancyDecision {
  readonly model: TenancyModel;
  readonly rationale: string;
  /** the column house-style acorn applies under the chosen model */
  readonly notes: readonly string[];
}

export interface TenancyInput {
  /** expected tenant count (drives the default) */
  readonly tenants?: number;
  /** regulated / data-residency requirement forces DB-per-tenant */
  readonly regulated?: boolean;
}

export function decideTenancy(input: TenancyInput = {}): TenancyDecision {
  const tenants = input.tenants ?? 10_000;
  const sharedNotes = [
    "tenant_id on every tenant table; composite unique keys as (tenant_id, natural_key), tenant_id first in composite indexes (OPINIONS §Schema design).",
    "RLS is the floor: deny-by-default, two policies per table, wrapped (select auth.uid()), BOTH USING + WITH CHECK, the predicate column indexed.",
    "NEVER multi-tenant by table-prefix — even Convex abandoned it for performance + messy abstractions.",
  ];

  if (input.regulated) {
    return {
      model: "database-per-tenant",
      rationale:
        "Regulated / data-residency requirement → database-per-tenant (hard isolation per the compliance boundary). Highest ops cost; only justified by regulation, not scale.",
      notes: ["Separate database per tenant; RLS still applies inside each as defense-in-depth.", ...sharedNotes],
    };
  }

  if (tenants <= 500) {
    return {
      model: "schema-per-tenant",
      rationale: `~${tenants} tenants → schema-per-tenant is viable (a Postgres schema per tenant). Only at 10-500 tenants; it stops scaling at thousands (catalog bloat, migration fan-out).`,
      notes: ["One schema per tenant; the same migration is applied across all schemas (fan-out cost grows with tenant count).", ...sharedNotes],
    };
  }

  return {
    model: "shared-schema-rls",
    rationale: `~${tenants} tenants → shared-schema + tenant_id + RLS (the default; the model energy already uses). Scales to 10k-100k+ tenants; one schema, one migration, isolation enforced by RLS.`,
    notes: sharedNotes,
  };
}
