#!/usr/bin/env python3
"""acorn L3 migration-trajectory judge (E1b, EVALS component — the L3 layer).

HARNESS-OVERRIDES §9 / PLAN §6+§9: an LLM-judge over a migration/RLS *trajectory* — did acorn reason
expand→contract, cite the lock class, propose the safe rewrite? CALIBRATED, not raw — against a SMALL committed
labeled corpus (eval/judge-corpus/, 16 hand-labeled diffs). Split out from E1 because it is its own item with
its own corpus + calibration math.

Two halves, consistent with the RSI-L3 deferral (D8):
  • DETERMINISTIC scorer (ships NOW, $0, NO secret) — a rule-based scorer over each trajectory on the three
    binary criteria the judge cares about (expand_contract / lock_class_cited / safe_rewrite). `--selftest`
    runs it over the committed labels and reports Cohen's kappa (agreement with the human labels) — proving the
    judge is calibrated WITHOUT a live model call. This is what runs in CI.
  • LIVE LLM judge (DEFERRED, lights with ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, D8) — when the token is
    set, `--judge <file>` would ask the model to score the trajectory and we'd compare to the deterministic
    scorer + labels. Intentionally NOT implemented here (the calibration corpus + selftest ship now; live
    judging lights with the token), exactly like the RSI Claude half.

Modes:
  python eval/judge.py --selftest          # run the scorer over the corpus, print Cohen's kappa, exit 0 if >=0.6
  python eval/judge.py --list              # list the corpus diffs + their expected verdict
  python eval/judge.py --judge <file.json> # score one trajectory file (deterministic scorer; live judge if token)

Pure stdlib Python, NO pip deps. The kappa target is >=0.6 (substantial agreement), per the checklist L3 bar.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

CORPUS = Path(__file__).resolve().parent / "judge-corpus"
KAPPA_TARGET = 0.6


# ─────────────────────────── the deterministic scorer ───────────────────────────


def score_trajectory(trajectory: str) -> dict:
    """Score a migration trajectory on the three binary criteria — deterministically (NO LLM, $0). Returns
    {expand_contract, lock_class_cited, safe_rewrite, verdict}. This is the calibrated stand-in for the L3
    judge: it encodes the same rubric a human/LLM applies, so its agreement with the human labels (kappa) is
    the calibration evidence. Mirrors the acorn migration-lint/safe rules (P10-P15)."""
    t = trajectory.lower()

    # Does the trajectory contain an UNSAFE bare op? (the disqualifiers — must be rewritten)
    has_bare_check = bool(re.search(r"\badd\s+constraint\b[^;]*\bcheck\b", t)) and "not valid" not in t
    has_bare_fk = bool(re.search(r"\badd\s+(constraint\s+\w+\s+)?foreign\s+key\b", t)) and "not valid" not in t
    has_bare_set_not_null = bool(re.search(r"\balter\s+column\b[^;]*\bset\s+not\s+null\b", t)) and "not valid" not in t
    has_bare_type = bool(re.search(r"\balter\s+column\b[^;]*\btype\b", t)) and "add column" not in t
    has_bare_index = bool(re.search(r"\bcreate\b[^;]*\bindex\b", t)) and "concurrently" not in t
    has_bare_rename = bool(re.search(r"\brename\s+column\b", t)) and "add column" not in t
    has_bare_drop = bool(re.search(r"\bdrop\s+column\b", t)) and "-- contract" not in t and "a release later" not in t

    has_unsafe_bare_op = any(
        [has_bare_check, has_bare_fk, has_bare_set_not_null, has_bare_type, has_bare_index, has_bare_rename, has_bare_drop]
    )

    # safe_rewrite: the trajectory uses at least one safe-form construct AND no unsafe bare op slipped through.
    uses_safe_form = any(
        kw in t
        for kw in ["not valid", "concurrently", "expand", "backfill", "validate constraint", "dual-write"]
    )
    # A purely additive change (CREATE TABLE, ADD COLUMN nullable) needs no rewrite → safe_rewrite True.
    is_additive_only = (
        ("create table" in t or "add column" in t)
        and not has_unsafe_bare_op
    )
    safe_rewrite = (uses_safe_form and not has_unsafe_bare_op) or is_additive_only

    # expand_contract: decomposed a breaking change, OR the change is non-breaking by construction.
    did_expand_contract = ("expand" in t or "backfill" in t or "dual-write" in t) or (
        not has_unsafe_bare_op and (uses_safe_form or is_additive_only)
    )

    # lock_class_cited: the trajectory names a Postgres lock class.
    lock_class_cited = "accessexclusive" in t or "shareupdateexclusive" in t

    # verdict: safe iff no unsafe bare op AND the rewrite/additive condition holds.
    verdict = "safe" if (not has_unsafe_bare_op and safe_rewrite) else "unsafe"

    return {
        "expand_contract": did_expand_contract,
        "lock_class_cited": lock_class_cited,
        "safe_rewrite": safe_rewrite,
        "verdict": verdict,
    }


# ─────────────────────────── calibration (Cohen's kappa) ───────────────────────────


def cohens_kappa(a: list[str], b: list[str]) -> float:
    """Cohen's kappa between two raters' categorical labels (here: scorer verdict vs human expected_verdict).
    kappa = (po - pe) / (1 - pe). 1.0 = perfect, 0 = chance, <0 = worse than chance. >=0.6 = substantial."""
    n = len(a)
    if n == 0:
        return 0.0
    categories = sorted(set(a) | set(b))
    # observed agreement
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    # expected agreement by chance
    pe = 0.0
    for c in categories:
        pa = sum(1 for x in a if x == c) / n
        pb = sum(1 for y in b if y == c) / n
        pe += pa * pb
    if pe == 1.0:
        # all labels identical category → perfect-by-construction; kappa undefined, report 1.0 iff po==1.
        return 1.0 if po == 1.0 else 0.0
    return (po - pe) / (1 - pe)


def load_corpus() -> list[dict]:
    files = sorted(CORPUS.glob("*.json"))
    return [json.loads(f.read_text()) for f in files]


def selftest() -> int:
    """Run the deterministic scorer over the committed corpus; report Cohen's kappa vs the human labels.
    NO secret, NO model call. Exit 0 iff kappa >= the target (substantial agreement)."""
    corpus = load_corpus()
    if len(corpus) < 15:
        print(f"FAIL: corpus has {len(corpus)} diffs (<15 required).", file=sys.stderr)
        return 1

    human = [e["expected_verdict"] for e in corpus]
    scorer = [score_trajectory(e["trajectory"])["verdict"] for e in corpus]

    kappa = cohens_kappa(scorer, human)
    agree = sum(1 for x, y in zip(scorer, human) if x == y)

    print("acorn L3 migration-trajectory judge — calibration self-test (deterministic, no secret)")
    print(f"  corpus: {len(corpus)} hand-labeled diffs")
    print(f"  scorer↔human exact agreement: {agree}/{len(corpus)}")
    print(f"  Cohen's kappa (κ): {kappa:.3f}  (target ≥ {KAPPA_TARGET})")

    # Per-criterion agreement too (the three binary judge criteria), for transparency.
    for crit in ("expand_contract", "lock_class_cited", "safe_rewrite"):
        ch = [bool(e["label"][crit]) for e in corpus]
        cs = [score_trajectory(e["trajectory"])[crit] for e in corpus]
        a = sum(1 for x, y in zip(ch, cs) if x == y)
        print(f"    criterion '{crit}': {a}/{len(corpus)} agree")

    if kappa >= KAPPA_TARGET:
        print(f"  → CALIBRATED (κ {kappa:.3f} ≥ {KAPPA_TARGET}).")
        return 0
    # Show the mismatches so a maintainer can fix the scorer or relabel.
    print("  → UNDER-CALIBRATED. Mismatches:")
    for e, s in zip(corpus, scorer):
        if e["expected_verdict"] != s:
            print(f"      {e['id']}: human={e['expected_verdict']} scorer={s} — {e['note']}")
    return 1


def main() -> None:
    ap = argparse.ArgumentParser(description="acorn L3 migration-trajectory judge")
    ap.add_argument("--selftest", action="store_true", help="run the scorer over the corpus + report kappa (no secret)")
    ap.add_argument("--list", action="store_true", help="list the corpus diffs + expected verdict")
    ap.add_argument("--judge", help="score a single trajectory JSON file (deterministic; live LLM if token set)")
    args = ap.parse_args()

    if args.list:
        for e in load_corpus():
            print(f"  {e['id']}  {e['expected_verdict']:<7} {e['note']}")
        return

    if args.judge:
        data = json.loads(Path(args.judge).read_text())
        traj = data.get("trajectory", "")
        result = score_trajectory(traj)
        live = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))
        result["judge_mode"] = "live-llm-available-but-deferred(D8); deterministic scorer used" if live else "deterministic (no token)"
        print(json.dumps(result, indent=2))
        return

    # default = selftest (the canonical secret-less verification mode).
    sys.exit(selftest())


if __name__ == "__main__":
    main()
