# acorn

> **The database employee.** Schema, migrations, and tenant isolation that survive production. Powered by Energy.

acorn is the Energy fleet's Postgres/Supabase/Neon/Convex domain expert. Give it a one-line product brief and
it designs the schema, writes the migrations so they apply **without taking your site down**, locks down each
tenant's data with row-level security, and **proves it with tests** — on a throwaway database first, never your
production one. It tells you exactly what it's assuming and where the experts still disagree.

An acorn is a small, dense seed that contains the whole oak. The metaphor is load-bearing: **the schema is the
seed of the product** — get the data model right and everything downstream grows correctly; get it wrong and
you re-platform under load.

## The boundary

acorn owns **schema / migrations / RLS / the data layer ONLY**. It emits the migration, the RLS policy, the
typed schema, and the connection-string contract — it does **not** write the app that consumes them (that is
turbo's backend + pixel's web). No agent path of acorn ever writes to a production database.

## Install

```bash
pnpm install --frozen-lockfile && pnpm build
node dist/index.js --help          # or `acorn --help` once linked
```

acorn is also a Claude Code plugin (`.claude-plugin/manifest.json`) bundling the CLI, the MCP server, 5 skills,
the DB-safety hooks, and 2 sub-agents. Add it via Settings → Plugins → Add local plugin.

## The acceptance test (what acorn is *for*)

```bash
acorn schema "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages" \
  --provider supabase --apply --verify-rls
```

→ migrations applied on a fresh database + RLS **verified by tests as the un-privileged role**
(`authenticated`/`anon`), never the Supabase SQL Editor (which runs as `postgres` and bypasses RLS — the exact
mistake that leaked 170 apps via CVE-2025-48757). Green in CI via `.github/workflows/acceptance.yml`.

## What it does

| Job | Command |
| --- | --- |
| Design a multi-tenant schema | `acorn schema "<brief>"` |
| Lint / generate / test RLS | `acorn rls {lint,gen,test}` |
| Ship a migration without an outage | `acorn migration {lint,safe,apply}` |
| Plan pgvector RAG | `acorn vector {plan,recall}` |
| The mandatory connection-string split | `acorn conn gen` |
| Provision a throwaway DB (branch/dev only) | `acorn provision` |
| Plan backup / PITR | `acorn backup plan` |
| Health + feature-detect | `acorn doctor` |
| Search the expertise brain | `acorn brain search "<q>"` |

Every CLI verb is also an MCP tool (server name `acorn`, 12 tools, stdio) so a sibling agent can call
`acorn_rls_lint` over JSON-RPC. The lints are deterministic SQL-AST/regex checks — no LLM, no API key.

## How acorn thinks

Senior, calm, evidence-citing, allergic to slop. It doesn't say "RLS is a good practice"; it says *"enable RLS
on this table and test as `authenticated`, never the SQL Editor — that exact privilege-mismatch leaked 170 apps
via CVE-2025-48757."* Every strong claim carries a receipt. It date-checks itself against the 2025-2026
inflection events (PG18, Prisma 7, Drizzle→PlanetScale, the agent-DB threat model) and feature-detects provider
capabilities (`SELECT uuidv7()`) before using them. Where a real taste-split remains open — `bigint` vs
`uuidv7` for PKs — it states both sides and the decision rule rather than fake-resolving it.

acorn's expertise lives in `brain/` (BM25-searchable). See `AGENTS.md` for the full CLI + MCP invocation
reference and the 12 house rules.

## See Also

- [AGENTS.md](./AGENTS.md) — the agent-facing invocation reference (CLI + MCP + boundary + house rules).
- [llms.txt](./llms.txt) — the agent-readable map of every surface.
- Sibling Energy employees: **turbo** (backend), **pixel** (web), **badge** (auth), **penny** (payments), **rocket** (deploy/CI).

---

MIT · Part of the Energy platform.
