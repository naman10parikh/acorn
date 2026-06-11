// src/lint/sql-util.ts — tiny, dependency-free SQL-text helpers shared by the lints.
//
// acorn's lints are deterministic regex/text analysis over `.sql`, NOT a full SQL parser (Karpathy
// Simplicity First — the 5 outage-makers and the 9 RLS pitfalls are all detectable from statement text;
// a full AST is speculative gold-plating for this job). These helpers strip comments + strings so a
// keyword inside a comment or a string literal never trips a rule, and split a script into statements
// while tracking the source line each statement starts on.

/** A single SQL statement plus the 1-based line it began on in the original source. */
export interface Statement {
  /** statement text with line-comments, block-comments, and string/identifier literals neutralized */
  readonly sql: string;
  /** the original (un-stripped) statement text, for echoing back in messages */
  readonly raw: string;
  /** 1-based line number where this statement starts */
  readonly line: number;
}

/**
 * Replace the *contents* of `'...'` strings, `$tag$...$tag$` dollar-quoted bodies, `"..."` quoted
 * identifiers, line comments (`-- ...`) and block comments (slash-star ... star-slash) with spaces of
 * equal length. Length-preserving so downstream line/offset math stays valid. Keeps the delimiters'
 * surrounding structure intact enough for statement splitting.
 */
export function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // line comment -- ... (to end of line)
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    // block comment /* ... */
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    // single-quoted string '...'  (handles '' escape)
    if (c === "'") {
      out += "'";
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "'";
        i++;
      }
      continue;
    }
    // dollar-quoted $tag$ ... $tag$
    if (c === "$") {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        out += " ".repeat(tag.length);
        i += tag.length;
        const end = sql.indexOf(tag, i);
        const stop = end === -1 ? n : end;
        while (i < stop) {
          out += sql[i] === "\n" ? "\n" : " ";
          i++;
        }
        if (end !== -1) {
          out += " ".repeat(tag.length);
          i += tag.length;
        }
        continue;
      }
    }
    // double-quoted identifier "..."
    if (c === '"') {
      out += '"';
      i++;
      while (i < n && sql[i] !== '"') {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += '"';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split a SQL script into top-level statements, recording each statement's starting line. */
export function splitStatements(sql: string): Statement[] {
  const stripped = stripNoise(sql);
  const statements: Statement[] = [];
  let start = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === ";") {
      pushStatement(sql, stripped, start, i + 1, statements);
      start = i + 1;
    }
  }
  // trailing statement with no terminating semicolon
  if (start < stripped.length && stripped.slice(start).trim().length > 0) {
    pushStatement(sql, stripped, start, stripped.length, statements);
  }
  return statements;
}

function pushStatement(
  original: string,
  stripped: string,
  from: number,
  to: number,
  out: Statement[],
): void {
  const rawSlice = original.slice(from, to);
  const strippedSlice = stripped.slice(from, to);
  if (strippedSlice.trim().length === 0) return;
  // leading-whitespace offset → the line the *content* starts on
  const lead = strippedSlice.length - strippedSlice.replace(/^\s+/, "").length;
  const line = lineAt(original, from + lead);
  out.push({ sql: strippedSlice.trim(), raw: rawSlice.trim(), line });
}

/** 1-based line number of byte offset `off` in `text`. */
export function lineAt(text: string, off: number): number {
  let line = 1;
  const stop = Math.min(off, text.length);
  for (let i = 0; i < stop; i++) if (text[i] === "\n") line++;
  return line;
}

/** Case-insensitive "does this statement contain all of these word-boundary tokens, in order?" */
export function hasSeq(sql: string, ...tokens: string[]): boolean {
  let idx = 0;
  const lower = sql.toLowerCase();
  for (const t of tokens) {
    const re = new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    re.lastIndex = idx;
    const m = re.exec(lower);
    if (!m) return false;
    idx = m.index + m[0].length;
  }
  return true;
}

/** Pull the table name out of a `CREATE TABLE [IF NOT EXISTS] [schema.]name` / `ALTER TABLE ...`. */
export function tableNameFrom(sql: string): string {
  const m =
    /\b(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?([a-zA-Z0-9_."]+)/i.exec(sql);
  if (!m) return "";
  return m[1].replace(/"/g, "").replace(/^public\./i, "");
}
