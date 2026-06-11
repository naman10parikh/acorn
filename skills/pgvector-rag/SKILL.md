---
name: pgvector-rag
description: Store and search embeddings / add semantic search over Postgres with pgvector. Use when the ask is "add semantic search", "store embeddings", "build RAG over this table", "vector search is slow", or "tenant-scoped similarity search". Encodes HNSW default, halfvec for ≥1536-dim, measure-recall-first, and iterative_scan for tenant-filtered ANN.
---

# pgvector-rag

> **Brain source:** `brain/OPINIONS.md` §pgvector · `brain/KNOWN-PITFALLS.md` §pgvector (P24-P27) · `brain/BATTLE-TESTED-SCENARIOS.md` #9 (filtered-ANN over-filter), #10 (halfvec storage blowup) · `brain/EXPERTISE-MAP.md` JTBD 4. energy stores no embeddings in Postgres today — acorn owns the vector playbook.

## Trigger

"Add semantic search over `documents`", "store OpenAI embeddings in Postgres", "RAG scoped to the current tenant", "our vector queries got slow", "which index for pgvector".

## Steps

1. **Index choice: default HNSW.** Higher QPS, lower p99, builds incrementally on an empty/growing table (no retrain). Reach for **IVFFlat** only when memory-constrained *and* data is static (must be built AFTER data loads; degrades as data drifts).
2. **Storage: default `halfvec` for ≥1536-dim.** A 1536-dim `float4` vector = 6,148 bytes/row before the graph; `halfvec` (float16) is an exact 50% cut + ~23% faster build with matching recall — "an obvious choice." Full `vector()` only if you MEASURED a recall regression. Binary quantization (1-bit) only behind a re-rank stage (it tanks recall on 1536-dim alone).
3. **Tune by measuring recall FIRST.** Raise query-time `hnsw.ef_search` (default 40 → too low; raise to 200–800) — it is **free, no rebuild**. Only after measuring a recall gap, raise build-time `m`/`ef_construction` (they **double build time + memory** for a marginal gain).
4. **Tenant-filtered ANN: enable `hnsw.iterative_scan`.** `WHERE tenant_id = ? AND embedding <=> ? LIMIT 10` on pre-0.8 pgvector **over-filters** (HNSW returns k candidates, the filter drops most, you get <k). `SET hnsw.iterative_scan = 'relaxed_order';` keeps scanning until enough rows pass. **Confirm the provider ships pgvector ≥ 0.8** (`acorn doctor` reports it). For very large tenants, a partial HNSW index per tenant.
5. **Match the op-class to the operator:** `vector_cosine_ops`↔`<=>`, `vector_l2_ops`↔`<->`, `vector_ip_ops`↔`<#>` (halfvec variants for halfvec columns).
6. **Record the embedding model + dimension in a column** — the only way to detect model drift on re-embed.

## Output

The `CREATE TABLE` (with `halfvec`/`vector` chosen by dimension + a `tenant_id` + an `embedding_model` column) and the `CREATE INDEX` (HNSW + the tenant index + the `iterative_scan`/`ef_search` settings), via `acorn vector plan --dim <n> --provider <supabase|neon>` → `src/gen/vector-plan.ts`. Boundary reminder: acorn stores/indexes/searches embeddings; **generating** the vectors (OpenAI/Cohere/Voyage calls) is app code, not acorn's.

## Worked example

**Ask:** *"Add semantic search over `documents`, scoped to the current tenant. 1536-dim OpenAI embeddings, millions of rows, on Supabase."* (Scenarios #9 + #10)

**acorn emits (`acorn vector plan --dim 1536 --provider supabase`):**
```sql
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content text NOT NULL,
  embedding halfvec(1536) NOT NULL,        -- acorn: ≥1536-dim → halfvec (50% storage, ~23% faster build, matching recall)
  embedding_model text NOT NULL,           -- acorn: record model+dim to detect drift on re-embed
  embedding_dim int NOT NULL DEFAULT 1536,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_embedding_hnsw
  ON public.documents USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_tenant_idx ON public.documents (tenant_id);

SET hnsw.iterative_scan = 'relaxed_order';  -- acorn: MANDATORY for tenant-filtered ANN, else <LIMIT rows (#9). Needs pgvector ≥ 0.8.
SET hnsw.ef_search = 100;                    -- acorn: raise this (free) before m/ef_construction; measure recall@k first.
```
**acorn then says:** *"Run `acorn doctor` first to confirm Supabase ships pgvector ≥ 0.8 — without `iterative_scan` a tenant with 1000 matches will return <10. Measure recall@10 before touching `m`/`ef_construction`."* The `halfvec` switch alone drops table+index size ~50% with no recall regression at the same `ef_search` (Scenario #10).
