// src/brain/search.ts — BM25-style search over acorn's expertise brain (brain/*.md).
//
// This is the backing for the Memory component (PLAN §3 · HARNESS-OVERRIDES §2): the queryable layer
// indexes the EXPERTISE BRAIN, not code history. The `acorn brain search "<q>"` CLI verb (B2) and the
// `acorn_brain_search` MCP tool (C1) both call `searchBrain` here.
//
// Reuses the proven scoring philosophy of the inherited scripts/memory-search.sh
// (term-frequency × source-weight, BM25-style saturation) but points the corpus at brain/ and is a
// dependency-free TypeScript module so the CLI/MCP can import it directly.
//
// Canonical probe (A5/B2/gate-table): searchBrain("filtered ANN over-filter") surfaces
// brain/BATTLE-TESTED-SCENARIOS.md (Scenario #9 — the filtered-ANN over-filter incident, golden task G10).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the brain corpus dir without assuming the caller's cwd is the repo root.
 *
 * acorn is employee-first (PLAN §3): the callers are coding agents / sibling employees / the energy hub,
 * NOT a shell sitting in acorn's repo root. Resolving `brain/` against `process.cwd()` made `acorn brain
 * search` silently return zero hits whenever invoked from any other directory (or as a global binary).
 * This walks up from the compiled module (dist/brain/search.js → dist/ → <package root>) to find the
 * shipped `brain/` dir, and only falls back to cwd if that isn't present. First existing candidate wins.
 */
function defaultBrainDir(): string {
  const candidates: string[] = [];
  try {
    // <pkg>/dist/brain/search.js → up to <pkg>, where brain/ lives alongside dist/.
    const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/brain
    candidates.push(join(here, "..", "..", "brain")); // <pkg>/brain
    candidates.push(join(here, "..", "brain")); // <pkg>/dist/brain (defensive)
  } catch {
    // import.meta.url unavailable (e.g. an exotic bundler) — fall through to cwd.
  }
  candidates.push(join(process.cwd(), "brain")); // dev-from-source / running at repo root
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // not this candidate; try the next
    }
  }
  // Nothing found — return the module-relative path so the corpus loader reports "no hits" honestly
  // (and a future fix has the most-likely-correct path to inspect), rather than the cwd guess.
  return candidates[0] ?? join(process.cwd(), "brain");
}

export interface BrainHit {
  /** repo-relative path, e.g. "brain/BATTLE-TESTED-SCENARIOS.md" */
  readonly file: string;
  /** combined BM25 × source-weight score (higher = better) */
  readonly score: number;
  /** the best-matching line + a little surrounding context */
  readonly excerpt: string;
}

export interface SearchOptions {
  /** absolute path to the brain corpus dir (defaults to <repo>/brain) */
  readonly brainDir?: string;
  /** max hits to return (default 5) */
  readonly limit?: number;
}

// BM25 free parameters (Robertson/Sparck-Jones defaults).
const K1 = 1.5; // term-frequency saturation
const B = 0.75; // length normalization

// Source weights — the load-bearing brain artifacts rank above the org/MOC scaffolding,
// mirroring scripts/memory-search.sh's weight_for_source map.
function sourceWeight(file: string): number {
  const name = basename(file);
  if (name === "OPINIONS.md") return 5; // the anti-slop taste layer — highest
  if (name === "KNOWN-PITFALLS.md") return 5; // the gotcha catalog
  if (name === "BATTLE-TESTED-SCENARIOS.md") return 5; // the golden-task incidents
  if (name === "EXPERTISE-MAP.md") return 4; // the JTBD spine / index
  if (name === "TOOL-MATRIX.md") return 4; // the wired-vs-documented tools
  if (name === "GAPS-AND-DISPUTES.md") return 4; // the open disputes
  if (name === "MOC - acorn.md") return 2; // navigation
  return 1; // ORG_CONTEXT / ORG_MEMORY / anything else
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

interface Doc {
  readonly file: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly tokens: readonly string[];
}

function loadCorpus(brainDir: string): Doc[] {
  const docs: Doc[] = [];
  let entries: string[];
  try {
    entries = readdirSync(brainDir);
  } catch {
    return docs; // no brain dir → empty corpus (caller gets no hits, not a crash)
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(brainDir, entry);
    try {
      if (!statSync(abs).isFile()) continue;
      const text = readFileSync(abs, "utf8");
      docs.push({
        file: `brain/${entry}`,
        text,
        lines: text.split("\n"),
        tokens: tokenize(text),
      });
    } catch {
      // skip unreadable file; never let one bad file kill the search
    }
  }
  return docs;
}

/** Term frequency of `term` in a token list. */
function termFreq(tokens: readonly string[], term: string): number {
  let n = 0;
  for (const t of tokens) if (t === term) n++;
  return n;
}

/** Pull the line with the most query-term hits + 1 line of context on each side. */
function bestExcerpt(doc: Doc, queryTerms: readonly string[]): string {
  let bestLine = -1;
  let bestHits = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    const lineTokens = new Set(tokenize(doc.lines[i]));
    let hits = 0;
    for (const term of queryTerms) if (lineTokens.has(term)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      bestLine = i;
    }
  }
  if (bestLine < 0) return doc.lines.slice(0, 2).join(" ").trim().slice(0, 240);
  const start = Math.max(0, bestLine - 1);
  const end = Math.min(doc.lines.length, bestLine + 2);
  return doc.lines.slice(start, end).join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

/**
 * Search brain/*.md for `query`, returning ranked hits.
 * BM25 over the multi-document corpus, multiplied by the per-file source weight.
 */
export function searchBrain(query: string, opts: SearchOptions = {}): BrainHit[] {
  const brainDir = opts.brainDir ?? defaultBrainDir();
  const limit = opts.limit ?? 5;
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const docs = loadCorpus(brainDir);
  if (docs.length === 0) return [];

  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;

  // document frequency per term (for IDF)
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let d = 0;
    for (const doc of docs) if (termFreq(doc.tokens, term) > 0) d++;
    df.set(term, d);
  }

  const hits: BrainHit[] = [];
  for (const doc of docs) {
    let bm25 = 0;
    for (const term of queryTerms) {
      const f = termFreq(doc.tokens, term);
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      // BM25 IDF with the +0.5 smoothing; clamp ≥0 so a term in every doc can't go negative.
      const idf = Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1));
      const denom = f + K1 * (1 - B + (B * doc.tokens.length) / avgLen);
      bm25 += idf * ((f * (K1 + 1)) / denom);
    }
    if (bm25 <= 0) continue;
    const score = bm25 * sourceWeight(doc.file);
    hits.push({ file: doc.file, score: Number(score.toFixed(4)), excerpt: bestExcerpt(doc, queryTerms) });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// Allow a direct `node dist/brain/search.js "<query>"` smoke run (the CLI verb in B2 is the real entry).
// Using import.meta so this only fires when the file is executed, not when imported.
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error('usage: brain search "<query>"');
    process.exit(1);
  }
  const results = searchBrain(query);
  if (results.length === 0) {
    console.log(`No brain hits for: ${query}`);
    process.exit(0);
  }
  console.log(`=== brain search: "${query}" ===\n`);
  results.forEach((h, i) => {
    console.log(`[${i + 1}] ${h.file} (score ${h.score})`);
    console.log(`    ${h.excerpt}\n`);
  });
}
