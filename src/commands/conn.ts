// src/commands/conn.ts — the `acorn conn` group: gen.
//
// gen → emit the MANDATORY two-connection-string contract: pooled :6543 prepare:false + direct :5432,
//       with connection_limit for serverless. The #1 production breakage in the vertical. (B3)

import { Command } from "commander";
import { genConnString, type ConnProvider, type ConnRuntime } from "../gen/conn-string.js";
import { emitNotes } from "../cli/render.js";

export function connCommand(): Command {
  const conn = new Command("conn").description("connection strings: the mandatory pooled :6543 (prepare:false) + direct :5432 split");

  conn
    .command("gen")
    .option("--provider <p>", "supabase | neon", "supabase")
    .option("--runtime <r>", "serverless | serverful", "serverless")
    .option("--json", "emit JSON for agent consumption")
    .description("emit the two-string contract: pooled :6543 prepare:false + direct :5432, with connection_limit for serverless (SCENARIO #11/#12)")
    .action((opts: { provider: string; runtime: string; json?: boolean }) => {
      const provider = (opts.provider === "neon" ? "neon" : "supabase") as ConnProvider;
      const runtime = (opts.runtime === "serverful" ? "serverful" : "serverless") as ConnRuntime;
      const contract = genConnString(provider, runtime);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              pooled_url_template: contract.pooledUrlTemplate,
              direct_url_template: contract.directUrlTemplate,
              driver_flags: contract.driverFlags,
              env: contract.env,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      process.stdout.write(`# pooled (app, transaction mode) — prepare:false mandatory:\nDATABASE_URL=${contract.pooledUrlTemplate}\n`);
      process.stdout.write(`# direct (migrations/seeds only):\nDIRECT_URL=${contract.directUrlTemplate}\n`);
      process.stdout.write(`# driver flags: ${JSON.stringify(contract.driverFlags)}\n`);
      emitNotes(contract.notes);
    });

  return conn;
}
