#!/usr/bin/env node
/**
 * acorn cockpit — zero-dep Node `http` server (G1, COCKPIT component · PLAN §10 · D3).
 *
 * The chairman's read-mostly view into the database employee. Stack LOCKED by D3/PLAN §10:
 * a localhost stdlib `http` server (the proven sentinel/talent-intel pattern, re-implemented in
 * Node per the acorn file list) + a vanilla-JS SPA + warm-black Energy design. NO web framework,
 * NO npm web deps — `node:http` only.
 *
 *   bash scripts/serve.sh            → http://localhost:7779
 *   ACORN_WEB_PORT=8080 bash scripts/serve.sh
 *
 * It serves cockpit/{index.html,app.js,style.css} (path-traversal guarded) and routes 4 JSON
 * endpoints — one per view — to the SAME deterministic artifacts the CLI/MCP produce (no new
 * logic, no LLM, no DB-by-default):
 *   GET /api/brain          → list the brain/*.md artifacts (Brain browser)
 *   GET /api/brain/file?p=  → render one brain file's raw markdown (guarded to brain/)
 *   GET /api/brain/search?q → BM25 hits via the built CLI `acorn brain search` (Memory component)
 *   GET /api/runs           → the runs.jsonl aggregate + tail (Run log · the DB verdict field)
 *   GET /api/evals          → the golden-task pyramid via `eval/eval.py --list --json` (Eval scores)
 *   POST /api/ask           → run a $0/no-key acorn verb (rls lint | brain search | schema --dry-run)
 *                             against a user brief/SQL and stream back the answer with brain citations
 *
 * Read-mostly, localhost-only, never exposed (no auth by design — it shells out to local tools).
 * Every handler is best-effort + honest: a missing artifact returns a clear JSON error, never a crash,
 * so this file self-tests green standalone while sibling clusters evolve.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COCKPIT = join(REPO, "cockpit");
const BRAIN = join(REPO, "brain");
const PORT = Number(process.env.ACORN_WEB_PORT ?? 7779);
const MAX_BODY = 1 * 1024 * 1024; // 1 MB request-body cap (DoS guard on POST /api/ask)

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---- response helpers --------------------------------------------------------
function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}
function sendErr(res, code, msg) {
  sendJson(res, { error: msg }, code);
}
function sendStatic(res, name) {
  // path-traversal guard: resolve under cockpit/ and confirm the prefix.
  const abs = resolve(COCKPIT, "." + (name.startsWith("/") ? name : "/" + name));
  if (!abs.startsWith(COCKPIT + "/") && abs !== join(COCKPIT, "index.html")) {
    return sendErr(res, 403, "forbidden");
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return sendErr(res, 404, "not found");
  const body = readFileSync(abs);
  const ctype = STATIC_TYPES[extname(abs)] ?? "application/octet-stream";
  // never let a stale cockpit JS/CSS cache hide an edit during dev
  res.writeHead(200, { "Content-Type": ctype, "Content-Length": body.length, "Cache-Control": "no-cache" });
  res.end(body);
}

/** Run the built acorn CLI ($0, no key, no DB unless --apply). Returns {stdout, stderr, code}. */
function runAcorn(args, timeoutMs = 20000) {
  return new Promise((res) => {
    const bin = join(REPO, "dist", "index.js");
    if (!existsSync(bin)) {
      return res({ stdout: "", stderr: "dist/index.js missing — run `pnpm build` (scripts/serve.sh does this).", code: 127 });
    }
    execFile(process.execPath, [bin, ...args], { cwd: REPO, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ?? (err ? 1 : 0) });
    });
  });
}

/** Run a Node script (the aggregator). */
function runNode(scriptRel, args, timeoutMs = 10000) {
  return new Promise((res) => {
    const abs = join(REPO, scriptRel);
    if (!existsSync(abs)) return res({ stdout: "", stderr: `${scriptRel} missing`, code: 127 });
    execFile(process.execPath, [abs, ...args], { cwd: REPO, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ?? (err ? 1 : 0) });
    });
  });
}

