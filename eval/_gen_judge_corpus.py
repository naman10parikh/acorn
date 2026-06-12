#!/usr/bin/env python3
"""Generate the L3 judge's labeled corpus (E1b). Idempotent: re-running rewrites the same 16 files.

Each corpus entry is a migration-review TRAJECTORY (the SQL acorn produced/reviewed) + a HUMAN label on the
three binary criteria the L3 judge scores (PLAN §6/§9 "did acorn reason expand→contract, cite the lock class,
propose the safe rewrite"). `expected_verdict` = the overall human call (safe | unsafe). The judge's
deterministic scorer (judge.py) is calibrated against these labels via Cohen's kappa in --selftest — so the
item is verifiable with NO secret/model call. 16 diffs (>=15 required), a mix of safe + unsafe trajectories.

Run: python3 eval/_gen_judge_corpus.py  → writes eval/judge-corpus/diff-NN.json (idempotent).
"""

import json
from pathlib import Path

CORPUS = Path(__file__).resolve().parent / "judge-corpus"

# Each entry: id, the migration trajectory text, and the human label.
# label fields (the three binary criteria the judge scores):
#   expand_contract  — did the trajectory decompose a breaking change into expand→migrate→contract (or was it
#                      not a breaking change, so N/A → True)?
#   lock_class_cited — did it name the Postgres lock class it takes (AccessExclusive / ShareUpdateExclusive)?
#   safe_rewrite     — did it propose the safe form (NOT VALID+VALIDATE / CONCURRENTLY / lock_timeout / scaffold)?
# expected_verdict = "safe" iff a human would ship this trajectory (all the relevant criteria met).

ENTRIES = [
    # ---- SAFE trajectories (acorn did the right thing) ----
    {
        "id": "diff-01",
        "trajectory": "SET lock_timeout = '3s';\nALTER TABLE users ADD CONSTRAINT users_phone_check CHECK (phone IS NOT NULL) NOT VALID;\nALTER TABLE users VALIDATE CONSTRAINT users_phone_check;  -- weaker ShareUpdateExclusive, reads/writes continue",
        "label": {"expand_contract": True, "lock_class_cited": True, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "the canonical 84M-row CHECK done right (SCENARIO #4) — NOT VALID+VALIDATE + lock_timeout + the lock class named.",
    },
    {
        "id": "diff-02",
        "trajectory": "SET lock_timeout = '3s';\nCREATE INDEX CONCURRENTLY tickets_org_idx ON public.tickets (org_id);  -- ShareUpdateExclusive, writes continue; cannot run in a txn",
        "label": {"expand_contract": True, "lock_class_cited": True, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "CONCURRENTLY index with the lock class noted (P12).",
    },
    {
        "id": "diff-03",
        "trajectory": "-- expand: add the new column nullable\nALTER TABLE users ADD COLUMN display_name text;\n-- backfill in batches, dual-write from the app, switch reads\nUPDATE users SET display_name = full_name WHERE display_name IS NULL;\n-- contract (a release LATER): ALTER TABLE users DROP COLUMN full_name;",
        "label": {"expand_contract": True, "lock_class_cited": False, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "a rename done as expand→backfill→contract, no DROP+ADD data loss (SCENARIO #5). Lock class not named but the change is non-breaking by construction.",
    },
    {
        "id": "diff-04",
        "trajectory": "SET lock_timeout = '3s';\nALTER TABLE orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;\nALTER TABLE orders VALIDATE CONSTRAINT orders_user_fk;",
        "label": {"expand_contract": True, "lock_class_cited": False, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "FK added NOT VALID then validated (P10).",
    },
    {
        "id": "diff-05",
        "trajectory": "SET lock_timeout = '3s';\nALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;\nALTER TABLE users VALIDATE CONSTRAINT users_email_nn;\nALTER TABLE users ALTER COLUMN email SET NOT NULL;  -- PG12+ uses the validated CHECK, skips the AccessExclusive scan",
        "label": {"expand_contract": True, "lock_class_cited": True, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "SET NOT NULL via the CHECK-NOT-VALID trick, lock class named.",
    },
    {
        "id": "diff-06",
        "trajectory": "CREATE TABLE public.notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, body text);\nALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;",
        "label": {"expand_contract": True, "lock_class_cited": False, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "a plain additive CREATE TABLE + RLS enabled — non-breaking, no rewrite needed (N/A criteria → safe).",
    },
    {
        "id": "diff-07",
        "trajectory": "-- acorn (P11): a bare ALTER COLUMN TYPE rewrites the table under AccessExclusive. Instead:\n-- 1. ADD COLUMN amount_new bigint; 2. backfill in batches; 3. dual-write; 4. drop the old, rename a release later.",
        "label": {"expand_contract": True, "lock_class_cited": True, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "type change handled as an expand/contract scaffold with the lock class named (P11).",
    },
    {
        "id": "diff-08",
        "trajectory": "SET lock_timeout = '3s';\nCREATE UNIQUE INDEX CONCURRENTLY users_email_uniq ON public.users (email);",
        "label": {"expand_contract": True, "lock_class_cited": False, "safe_rewrite": True},
        "expected_verdict": "safe",
        "note": "unique index built CONCURRENTLY (P12).",
    },
    # ---- UNSAFE trajectories (acorn would flag / a human rejects) ----
    {
        "id": "diff-09",
        "trajectory": "ALTER TABLE users ADD CONSTRAINT users_phone_check CHECK (phone IS NOT NULL);",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "the bare 84M-row CHECK — AccessExclusive full scan, no NOT VALID, no lock_timeout (SCENARIO #4 the WRONG way).",
    },
    {
        "id": "diff-10",
        "trajectory": "CREATE INDEX tickets_org_idx ON public.tickets (org_id);",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "CREATE INDEX without CONCURRENTLY — blocks writes for the whole build (P12).",
    },
    {
        "id": "diff-11",
        "trajectory": "ALTER TABLE users RENAME COLUMN full_name TO display_name;",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "a bare RENAME breaks the still-running old app version mid rolling-deploy (P13).",
    },
    {
        "id": "diff-12",
        "trajectory": "ALTER TABLE orders ALTER COLUMN amount TYPE bigint;",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "bare ALTER COLUMN TYPE rewrites the whole table under AccessExclusive (P11).",
    },
    {
        "id": "diff-13",
        "trajectory": "ALTER TABLE users ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES orgs(id);",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "FK validated on add — AccessExclusive (P10).",
    },
    {
        "id": "diff-14",
        "trajectory": "ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "bare SET NOT NULL scans the whole table under AccessExclusive (P10).",
    },
    {
        "id": "diff-15",
        "trajectory": "ALTER TABLE users DROP COLUMN legacy_token;",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "a bare DROP COLUMN 500s old app instances mid-deploy (P13) — drop a release after the code stops using it.",
    },
    {
        "id": "diff-16",
        "trajectory": "SET lock_timeout = '3s';\nALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age >= 0);  -- still validates on add despite lock_timeout",
        "label": {"expand_contract": False, "lock_class_cited": False, "safe_rewrite": False},
        "expected_verdict": "unsafe",
        "note": "has lock_timeout but STILL validates the CHECK on add (no NOT VALID) — a lock_timeout only fails fast, it does not avoid the scan. A subtle one the judge must catch.",
    },
]


def main() -> None:
    CORPUS.mkdir(parents=True, exist_ok=True)
    for e in ENTRIES:
        path = CORPUS / f"{e['id']}.json"
        path.write_text(json.dumps(e, indent=2) + "\n")
    print(f"wrote {len(ENTRIES)} labeled diffs to {CORPUS}/")


if __name__ == "__main__":
    main()
