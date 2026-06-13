// test/contract/mcp-jsonrpc.test.ts — the MCP JSON-RPC contract layer (PLAN §9 "Contract (MCP JSON-RPC)").
//
// acorn's PRODUCT is a CLI + an MCP server. The Testing-contract (§9) names a dedicated layer:
//   "tools/list returns the 12 tools with correct schemas; each tools/call round-trips; error shapes valid"
//   tooling: "a JSON-RPC test harness against the stdio server".
// Until now that contract was only proven by a manual `echo '{…}' | node dist/mcp/server.js` in the C1 board
// notes — NOT in `pnpm test`, so a regression in src/mcp/{server,tools}.ts would NOT turn CI red. This file
// IS that automated JSON-RPC harness: it spawns the BUILT stdio server (dist/mcp/server.js — the exact binary
// a sibling agent like turbo runs), sends real line-delimited JSON-RPC 2.0 frames, and asserts the wire
// contract. Every assertion fails loud if the protocol or a tool handler breaks (proven red-once-then-green,
// Wave-T notes). NO DB, NO network, NO LLM — the DB-touching tools return their honest precondition (asserted
// here as NOT-a-fake), the live legs are E3 (test/integration/rls.test.ts).
//
// Requires a prior `pnpm build` (CI + the acceptance job build before test; bad-paths.test.ts has the same
// precondition). The server is a request/response loop over stdin/stdout — we write one frame, read one line.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(process.cwd(), "dist", "mcp", "server.js");

/**
 * Drive the stdio MCP server with one or more JSON-RPC frames. We pipe all frames in on stdin at once; the
 * server is line-delimited (one request per line) and the readline `close` handler exits cleanly when stdin
 * ends, so spawnSync returns after every line is processed. Returns the parsed response objects (in order),
 * skipping blank lines (notifications produce no output, per the JSON-RPC spec).
 */
