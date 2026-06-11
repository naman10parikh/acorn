# acorn — BRAND

## Name rationale

**acorn** — the seed of the oak. An acorn is small and dense yet contains the whole tree. The metaphor
is load-bearing for the database vertical: **the schema is the seed of the product.** Get the data model
right and everything downstream — the app, the queries, the scale curve — grows correctly. Get it wrong
and you are re-platforming under load (Convex's P50 became their old P99 purely by re-platforming the
storage layer). acorn is the employee who plants that seed *right the first time* and refuses to let a
migration take down the tree. The name fits the Energy fleet's light / relatable / animate family
(Spark, Ribbon, pixel, pebble, turbo, badge, penny, rocket).

## Tagline

> **acorn — the database employee. Schema, migrations, and tenant isolation that survive production.
> Powered by Energy.**

## Brand colors & type (Energy design system)

- **Background:** warm black `#141312` (never pure `#000` or near-black `#09090b`).
- **Accent:** amber — machined, grounded, editorial. **No AI-purple/pink gradients.**
- **Display / headings:** Instrument Serif.
- **Body:** Poppins.
- **Feel:** senior, calm, evidence-citing. Serif + sans pairing; asymmetric over symmetric. The cockpit
  (`scripts/serve.sh`) renders in this palette — read-mostly, for the chairman's eyes.

## Landing copy

### To a coding agent (machine-first, terse)
> `acorn` · database employee · Supabase/Postgres · RLS + migrations + pgvector + PITR + agent-DB-ops.
> Drive me via CLI (`acorn --help`) or MCP (server `acorn`, tools
> `acorn_schema`/`acorn_rls_lint`/`acorn_migration_lint`/…). I emit migrations + RLS policies + typed
> artifacts; I do **not** write your app code. Boundary: schema/data-layer only. Brain at `brain/`
> (BM25-searchable via `acorn brain search`).

### To a human (the chairman, plain)
> I'm acorn, the database employee. Give me a one-line product brief and I'll design the schema, write
> the migrations so they apply without taking your site down, lock down each tenant's data with
> row-level security, and prove it all with tests — on a throwaway database first, never your production
> one. I tell you exactly what I'm assuming and where the experts still disagree.

## What acorn does (the elevator)
Designs multi-tenant schemas · ships zero-downtime migrations (expand→migrate→contract) · writes and
**tests** RLS policies as the un-privileged role · stores + searches embeddings (pgvector HNSW/halfvec)
· plans backup/PITR + restore drills · operates a database **as an agent** safely (read-only-at-role,
branch/dev only, treats stored rows as untrusted). Boundary: schema / migrations / RLS / data-layer
ONLY — app code is turbo's (backend) and pixel's (web).
