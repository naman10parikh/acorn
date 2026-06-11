// src/gen/vector-plan.ts — `acorn vector plan`: choose HNSW + halfvec(≥1536) + op-class, emit the
// CREATE TABLE/INDEX, inject hnsw.iterative_scan for tenant-filtered ANN. Deterministic, NO LLM.
// [OPINIONS §pgvector, SCENARIOS #9/#10, PLAN §4 `acorn vector plan`]

export type VectorProvider = "supabase" | "neon";

export interface VectorPlanInput {
  readonly dim: number;
  readonly provider: VectorProvider;
  /** the table to store embeddings in (default: documents) */
  readonly table?: string;
}

export interface VectorPlan {
  readonly tableSql: string;
  readonly indexSql: string;
  readonly notes: readonly string[];
}

export function planVector(input: VectorPlanInput): VectorPlan {
  const table = (input.table ?? "documents").replace(/^public\./i, "");
  const notes: string[] = [];

  // halfvec for ≥1536-dim — exact 50% storage cut, ~23% faster build, matching recall (OPINIONS §pgvector).
  const useHalfvec = input.dim >= 1536;
  const colType = useHalfvec ? `halfvec(${input.dim})` : `vector(${input.dim})`;
  const opClass = useHalfvec ? "halfvec_cosine_ops" : "vector_cosine_ops";
  if (useHalfvec) {
    notes.push(`dim ${input.dim} ≥ 1536 → halfvec(${input.dim}) (50% storage cut + ~23% faster build, matching recall — 'an obvious choice'). Full vector() only if you MEASURE a recall regression.`);
  } else {
    notes.push(`dim ${input.dim} < 1536 → vector(${input.dim}) is fine (halfvec's RAM win matters at high dim).`);
  }

  const tableSql = [
    `CREATE TABLE IF NOT EXISTS public.${table} (`,
    `  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- acorn: feature-detect uuidv7() at provision time; gen_random_uuid() is the PG<18 fallback`,
    `  tenant_id uuid NOT NULL,`,
    `  content text NOT NULL,`,
    `  embedding ${colType} NOT NULL,`,
    `  embedding_model text NOT NULL,  -- acorn: record model+dim — the only way to detect drift on re-embed`,
    `  embedding_dim int NOT NULL DEFAULT ${input.dim},`,
    `  created_at timestamptz NOT NULL DEFAULT now()`,
    `);`,
  ].join("\n");

  const indexSql = [
    `-- acorn: HNSW (better recall/latency than IVFFlat; builds incrementally on growing tables).`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_embedding_hnsw`,
    `  ON public.${table} USING hnsw (embedding ${opClass});`,
    `-- acorn: index the tenant predicate so filtered ANN doesn't seq-scan.`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_tenant_idx ON public.${table} (tenant_id);`,
    ``,
    `-- acorn: MANDATORY for tenant-filtered ANN — without it the filter over-filters and returns < LIMIT rows (SCENARIO #9). Needs pgvector ≥ 0.8.`,
    `SET hnsw.iterative_scan = 'relaxed_order';`,
    `-- acorn: raise ef_search (free, query-time) BEFORE m/ef_construction (doubles build cost). Measure recall@k first.`,
    `SET hnsw.ef_search = 100;`,
  ].join("\n");

  notes.push("Enable hnsw.iterative_scan for tenant-filtered ANN (SCENARIO #9). Probe pgvector ≥ 0.8 first — 'acorn doctor' reports the version.");
  notes.push("Measure recall@k before tuning; raise ef_search before the build knobs (OPINIONS §pgvector).");

  return { tableSql, indexSql, notes };
}
