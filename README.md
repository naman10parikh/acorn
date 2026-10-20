# acorn

<!-- fleet:header:start -->
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE) [![Agent-native](https://img.shields.io/badge/agent--native-yes-2f5d8a?style=flat-square)](AGENTS.md) [![MCP server](https://img.shields.io/badge/MCP-server-1e3f60?style=flat-square)](#use-it-from-any-coding-agent) [![Skills](https://img.shields.io/badge/skills-5-2f6b4f?style=flat-square)](skills/)

**Designs Postgres schemas, makes migrations safe to run and tests row-level security so tenants stay apart.**

Acorn is an agent-native, recursively self-improving agent employee whose job is database. Coding agents use it through its skills, its MCP server and its command line. It improves itself through its own evals and a scheduled improvement loop, and a person reviews every change.

[AGENTS.md](AGENTS.md) · [llms.txt](llms.txt) · [Skills](skills/) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [All projects](https://github.com/naman10parikh)
<!-- fleet:header:end -->

Acorn is a database engineer for coding agents. Give it a one-line product brief and it picks the tenancy model,
writes the migrations so they apply without taking the site down, isolates each tenant with row-level security
(RLS), and proves the isolation with tests run as the un-privileged role, on a throwaway database and never on
production. It is for agents and teams that build on Postgres, Supabase or Neon. It says what it assumes and where
experts still disagree, and it owns the schema and the data layer only. Powered by Energy.

The name: an acorn is a small seed that holds the whole oak. The schema is the seed of the product. Get the data
model right and everything downstream grows correctly; get it wrong and you re-platform under load.

<!-- fleet:use:start -->
## Use it from any coding agent

**Claude Code**: the plugin brings the skills, sub-agents, hooks and MCP server.

```
/plugin marketplace add naman10parikh/acorn
/plugin install acorn@acorn
```

**Its MCP server**, in any MCP client:

```bash
claude mcp add --transport stdio acorn -- npx -y -p github:naman10parikh/acorn acorn-mcp
codex mcp add acorn -- npx -y -p github:naman10parikh/acorn acorn-mcp
```

Cursor (`.cursor/mcp.json`), Gemini CLI (`.gemini/settings.json`) and most other clients take the same command as JSON:

```json
{
  "mcpServers": {
    "acorn": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "github:naman10parikh/acorn",
        "acorn-mcp"
      ]
    }
  }
}
```

**Gemini CLI**: the extension brings the context and the MCP server.

```bash
gemini extensions install https://github.com/naman10parikh/acorn
```

**One skill** (5 in all, in [skills/](skills/)), in any agent that reads Agent Skills:

```bash
gemini skills install https://github.com/naman10parikh/acorn --path skills/design-multitenant-schema
git clone --depth 1 https://github.com/naman10parikh/acorn /tmp/acorn && cp -r /tmp/acorn/skills/design-multitenant-schema ~/.claude/skills/
```

**The command line:**

```bash
npx -y -p github:naman10parikh/acorn acorn --help
```

Codex, Cursor, OpenCode, GitHub Copilot and other agents read [AGENTS.md](AGENTS.md); Claude Code reads [CLAUDE.md](CLAUDE.md) and Gemini CLI reads [GEMINI.md](GEMINI.md), which import it. [llms.txt](llms.txt) maps every surface for agents that read first.
<!-- fleet:use:end -->

## Quick start

In one step, straight from GitHub:

```bash
npx -y -p github:naman10parikh/acorn acorn --help
```

From a clone (Node and pnpm; Python 3 for the evals):

```bash
git clone https://github.com/naman10parikh/acorn && cd acorn
pnpm install && pnpm build
node dist/index.js schema "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages"
node dist/index.js rls lint test/fixtures/no-rls.sql
node dist/index.js migration safe test/fixtures/bare-check.sql
node dist/index.js brain search "filtered ANN over-filter"
pnpm test && python3 eval/eval.py --l1-only
```

Without a database, `schema` derives 4 tables (orgs, members, tickets, messages), writes the migration and the RLS
policies, and its self-check finds 0 errors. It applies nothing until you pass `--apply` with a branch or dev
`DATABASE_URL`. `rls lint` flags the table that has no RLS and exits 1. `migration safe` rewrites a bare `CHECK`
into `NOT VALID` plus `VALIDATE`, with a `lock_timeout`. `pnpm test` passes 74 tests (6 more need a live database),
and the L1 eval passes all 12 house rules.

## How it works

Its acceptance test is one command:

```bash
acorn schema "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages" \
  --provider supabase --apply --verify-rls
```

It applies the migrations to a fresh database and verifies RLS with tests run as `authenticated` and `anon`. It
never verifies in the Supabase SQL Editor, which runs as `postgres` and bypasses RLS. That mistake let the anon key
read data in 170 apps (CVE-2025-48757). CI runs the test on every push against a pinned `supabase/postgres`
container ([`acceptance.yml`](.github/workflows/acceptance.yml)), along with the golden tasks.

**The CLI.**

| Job | Command |
| --- | --- |
| Design a multi-tenant schema | `acorn schema "<brief>"` |
| Lint, generate or test RLS | `acorn rls {lint,gen,test}` |
| Ship a migration without an outage | `acorn migration {lint,safe,apply}` |
| Plan pgvector search | `acorn vector {plan,recall}` |
| The pooled and direct connection strings | `acorn conn gen` |
| Provision a throwaway database (branch or dev only) | `acorn provision` |
| Plan backup and point-in-time recovery | `acorn backup plan` |
| Health and feature detection | `acorn doctor` |
| Search the expertise brain | `acorn brain search "<q>"` |

`acorn --help` lists every command; lint and doctor accept `--json`.

**The MCP server.** Acorn ships its own MCP server, `acorn-mcp`, with 12 tools, one per CLI verb, so a sibling
agent can call `acorn_rls_lint` over JSON-RPC. The lints are deterministic SQL checks: no model and no API key.
The root [`.mcp.json`](.mcp.json) starts it from GitHub, and the A2A card is at
[`.well-known/agent.json`](.well-known/agent.json). Started from GitHub, the server reads a path only inside its
own package, so pass SQL text inline.

**How it thinks.** Senior, calm, evidence-citing. It does not say "RLS is a good practice"; it says "enable RLS on
this table and test as `authenticated`, never in the SQL Editor." Every strong claim carries a receipt: a CVE, a
postmortem, a benchmark or a brain citation. It date-checks itself against the 2025 to 2026 turning points (PG18,
Prisma 7, Drizzle joining PlanetScale, the agent-database threat model) and feature-detects provider capabilities
(`SELECT uuidv7()`) before using them. Where a real split stays open, such as `bigint` or `uuidv7` for primary
keys, it states both sides and the decision rule.

**The brain.** Its expertise lives in [`brain/`](brain/), searchable with `acorn brain search`:
[`EXPERTISE-MAP.md`](brain/EXPERTISE-MAP.md) (the field by job to be done),
[`BATTLE-TESTED-SCENARIOS.md`](brain/BATTLE-TESTED-SCENARIOS.md) (real incidents, which become the golden tasks),
[`KNOWN-PITFALLS.md`](brain/KNOWN-PITFALLS.md), [`OPINIONS.md`](brain/OPINIONS.md),
[`GAPS-AND-DISPUTES.md`](brain/GAPS-AND-DISPUTES.md) and [`TOOL-MATRIX.md`](brain/TOOL-MATRIX.md).

**The nightly loop.** Every day at 09:00 UTC, [`rsi.yml`](.github/workflows/rsi.yml) builds acorn and runs
[`workflows/rsi.workflow.js`](workflows/rsi.workflow.js). It reports the version-gate snapshot, re-runs the L1
eval, checks that the RLS lint runs and flags brain files older than the newest version-gate event. The run keeps
its proposal as an artifact for a person to review. It never applies or merges anything, and an L1 regression
turns it red.

**Boundary.** Acorn owns the schema, migrations, RLS and the data layer only. It emits the migration, the RLS
policy, the typed schema and the connection-string contract; it does not write the app that consumes them (that
is turbo's backend and pixel's web). No agent path of acorn writes to a production database.

<!-- fleet:anatomy:start -->
## What it is made of

Every project in this fleet is graded on the same 11 harness components and on self-improvement. Each mark is backed by a file you can open.

| Component | Grade | Where |
| --- | --- | --- |
| Identity | ✅ | identity/SOUL.md:5 |
| Memory | ✅ | src/brain/search.ts:155 |
| Skills | ✅ | skills/harden-rls/SKILL.md:1 |
| Tools/CLIs | ✅ | package.json:7 |
| Hooks | ✅ | .claude/settings.json:6 |
| Sub-agents | ✅ | .claude/agents/rls-auditor.md:2 |
| MCPs | ✅ | src/mcp/tools.ts:107 |
| Dispatch | ✅ | src/dispatch/schema-flow.ts:78 |
| Evals | ✅ | .github/workflows/acceptance.yml:90 |
| Observability | ✅ | src/dispatch/log-step.ts:62 |
| Sandbox/Infra | ✅ | src/sandbox/provision.ts:35 |
| RSI / open-endedness | ✅ | dsip.json:27 |

✅ real and tested · 🟡 partial, with the reason in the row · ❌ absent
<!-- fleet:anatomy:end -->

## More

- [`AGENTS.md`](AGENTS.md): the agent-facing reference (every CLI verb and MCP tool, the boundary, the 12 house rules).
- [`llms.txt`](llms.txt): the agent-readable map of every surface.
- [`CLAUDE.md`](CLAUDE.md): the operating rules.
- [`identity/SOUL.md`](identity/SOUL.md): the full persona.
- Sibling employees: **turbo** (backend), **pixel** (web), **badge** (auth), **penny** (payments), **rocket** (deploy and CI).

<!-- fleet:footer:start -->
## How it improves itself

It carries its own evals and a self-improvement contract, [`dsip.json`](dsip.json) (level L2). A scheduled loop runs the evals, tries a change in a sandbox and opens it for review. A change that lowers a score is not merged, and a person merges every change. Lessons it learns are kept as rules in its memory files.

## Part of a fleet

One of the agent-native, recursively self-improving open-source projects by [Naman Parikh](https://github.com/naman10parikh). Each one is an agent employee that owns one part of an agent's harness or of the product around it.

Siblings: [agentdial](https://github.com/naman10parikh/agentdial) (identity) · [wikimem](https://github.com/naman10parikh/wikimem) (memory) · [skillsmith](https://github.com/naman10parikh/skillsmith) (skills) · [agent-booster](https://github.com/naman10parikh/agent-booster) (tools / CLIs) · [armory](https://github.com/naman10parikh/armory) (MCPs and the component registry) · [agentgrid](https://github.com/naman10parikh/agentgrid) (dispatch) · [agentswarm](https://github.com/naman10parikh/agentswarm) (dispatch) · [agentbench](https://github.com/naman10parikh/agentbench) (evals) · [agentmoney](https://github.com/naman10parikh/agentmoney) (observability) · [claude-harness](https://github.com/naman10parikh/claude-harness) (the whole harness, as a template).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md); AI-assisted pull requests are welcome. Report a vulnerability privately, as [SECURITY.md](SECURITY.md) explains.

## License

MIT, © 2026 Naman Parikh. See [LICENSE](LICENSE).
<!-- fleet:footer:end -->
