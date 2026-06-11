// src/gen/conn-string.ts — `acorn conn gen`: the MANDATORY two-connection-string contract.
//
// The single most common production breakage in the vertical (SCENARIO #11/#12, OPINIONS top stance #2):
// the transaction pooler (:6543) does NOT support named prepared statements that postgres-js/Drizzle/
// Prisma default to. So acorn ALWAYS emits two strings — pooled :6543 (prepare:false) for the app, direct
// :5432 for migrations/seeds — plus connection_limit≈1 for serverless (P18). Deterministic, NO LLM.

export type ConnProvider = "supabase" | "neon";
export type ConnRuntime = "serverless" | "serverful";

export interface ConnContract {
  /** pooled transaction-mode URL template (app traffic) — :6543, prepare disabled */
  readonly pooledUrlTemplate: string;
  /** direct URL template (migrations/seeds) — :5432, prepared statements OK */
  readonly directUrlTemplate: string;
  /** driver flags the caller must set (the load-bearing one: prepare:false on pooled) */
  readonly driverFlags: Readonly<Record<string, string | number | boolean>>;
  /** the .env keys acorn names (DATABASE_URL pooled, DIRECT_URL direct) */
  readonly env: Readonly<Record<string, string>>;
  /** receipt-carrying notes */
  readonly notes: readonly string[];
}

export function genConnString(provider: ConnProvider, runtime: ConnRuntime): ConnContract {
  const notes: string[] = [];
  const serverless = runtime === "serverless";

  if (provider === "supabase") {
    // Supavisor: transaction pooler :6543, direct :5432. pgbouncer=true disables server-side prepared stmts.
    const poolSuffix = serverless ? "&connection_limit=1" : "";
    const pooled = `postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true${poolSuffix}`;
    const direct = `postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres`;
    notes.push("Pooled :6543 (Supavisor transaction mode) for the app — prepare:false / pgbouncer=true is mandatory, the pooler can't do named prepared statements (SCENARIO #11).");
    notes.push("Direct :5432 for migrations & seeds only — prepared statements work there; never run app traffic through it.");
    if (serverless) {
      notes.push("connection_limit=1 per serverless instance (P18) — the bottleneck is too many CLIENTS racing the pooler's client cap, not too few server connections. 'just increase compute' is the downvoted-12x answer.");
    }
    return {
      pooledUrlTemplate: pooled,
      directUrlTemplate: direct,
      driverFlags: { prepare: false },
      env: { DATABASE_URL: pooled, DIRECT_URL: direct },
      notes,
    };
  }

  // Neon: -pooler host for PgBouncer pooled, plain host for direct.
  const poolSuffix = serverless ? "&connection_limit=1" : "";
  const pooled = `postgresql://[USER]:[PASSWORD]@[ENDPOINT]-pooler.[REGION].aws.neon.tech/[DB]?sslmode=require${poolSuffix}`;
  const direct = `postgresql://[USER]:[PASSWORD]@[ENDPOINT].[REGION].aws.neon.tech/[DB]?sslmode=require`;
  notes.push("Neon pooled endpoint (-pooler host, PgBouncer transaction mode) for the app with prepare:false; the plain host for migrations/seeds.");
  if (serverless) {
    notes.push("connection_limit=1 per serverless instance (P18); the pooler fans them in.");
  }
  return {
    pooledUrlTemplate: pooled,
    directUrlTemplate: direct,
    driverFlags: { prepare: false },
    env: { DATABASE_URL: pooled, DIRECT_URL: direct },
    notes,
  };
}
