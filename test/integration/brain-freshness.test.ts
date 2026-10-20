// The loop's brain-freshness check dates each brain file by its last commit, not by the file's modified time: a
// fresh CI checkout stamps every file with "now", so a modified-time check could never find a stale file there.
import { describe, it, expect } from "vitest";
import { statSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error the loop is a plain .js script with no type declarations
import { brainFreshness } from "../../workflows/rsi.workflow.js";

const OPINIONS = fileURLToPath(new URL("../../brain/OPINIONS.md", import.meta.url));

describe("the loop's brain freshness", () => {
  it("dates a brain file by its last commit, so an old modified time does not make it stale", () => {
    const { atime, mtime } = statSync(OPINIONS);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(OPINIONS, old, old);
    try {
      expect(brainFreshness().stale).not.toContain("OPINIONS.md");
    } finally {
      utimesSync(OPINIONS, atime, mtime);
    }
  });
});