/** Run python eval.py. Returns parsed JSON or an honest error. */
function runEvalPy(args, timeoutMs = 15000) {
  return new Promise((res) => {
    const py = join(REPO, "eval", "eval.py");
    if (!existsSync(py)) return res({ stdout: "", stderr: "eval/eval.py missing", code: 127 });
    execFile("python3", [py, ...args], { cwd: REPO, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ?? (err ? 1 : 0) });
    });
  });
}

// ---- API handlers ------------------------------------------------------------

/** Brain browser — list the brain/*.md artifacts (name + size + first H1). */
function apiBrainList(res) {
  if (!existsSync(BRAIN)) return sendErr(res, 404, "brain/ not found");
  const files = readdirSync(BRAIN).filter((f) => f.endsWith(".md")).sort();
  const items = files.map((f) => {
    const abs = join(BRAIN, f);
    let title = f;
    try {
      const head = readFileSync(abs, "utf8").split("\n").slice(0, 30);
      const h1 = head.find((l) => l.startsWith("# "));
      if (h1) title = h1.replace(/^#\s+/, "").trim();
    } catch { /* keep filename */ }
    return { file: f, path: "brain/" + f, title, size: statSync(abs).size };
  });
  sendJson(res, { items });
}

/** Brain file render — return raw markdown (guarded to brain/). */
function apiBrainFile(res, qp) {
  const p = qp.get("p") || qp.get("path") || "";
  // accept "brain/X.md" or "X.md"; never escape brain/.
  const name = basename(p);
  if (!name.endsWith(".md")) return sendErr(res, 400, "expected a .md file under brain/");
  const abs = resolve(BRAIN, name);
  if (!abs.startsWith(BRAIN + "/") || !existsSync(abs)) return sendErr(res, 404, "brain file not found: " + name);
  sendJson(res, { file: name, path: "brain/" + name, markdown: readFileSync(abs, "utf8") });
}

/** Brain search — BM25 over brain/ via the CLI (Memory component). Parses the ranked-hit lines. */
async function apiBrainSearch(res, qp) {
  const q = (qp.get("q") || "").trim();
  if (!q) return sendErr(res, 400, "missing ?q");
  const { stdout, stderr, code } = await runAcorn(["brain", "search", q, "--limit", "8"]);
  if (code !== 0 && !stdout) return sendJson(res, { query: q, hits: [], raw: stderr, error: "brain search failed" });
  // Parse lines like:  [1] brain/BATTLE-TESTED-SCENARIOS.md (score 3.21)
  const hits = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s+(\S+)\s+\(score\s+([\d.]+)\)/);
    if (m) hits.push({ rank: Number(m[1]), path: m[2], score: Number(m[3]) });
  }
  sendJson(res, { query: q, hits, raw: stdout });
}

/** Run log — the aggregate + a tail (the DB verdict is the load-bearing field). */
async function apiRuns(res) {
  const { stdout, code } = await runNode("scripts/runs-aggregate.mjs", ["--json", "--tail", "25"]);
  if (code !== 0 || !stdout.trim()) return sendJson(res, { summary: { total: 0 }, tail: [], note: "no runs yet" });
  try {
    sendJson(res, JSON.parse(stdout));
  } catch {
    sendJson(res, { summary: { total: 0 }, tail: [], note: "could not parse runs aggregate" });
  }
}

