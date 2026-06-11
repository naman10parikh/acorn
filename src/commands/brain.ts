// src/commands/brain.ts — the `acorn brain` group: search.
//
// search → BM25 over brain/*.md (the Memory component). Closes the A5 round-trip: the binary surfaces
//          brain/BATTLE-TESTED-SCENARIOS.md (#9) for the canonical probe "filtered ANN over-filter". (A5 backing)

import { Command } from "commander";
import { searchBrain } from "../brain/search.js";

export function brainCommand(): Command {
  const brain = new Command("brain").description("query acorn's expertise brain (BM25 over brain/*.md)");

  brain
    .command("search")
    .argument("<query...>", "the search query")
    .option("--json", "emit JSON for agent consumption")
    .option("--limit <n>", "max hits", "5")
    .description("BM25 over brain/*.md — ranked hits with file, score, excerpt (the Memory component)")
    .action((queryParts: string[], opts: { json?: boolean; limit: string }) => {
      const query = queryParts.join(" ");
      const limit = Number.parseInt(opts.limit, 10) || 5;
      const hits = searchBrain(query, { limit });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ hits }, null, 2) + "\n");
        process.exitCode = hits.length === 0 ? 1 : 0;
        return;
      }
      if (hits.length === 0) {
        process.stdout.write(`No brain hits for: ${query}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`=== brain search: "${query}" ===\n\n`);
      hits.forEach((h, i) => {
        process.stdout.write(`[${i + 1}] ${h.file} (score ${h.score})\n    ${h.excerpt}\n\n`);
      });
    });

  return brain;
}
