#!/usr/bin/env node
/**
 * acorn cockpit — Playwright smoke (G1 verify · QA gate · PLAN §10).
 *
 * Drives the running cockpit (assumes `bash scripts/serve.sh` is up on ACORN_WEB_PORT/7779),
 * asserts each of the 4 views renders REAL data (not lorem), and captures a full-page screenshot
 * per view to content/screenshots/cp123-acorn-cockpit/ for the Wave-V evidence flow.
 *
 * Playwright MCP is BANNED (CLAUDE.md Tool Preferences) — this uses the Playwright Node API via the
 * globally-installed module, driven from Bash. Chromium must be installed (`playwright install chromium`).
 *
 *   node cockpit/smoke.mjs            # exit 0 if all 4 views pass + screenshots written
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import the global playwright (the repo has no local playwright dep — cockpit is the only QA surface).
const require = createRequire("/usr/local/lib/node_modules/");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("FATAL: playwright not found. Install: npm i -g playwright && playwright install chromium");
  process.exit(2);
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ACORN_WEB_PORT ?? 7779);
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(REPO, "content", "screenshots", "cp123-acorn-cockpit");
mkdirSync(SHOTS, { recursive: true });

const checks = []; // {name, ok, detail}
function check(name, ok, detail = "") { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); }

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // ---- boot ----
  const resp = await page.goto(BASE, { waitUntil: "networkidle" });
  check("HTTP 200 on /", resp && resp.status() === 200, "status " + (resp && resp.status()));
  check("masthead wordmark = acorn", (await page.textContent(".wordmark"))?.includes("acorn"));

  // ---- 1 · Brain (default view) ----
  await page.waitForSelector("#brain-list .brain-li", { timeout: 8000 });
  const brainCount = await page.locator("#brain-list .brain-li").count();
  check("Brain: ≥6 artifacts listed (real)", brainCount >= 6, brainCount + " artifacts");
  // a real artifact rendered into the doc pane (markdown, not lorem)
  await page.waitForSelector("#brain-doc h1, #brain-doc h2, #brain-doc p", { timeout: 8000 });
  const brainDoc = (await page.textContent("#brain-doc")) || "";
  check("Brain: artifact body rendered", brainDoc.length > 200, brainDoc.length + " chars");
  // live search round-trip
  await page.fill("#brain-q", "filtered ANN over-filter");
  await page.click("#brain-go");
  await page.waitForSelector("#brain-hits .brain-li", { timeout: 8000 });
  const hit0 = (await page.textContent("#brain-hits .brain-li")) || "";
  check("Brain: search surfaces SCENARIOS #9 source", /BATTLE-TESTED-SCENARIOS/.test(hit0), hit0.slice(0, 60));
  await page.screenshot({ path: join(SHOTS, "1-brain.png"), fullPage: true });

  // ---- 2 · Run log ----
  await page.click('.rail-item[data-id="runs"]');
  await page.waitForSelector(".table tbody tr", { timeout: 8000 });
  const runRows = await page.locator(".table tbody tr").count();
  const runText = (await page.textContent(".stage")) || "";
  check("Runs: real records in the table", runRows >= 1 && /run\(s\)/.test(runText), runRows + " rows");
  check("Runs: DB verdict column present (safe/rewritten)", /safe|rewritten|blocked/.test(runText));
  await page.screenshot({ path: join(SHOTS, "2-runs.png"), fullPage: true });

  // ---- 3 · Evals ----
  await page.click('.rail-item[data-id="evals"]');
  await page.waitForSelector(".eval-cell", { timeout: 8000 });
  const evalCells = await page.locator(".eval-cell").count();
  const evalText = (await page.textContent(".stage")) || "";
  check("Evals: ≥10 golden tasks rendered", evalCells >= 10, evalCells + " tasks");
  check("Evals: G1 acceptance + L1 live state shown", /G1/.test(evalText) && /L1/.test(evalText));
  await page.screenshot({ path: join(SHOTS, "3-evals.png"), fullPage: true });

  // ---- 4 · Ask the employee ----
  await page.click('.rail-item[data-id="ask"]');
  await page.waitForSelector("#ask-run", { timeout: 8000 });
  // RLS-lint mode against a no-RLS table → must flag P1 (the flagship lint, $0/no-DB)
  await page.click('#ask-mode button[data-m="rls-lint"]');
  await page.fill("#ask-in", "create table public.tickets (id uuid primary key, org_id uuid, body text);");
  await page.click("#ask-run");
  await page.waitForFunction(() => { const o = document.querySelector("#ask-out"); return o && /P1|RLS/.test(o.textContent); }, { timeout: 15000 });
  const askOut = (await page.textContent("#ask-out")) || "";
  check("Ask: rls-lint flags P1 (real CLI round-trip)", /P1/.test(askOut), askOut.slice(0, 80).replace(/\n/g, " "));
  await page.screenshot({ path: join(SHOTS, "4-ask.png"), fullPage: true });

  // ---- console hygiene (non-fatal but reported) ----
  check("No console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nscreenshots → ${SHOTS}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke crashed:", e.message); process.exit(1); });