/** Eval scores — the golden-task pyramid manifest + the live L1 pass state. */
async function apiEvals(res) {
  // The golden-task manifest (id/title/hamel/ci_blocking/needs_db) is the source of truth on disk —
  // read it directly (eval.py --list prints text, not JSON). Same file eval.py loads.
  let tasks = [];
  const manifest = join(REPO, "eval", "golden", "tasks.json");
  if (existsSync(manifest)) {
    try { tasks = JSON.parse(readFileSync(manifest, "utf8")).tasks ?? []; } catch { /* honest empty on parse error */ }
  }
  // L1-only run = the no-DB structural half; gives a LIVE pass/fail for the house rules.
  // Shape: {level:"L1", results:[{id,desc,status,detail}], passed: bool}.
  const l1 = await runEvalPy(["--l1-only", "--json"]);
  let l1Result = null;
  if (l1.stdout.trim()) {
    try {
      const parsed = JSON.parse(l1.stdout);
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const passed = results.filter((r) => r.status === "pass").length;
      l1Result = { passed, total: results.length, allPass: parsed.passed === true, exit: l1.code, results };
    } catch { l1Result = { raw: l1.stdout.slice(0, 2000), exit: l1.code }; }
  } else if (l1.stderr.trim()) {
    l1Result = { raw: l1.stderr.slice(0, 2000), exit: l1.code };
  }
  sendJson(res, { tasks, l1: l1Result });
}

/** Ask the employee — run a $0/no-key acorn verb against a user brief/SQL. */
async function apiAsk(res, body) {
  let payload;
  try { payload = JSON.parse(body || "{}"); } catch { return sendErr(res, 400, "invalid JSON body"); }
  const mode = String(payload.mode || "brain");
  const input = String(payload.input || "").slice(0, 8000);
  if (!input.trim()) return sendErr(res, 400, "empty input");

  // Only the $0/no-key/no-DB paths are exposed (PLAN §10): brain search, rls lint, schema --dry-run.
  if (mode === "brain") {
    const r = await runAcorn(["brain", "search", input, "--limit", "6"]);
    return sendJson(res, { mode, ok: r.code === 0, output: r.stdout || r.stderr });
  }
  if (mode === "rls-lint") {
    // write the SQL to a temp file the CLI can read, lint it, return the JSON verdict.
    const tmp = join(REPO, "eval", `_tmp_ask_${Date.now()}.sql`);
    try {
      const { writeFileSync, unlinkSync } = await import("node:fs");
      writeFileSync(tmp, input, "utf8");
      const r = await runAcorn(["rls", "lint", tmp, "--json"]);
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* keep raw */ }
      return sendJson(res, { mode, ok: true, verdict: parsed, output: r.stdout || r.stderr });
    } catch (e) {
      return sendErr(res, 500, "rls lint failed: " + (e?.message ?? e));
    }
  }
  if (mode === "schema") {
    // --dry-run = NO database, NO key: derive tenancy + tables + migrations, self-check, never apply.
    const r = await runAcorn(["schema", input, "--provider", "postgres", "--dry-run"], 30000);
    return sendJson(res, { mode, ok: r.code === 0, output: r.stdout || r.stderr });
  }
  return sendErr(res, 400, "unknown mode (use brain | rls-lint | schema)");
}

// ---- router ------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const qp = url.searchParams;

  try {
    if (req.method === "GET") {
      if (path === "/" || path === "/index.html") return sendStatic(res, "/index.html");
      if (path === "/app.js" || path === "/style.css") return sendStatic(res, path);
      if (path === "/healthz") return sendJson(res, { ok: true, port: PORT });
      if (path === "/api/brain") return apiBrainList(res);
      if (path === "/api/brain/file") return apiBrainFile(res, qp);
      if (path === "/api/brain/search") return void apiBrainSearch(res, qp);
      if (path === "/api/runs") return void apiRuns(res);
      if (path === "/api/evals") return void apiEvals(res);
      return sendErr(res, 404, "not found: " + path);
    }
    if (req.method === "POST" && path === "/api/ask") {
      let body = "";
      let tooBig = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on("end", () => {
        if (tooBig) return sendErr(res, 413, "body too large");
        void apiAsk(res, body);
      });
      return;
    }
    return sendErr(res, 405, "method not allowed");
  } catch (e) {
    return sendErr(res, 500, "internal error: " + (e?.message ?? String(e)));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`acorn cockpit → http://localhost:${PORT}  (Ctrl-C to stop)\n`);
});
