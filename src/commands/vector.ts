// src/commands/vector.ts — the `acorn vector` group: plan · recall.
//
// plan   → choose HNSW + halfvec(≥1536) + op-class, emit CREATE TABLE/INDEX, inject hnsw.iterative_scan. (B3)
// recall → measure recall@k before tuning; recommend ef_search before m/ef_construction. (needs a live DB — E3)

import { Command } from "commander";
import { planVector, type VectorProvider } from "../gen/vector-plan.js";
import { emitSql, emitNotes } from "../cli/render.js";

export function vectorCommand(): Command {
  const vector = new Command("vector").description("pgvector: plan the HNSW/halfvec table+index, measure recall before tuning");

  vector
    .command("plan")
    .requiredOption("--dim <n>", "embedding dimension (e.g. 1536)")
    .option("--provider <p>", "supabase | neon", "supabase")
    .option("--table <t>", "the embeddings table name", "documents")
    .description("choose HNSW + halfvec(≥1536) + op-class, emit CREATE TABLE/INDEX, inject hnsw.iterative_scan for tenant-filtered ANN")
    .action((opts: { dim: string; provider: string; table: string }) => {
      const dim = Number.parseInt(opts.dim, 10);
      if (!Number.isFinite(dim) || dim <= 0) {
        process.stderr.write(`acorn vector plan: --dim must be a positive integer (got '${opts.dim}')\n`);
        process.exitCode = 2;
        return;
      }
      const provider = (opts.provider === "neon" ? "neon" : "supabase") as VectorProvider;
      const plan = planVector({ dim, provider, table: opts.table });
      emitSql(plan.tableSql);
      emitSql("");
      emitSql(plan.indexSql);
      emitNotes(plan.notes);
    });

  vector
    .command("recall")
    .argument("<table>", "the embeddings table to benchmark")
    .description("measure recall@k before tuning; recommend ef_search before m/ef_construction (P24)")
    .action((table: string) => {
      process.stderr.write(
        `acorn vector recall — benchmarks recall@k on ${table} against a brute-force ground truth, then recommends raising hnsw.ef_search (free, query-time) BEFORE m/ef_construction (which doubles build cost).\n` +
          "Requires a live Postgres with pgvector + representative data (the sandbox component). 'The defaults are tuned for a demo, not your workload.'\n",
      );
      process.exitCode = process.env.DATABASE_URL ? 0 : 2;
    });

  return vector;
}