function rpc(frames: object[]): Array<Record<string, unknown>> {
  const input = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
  const res = spawnSync("node", [SERVER], { input, encoding: "utf8" });
  // The server never crashes on bad input (it returns JSON-RPC errors), so a non-zero exit is itself a bug.
  expect(res.status, `server exited ${res.status}; stderr: ${res.stderr}`).toBe(0);
  return (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Send a single frame and return the single response. */
function one(frame: object): Record<string, unknown> {
  const out = rpc([frame]);
  expect(out.length, "expected exactly one response frame").toBe(1);
  return out[0];
}

const EXPECTED_TOOLS = [
  "acorn_schema",
  "acorn_rls_lint",
  "acorn_rls_gen",
  "acorn_rls_test",
  "acorn_migration_lint",
  "acorn_migration_safe",
  "acorn_vector_plan",
  "acorn_conn_gen",
  "acorn_provision",
  "acorn_backup_plan",
  "acorn_doctor",
  "acorn_brain_search",
];

describe("MCP JSON-RPC contract — the stdio server (PLAN §9 Contract layer)", () => {
  beforeAll(() => {
    expect(existsSync(SERVER), `built MCP server missing at ${SERVER} — run 'pnpm build' first`).toBe(true);
  });

  // ── handshake ──────────────────────────────────────────────────────────────
  it("initialize → returns the protocol version + serverInfo (a real MCP client handshakes first)", () => {
    const resp = one({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(resp.id).toBe(1);
    const result = resp.result as Record<string, unknown>;
    expect(result, `expected a result, got ${JSON.stringify(resp)}`).toBeDefined();
    expect(result.protocolVersion).toBe("2025-06-18");
    expect((result.serverInfo as Record<string, unknown>).name).toBe("acorn");
    expect(result.capabilities).toHaveProperty("tools");
  });

  it("notifications/initialized → produces NO response (a notification has no id, per the spec)", () => {
    const out = rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(out).toEqual([]); // no id ⇒ no response frame
  });

  // ── tools/list ───────────────────────────────────────────────────────────────
  it("tools/list → exactly the 12 acorn tools (C1: own MCP, not the inherited template)", () => {
    const resp = one({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (resp.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    expect(tools.length).toBe(12);
  });

  it("tools/list → every tool has a non-empty description + a valid JSON-Schema inputSchema", () => {
    const resp = one({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (resp.result as { tools: Array<Record<string, unknown>> }).tools;
    for (const t of tools) {
      expect(typeof t.description, `${t.name} description`).toBe("string");
      expect((t.description as string).length, `${t.name} description non-empty`).toBeGreaterThan(20);
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type, `${t.name} inputSchema.type`).toBe("object");
      expect(schema, `${t.name} inputSchema.properties`).toHaveProperty("properties");
    }
  });

  // ── tools/call — the deterministic ($0, no-DB) tools round-trip with REAL results ─────────────
  it("tools/call acorn_rls_lint on a no-RLS table → round-trips a P1 violation (isError:false)", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "acorn_rls_lint", arguments: { sql: "create table public.tickets (id uuid primary key, org_id uuid, body text);" } },
    });
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text) as { failed: boolean; violations: Array<{ rule: string }> };
    expect(payload.failed).toBe(true);
    expect(payload.violations.map((v) => v.rule)).toContain("P1"); // CVE-2025-48757
  });

  it("tools/call acorn_migration_safe → round-trips a NOT VALID + VALIDATE + lock_timeout rewrite (G5)", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "acorn_migration_safe", arguments: { sql: "ALTER TABLE public.orders ADD CONSTRAINT c CHECK (amount > 0);" } },
    });
    const result = resp.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text) as { rewritten_sql: string };
    expect(payload.rewritten_sql).toMatch(/NOT VALID/);
    expect(payload.rewritten_sql).toMatch(/VALIDATE CONSTRAINT/);
    expect(payload.rewritten_sql).toMatch(/lock_timeout/);
  });

  it("tools/call acorn_conn_gen → round-trips the mandatory two-string contract (:6543 prepare:false + :5432)", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "acorn_conn_gen", arguments: { provider: "supabase", runtime: "serverless" } },
    });
    const payload = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0].text) as {
      pooled_url_template: string;
      direct_url_template: string;
    };
    expect(payload.pooled_url_template).toMatch(/:6543/);
    expect(payload.direct_url_template).toMatch(/:5432/);
  });

  it("tools/call acorn_brain_search → ranked hits cite a real brain artifact (the Memory component)", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "acorn_brain_search", arguments: { query: "filtered ANN over-filter", limit: 3 } },
    });
    const payload = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0].text) as {
      hits: Array<{ file: string; score: number }>;
    };
    expect(payload.hits.length).toBeGreaterThan(0);
    // SCENARIO #9 lives in BATTLE-TESTED-SCENARIOS.md — the canonical brain-search probe (A5/B2 reconciled).
    expect(payload.hits.some((h) => /BATTLE-TESTED-SCENARIOS/.test(h.file))).toBe(true);
  });

  // ── tools/call — the DB-touching tools return the HONEST precondition, NEVER a fake result ──────
  it("tools/call acorn_provision (no branch DB) → contract + precondition, NOT a fabricated provision", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "acorn_provision", arguments: { provider: "postgres" } },
    });
    const payload = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0].text) as {
      branch_id: string | null;
      applied: boolean;
      verify_report: string;
    };
    // The flagship honesty rule: no DB ⇒ branch_id null + applied false + a stated precondition (no fake provision).
    expect(payload.branch_id).toBeNull();
    expect(payload.applied).toBe(false);
    expect(payload.verify_report).toMatch(/branch\/dev|not-yet-wired|never targets a prod/i);
  });

  it("tools/call acorn_rls_test → un-privileged-role precondition; isolation is null (no DB) or delegated (DB present), NEVER a fake pass", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "acorn_rls_test", arguments: { sql: "select 1", as: "anon" } },
    });
    const payload = JSON.parse((resp.result as { content: Array<{ text: string }> }).content[0].text) as {
      isolated: string | null;
      precondition: string;
    };
    // The flagship invariant is the precondition text (un-privileged role, never the SQL Editor) — present in
    // BOTH modes. `isolated` is DB-mode-dependent: null when no branch DB (not run, not faked), or the explicit
    // string "delegated-to-sandbox" when DATABASE_URL is set (the live leg is E3's harness — still not a fabricated
    // boolean pass). `pnpm test` runs WITHOUT a DB in ci.yml and WITH the supabase/postgres service in
    // acceptance.yml, so the contract must hold either way — neither mode is ever a fake pass.
    const hasDb = Boolean(process.env.DATABASE_URL);
    if (hasDb) {
      expect(payload.isolated).toBe("delegated-to-sandbox");
    } else {
      expect(payload.isolated).toBeNull();
    }
    // Crucially: it is NEVER a fabricated boolean verdict (true/false) — isolation is delegated or not-run.
    expect(typeof payload.isolated === "boolean").toBe(false);
    expect(payload.precondition).toMatch(/un-privileged role|NEVER the SQL Editor|not a fake pass/i);
  });

  // ── tool-level errors are returned as error-content (isError:true), NOT a dropped connection ─────
  it("tools/call with a missing required arg → an isError:true tool result (connection survives)", () => {
    // acorn_rls_lint requires `sql`; omitting it makes the handler throw → returned as isError content.
    const resp = one({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "acorn_rls_lint", arguments: {} },
    });
    const result = resp.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/acorn tool error|must be a string/i);
    // Crucially it is a RESULT, not a protocol error — the agent sees it without the server dying.
    expect(resp.error).toBeUndefined();
  });

  // ── protocol-level error shapes (JSON-RPC 2.0 codes) ───────────────────────────
  it("tools/call for an unknown tool → JSON-RPC error -32601 (method not found)", () => {
    const resp = one({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "acorn_does_not_exist", arguments: {} },
    });
    const err = resp.error as { code: number; message: string };
    expect(err.code).toBe(-32601);
    expect(err.message).toMatch(/unknown tool/i);
  });

  it("an unknown method → JSON-RPC error -32601", () => {
    const resp = one({ jsonrpc: "2.0", id: 12, method: "nonexistent/method" });
    expect((resp.error as { code: number }).code).toBe(-32601);
  });

  it("invalid JSON on the wire → JSON-RPC parse error -32700 (the server never crashes on garbage)", () => {
    const res = spawnSync("node", [SERVER], { input: "this is not json\n", encoding: "utf8" });
    expect(res.status).toBe(0); // garbage in ⇒ error frame out, clean exit (no stack-trace crash)
    const resp = JSON.parse((res.stdout ?? "").trim()) as Record<string, unknown>;
    expect((resp.error as { code: number }).code).toBe(-32700);
    expect(resp.id).toBeNull();
  });

  it("a non-2.0 jsonrpc field → JSON-RPC invalid-request error -32600", () => {
    const resp = one({ jsonrpc: "1.0" as unknown as "2.0", id: 13, method: "tools/list" });
    expect((resp.error as { code: number }).code).toBe(-32600);
  });
});
