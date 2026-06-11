#!/usr/bin/env node
// src/mcp/server.ts — acorn's OWN MCP server over stdio (C1, HARNESS-OVERRIDES §7).
//
// A zero-dependency JSON-RPC 2.0 server speaking the MCP wire protocol over stdin/stdout. It exposes the
// 12 acorn tools (src/mcp/tools.ts) so a sibling agent (turbo, the energy hub) can `tools/call acorn_*`.
//
// WHY hand-rolled, not @modelcontextprotocol/sdk: acorn's whole house style is dependency-free deterministic
// modules (brain/search.ts, lint/sql-util.ts) — the lints must have NO LLM and a minimal dependency surface.
// The MCP stdio transport is line-delimited JSON-RPC; implementing `initialize` + `tools/list` + `tools/call`
// directly is ~120 lines and keeps the install lean (the SDK pulls a large tree). The verify line is
// `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp/server.js` → the 12 tools; a plain
// stdio loop satisfies it exactly, and a real MCP client (Claude Code) speaks the same JSON-RPC framing.
// (Karpathy: minimum code that solves the problem; no speculative SDK abstraction.)
//
// Constitutional rule (baked into tools.ts): the inspect-style tools that would touch a real DB default to a
// read-only-at-role, branch/dev-only connection and treat returned rows as untrusted — the live legs are E3.

import { createInterface } from "node:readline";
import { TOOLS, TOOL_BY_NAME } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18"; // the MCP spec version acorn's tools target.
const SERVER_INFO = { name: "acorn", version: "0.1.0" } as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC error codes (subset we use). */
const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

function writeResult(id: number | string | null | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) + "\n");
}
function writeError(id: number | string | null | undefined, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) + "\n");
}

/** Handle one parsed JSON-RPC request. Notifications (no id) get no response per the spec. */
function handle(req: JsonRpcRequest): void {
  const isNotification = req.id === undefined;

  switch (req.method) {
    case "initialize": {
      writeResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    case "notifications/initialized":
    case "initialized":
      // client handshake ack — no response.
      return;

    case "ping":
      if (!isNotification) writeResult(req.id, {});
      return;

    case "tools/list": {
      writeResult(req.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    }

    case "tools/call": {
      const params = req.params ?? {};
      const name = params.name;
      if (typeof name !== "string") {
        writeError(req.id, ERR.INVALID_PARAMS, "tools/call requires a string 'name'");
        return;
      }
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        writeError(req.id, ERR.METHOD_NOT_FOUND, `unknown tool: ${name}`);
        return;
      }
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const result = tool.handler(args);
        // MCP tool results are content blocks; we return the structured JSON as a text block (the agent
        // parses it) — deterministic, no streaming. `isError:false` signals a successful tool call.
        writeResult(req.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        });
      } catch (e) {
        // A handler error (bad args, missing precondition) is a tool-level error, not a protocol error —
        // return it as an error-content result so the agent sees it without the connection dropping.
        const message = e instanceof Error ? e.message : String(e);
        writeResult(req.id, { content: [{ type: "text", text: `acorn tool error: ${message}` }], isError: true });
      }
      return;
    }

    default:
      if (!isNotification) writeError(req.id, ERR.METHOD_NOT_FOUND, `method not found: ${req.method}`);
      return;
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeError(null, ERR.PARSE, "parse error: invalid JSON");
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      writeError(req.id ?? null, ERR.INVALID_REQUEST, "invalid JSON-RPC 2.0 request");
      return;
    }
    handle(req);
  });
  rl.on("close", () => process.exit(0));
}

main();
