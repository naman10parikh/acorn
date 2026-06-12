// test/integration/rls.test.ts — the sandbox safety + live-RLS integration tests (E3).
//
// Two layers:
//   1. prodGuard (ALWAYS runs, no DB) — the load-bearing safety invariant: acorn must REFUSE to mutate a
//      production-looking DATABASE_URL and ALLOW only branch/dev targets. A regression here is the worst
//      thing acorn could do (write to prod), so it is unit-tested deterministically with no DB.
//   2. live RLS as the un-privileged role (runs ONLY when DATABASE_URL is set — CI's supabase/postgres
//      service; locally skipped with describe.skipIf) — applies a tenant schema + RLS, then asserts an
//      `anon` SELECT sees 0 rows and an `authenticated` user sees ONLY their tenant's rows. NEVER the SQL
//      Editor / postgres role (the flagship invariant). A prod-write attempt is asserted to be refused.

import { describe, it, expect } from "vitest";
import { prodGuard, applySql, runRlsAsRole, psqlAvailable } from "../../src/sandbox/provision.js";

describe("prodGuard — the prod-write refusal (always runs, no DB)", () => {
  it("REFUSES a bare production Supabase pooler URL (no branch marker)", () => {
    const r = prodGuard("postgresql://postgres.abcd:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(r.allowed).toBe(false);
  });

  it("REFUSES any URL with a 'prod'/'production' marker even with ACORN_DEV_DB override", () => {
    const r = prodGuard("postgresql://user:pw@prod-db.example.com:5432/app", { devOverride: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/production marker/i);
  });

  it("REFUSES when no DATABASE_URL is given (never guesses a target)", () => {
    expect(prodGuard(undefined).allowed).toBe(false);
    expect(prodGuard("").allowed).toBe(false);
  });

  it("ALLOWS a localhost / container Postgres (ephemeral)", () => {
    expect(prodGuard("postgresql://postgres:postgres@localhost:5432/postgres").allowed).toBe(true);
    expect(prodGuard("postgresql://postgres:postgres@127.0.0.1:5432/postgres").allowed).toBe(true);
    // the CI `services:` host is `postgres` on the docker network
    expect(prodGuard("postgresql://postgres:postgres@postgres:5432/postgres").allowed).toBe(true);
  });

  it("ALLOWS a Neon branch endpoint (throwaway)", () => {
    expect(prodGuard("postgresql://u:pw@ep-cool-bird-br-123.us-east-2.aws.neon.tech/db?sslmode=require").allowed).toBe(true);
  });

  it("ALLOWS an explicit dev override only when no prod marker is present", () => {
    expect(prodGuard("postgresql://u:pw@some-random-host.example.com:5432/x", { devOverride: true }).allowed).toBe(true);
    expect(prodGuard("postgresql://u:pw@some-random-host.example.com:5432/x").allowed).toBe(false);
  });
});

// ── live RLS integration (CI only — needs a real Postgres) ────────────────────────────────────────────
const DB = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DB) && psqlAvailable() && prodGuard(DB).allowed;

describe.skipIf(!HAVE_DB)("live RLS as the un-privileged role (DATABASE_URL present)", () => {
  // A minimal tenant schema with deny-by-default RLS, applied to the branch/dev DB. The `authenticated`
  // role exists on supabase/postgres; `anon` too. We use a uuid tenant id and the wrapped (select auth.uid()).
  const SETUP = `
    DROP TABLE IF EXISTS public.it_tickets;
    CREATE TABLE public.it_tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, body text);
    ALTER TABLE public.it_tickets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY it_tenant ON public.it_tickets FOR ALL TO authenticated
      USING (org_id = (select auth.uid())) WITH CHECK (org_id = (select auth.uid()));
    GRANT SELECT, INSERT ON public.it_tickets TO authenticated, anon;
    INSERT INTO public.it_tickets (org_id, body) VALUES
      ('11111111-1111-1111-1111-111111111111','tenant A row'),
      ('22222222-2222-2222-2222-222222222222','tenant B row');
  `;

  it("applies the tenant schema cleanly", () => {
    const res = applySql(DB!, SETUP);
    expect(res.ok, res.stderr).toBe(true);
  });

  it("anon SELECT returns 0 rows (RLS denies the public key — CVE-2025-48757 defense)", () => {
    const res = runRlsAsRole(DB!, "anon", "SELECT count(*) AS n FROM public.it_tickets");
    expect(res.ok, res.stderr).toBe(true);
    // psql prints the count; with RLS on + no anon policy, anon sees 0.
    expect(res.stdout).toMatch(/\b0\b/);
  });

  it("authenticated user A sees ONLY tenant A's row (isolation; never as postgres)", () => {
    const res = runRlsAsRole(
      DB!,
      "authenticated",
      "SELECT body FROM public.it_tickets",
      { jwtSub: "11111111-1111-1111-1111-111111111111" },
    );
    expect(res.ok, res.stderr).toBe(true);
    expect(res.stdout).toMatch(/tenant A row/);
    expect(res.stdout).not.toMatch(/tenant B row/);
  });

  it("REFUSES a write to a prod-looking URL (the prod-write attempt is blocked before psql)", () => {
    const res = applySql("postgresql://u:pw@prod-main.example.com:5432/app", "CREATE TABLE x(i int);");
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/refused/i);
  });
});
