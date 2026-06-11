# Ecosystem Research — pgvector / Embeddings Storage in Postgres (June 2026)

> Researcher: ECOSYSTEM (acorn / Database harness). Captured 2026-06-11. Cited.
> energy stores NO embeddings in Postgres today (FTS via tsvector GIN only) — acorn owns the vector playbook.

## 1. Version + recent deltas
- **pgvector 0.8.0** — current line. Key adds: **iterative index scans** (`hnsw.iterative_scan`, `ivfflat.iterative_scan`) that prevent **over-filtering** (when a `WHERE` filter eliminates most ANN candidates and you'd otherwise get too few rows back), and **better planner cost estimation** for when to use the ANN index vs a scan. _Source: <https://www.postgresql.org/about/news/pgvector-080-released-2952/>._
- **0.7.0** introduced **`halfvec`** (2-byte float16) + **binary quantization** → up to **67x faster HNSW index build** vs 0.5.1, and ~half the storage. _Source: <https://aws.amazon.com/blogs/database/load-vector-embeddings-up-to-67x-faster-with-pgvector-and-amazon-aurora/>._
- Supabase ships pgvector as the `vector` extension (`create extension vector;`); Neon, RDS/Aurora, Cloud SQL all support it (check exact pgvector version per provider — they lag).

## 2. HNSW vs IVFFlat — the decision (cite this)
| | HNSW | IVFFlat |
|---|---|---|
| Recall/latency | **Higher QPS, lower p99**, best for high-recall low-latency | Lower QPS at same recall |
| Build time | Slower, more memory to build | **Faster to build, smaller index** |
| Insert behavior | Index updates incrementally as you insert (no retrain) | Needs representative data at build; **must rebuild/retrain** as data grows/shifts |
| When | **Default for production** RAG/search; data changes over time | Bulk-load-once, build-fast, memory-constrained |

> "HNSW generally outperforms IVFFlat for L2 distance with default parameters … for glove-25-angular (99% recall), IVFFlat built faster and smaller, but HNSW delivered much higher QPS and lower p99." _Sources: <https://dev.to/philip_mcclarence_2ef9475/ivfflat-vs-hnsw-in-pgvector-which-index-should-you-use-305p>; <https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/>._
**acorn default: HNSW** unless build-time/memory forces IVFFlat.

## 3. Storage-size reality (the gotcha that surprises people)
- A 1536-dim OpenAI `text-embedding-3-small` vector at full `float4` = **1536 × 4 = 6,144 bytes/row JUST for the vector**, before the HNSW graph. At millions of rows this dominates table size and RAM (HNSW wants the graph in memory). _Source: instaclustr benchmark; Medium "Benchmarks, Costs, and Reality Check"._
- **Mitigations:** `halfvec` (float16 → halves it), **dimensionality reduction** (Matryoshka embeddings — store 512 or 256 dims instead of 1536), **binary quantization** (`bit` + Hamming) for a coarse first pass then re-rank. _Source: pgvector 0.7/0.8 release notes._
- **Index params:** HNSW `m` (graph degree, default 16) and `ef_construction` (build quality, default 64) trade build-time/recall; query-time `hnsw.ef_search` trades recall/latency. Tune per workload.

## 4. pgvectorscale (Timescale) — when pgvector isn't enough
- **pgvectorscale** (StreamingDiskANN + Statistical Binary Quantization) extends pgvector: on **50M vectors, 28× lower p95 latency, 16× higher throughput vs Pinecone s1 at 75% lower cost**; 1.4× lower latency vs Pinecone p2 at 79% cost savings. _Source: Timescale benchmark, cited via search corpus; <https://www.instaclustr.com/education/vector-database/pgvector-performance-benchmark-results-and-5-ways-to-boost-performance/>._ **[FLAG — these are Timescale's own vendor benchmarks; directionally strong but self-reported. See GAPS.]**
- For very large vector workloads acorn should evaluate pgvectorscale before reaching for a dedicated vector DB (Pinecone/Weaviate/Qdrant) — keeps everything in one Postgres (joins, RLS, txns).

## 5. Filtered ANN — the real-world breakage
Combining `WHERE tenant_id = ? AND embedding <-> ?` is the hard case: pre-0.8 pgvector would **over-filter** (ANN returns k candidates, the WHERE drops most, you get <k results). 0.8's **iterative scans** fix this (keep scanning until enough rows pass the filter). For multi-tenant RAG (very common in Energy products) this is essential — set `hnsw.iterative_scan = 'relaxed_order'` or `'strict_order'`. _Source: pgvector 0.8 release notes; arxiv 2602.11443 "Filtered ANN in Vector DBs"._ Alternative: **partial HNSW indexes per tenant** for big tenants, or partition by tenant.

## 6. The 5 perf levers (instaclustr)
1. Right index (HNSW default). 2. Tune `m`/`ef_construction`/`ef_search`. 3. `halfvec`/quantization to fit RAM. 4. `maintenance_work_mem` high during index build. 5. Keep the index in memory (size shared_buffers / instance for it). _Source: <https://www.instaclustr.com/education/vector-database/pgvector-performance-benchmark-results-and-5-ways-to-boost-performance/>._

## 7. Agent-operating notes
- `create extension vector;` then `CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);` (or `vector_l2_ops`/`vector_ip_ops` — MATCH the distance op to how you query: `<=>` cosine, `<->` L2, `<#>` inner product).
- Building a big HNSW index is slow + memory-hungry → do it on a branch/replica, or `CREATE INDEX CONCURRENTLY`, and bump `maintenance_work_mem` first.
- Embedding generation (OpenAI/Cohere/Voyage) happens in app code; the DB only stores + searches. Keep the embedding model + dimension recorded in a column so you can detect model drift on re-embed.
