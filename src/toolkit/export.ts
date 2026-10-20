// src/toolkit/export.ts — the thin `@energy/agent-toolkit` tool-export (F2).
//
// PLAN §4 / HARNESS-OVERRIDES "Packaging surfaces": the framework adapter is a STRETCH, not a ✅ floor
// (meta-harnesses-only; acorn ships a thin tool-export at most). This is exactly that: a single, honest
// re-export surface so a sibling Energy employee (turbo, the hub) can consume acorn's deterministic
// expertise as plain functions — `import { lintRls, safeMigration } from "acorn/dist/toolkit/export.js"` — without
// shelling out to the CLI or speaking JSON-RPC to the MCP server.
//
// These are the SAME functions the CLI (B2) and the MCP server (C1) call — one source of truth, no LLM in
// any of them. Nothing new is implemented here; this file only narrows + names the public surface.

export { lintRls } from "../lint/rls.js";
export { lintMigration, migrationOutageRisks } from "../lint/migration.js";
export { safeMigration } from "../transform/safe-migration.js";
export { genRlsPolicy, type AuthMode } from "../gen/rls-policy.js";
export { genConnString, type ConnProvider, type ConnRuntime } from "../gen/conn-string.js";
export { planVector, type VectorProvider } from "../gen/vector-plan.js";
export { decideTenancy } from "../gen/tenancy.js";
export { searchBrain } from "../brain/search.js";

/**
 * The acorn toolkit surface, as a catalog a host can introspect. Each entry names the capability and the
 * brain stance it enforces — the boundary stays explicit: acorn emits schema/migrations/RLS/data-layer
 * artifacts; it does NOT write the app that consumes them (that is turbo/pixel).
 */
export const ACORN_TOOLKIT = Object.freeze({
  name: "acorn",
  boundary: "schema / migrations / RLS / data-layer ONLY — never app code, query call-sites, or API routes",
  functions: Object.freeze([
    { name: "lintRls", does: "flag RLS pitfalls P1-P9 (no-RLS table, unwrapped auth.uid(), missing WITH CHECK, …)" },
    { name: "lintMigration", does: "flag the 5 outage-makers P10-P15 (bare CHECK/FK/NOT NULL, ALTER TYPE, non-CONCURRENT index, …)" },
    { name: "safeMigration", does: "rewrite unsafe DDL to NOT VALID+VALIDATE + CONCURRENTLY + lock_timeout" },
    { name: "genRlsPolicy", does: "emit the gated 2-policy block with wrapped (select auth.uid()) + the Clerk ::text cast" },
    { name: "genConnString", does: "emit the mandatory pooled :6543 (prepare:false) + direct :5432 split" },
    { name: "planVector", does: "choose HNSW + halfvec(≥1536) + iterative_scan for tenant-filtered ANN" },
    { name: "decideTenancy", does: "the shared-schema+tenant_id+RLS-default tenancy decision tree" },
    { name: "searchBrain", does: "BM25 over brain/*.md — acorn's expertise corpus" },
  ]),
} as const);
