# AGENTS.md — ERP Core

Repository-specific knowledge for future agent runs. Keep it current.

## What this is

Multi-tenant ERP backend core (Phase 1 complete) with additive vertical extensions on top.
Next.js 14 App Router · TypeScript strict · Supabase local Postgres 17 + Auth · Vitest · `pg`.
No Prisma. Schema lives in plain SQL migrations under `supabase/migrations/`.

`docs/CORE_INTERFACE.md` is the contract every extension builds on. Read it first.

## Ground rules (do not revisit; object in docs/ADR.md instead)

* Extend the core, never rewrite it. Never edit an applied migration.
* Never edit a core table without an ADR — additive columns included.
* Money is `NUMERIC(19,4)` + `decimal.js`. No floats in the schema, ever.
* Ledger tables (`journals`, `journal_lines`, `stock_ledger`, `stock_consumptions`, `audit_logs`)
  are immutable. Corrections are reversing rows.
* Business logic lives in SQL functions in schema `app`. Route handlers stay thin.
* Tests run against the real local Postgres. Nothing is mocked. Do not weaken, skip or delete tests.
* No `any` in `src/accounting/**` (ESLint error).
* List endpoints use keyset pagination on `(created_at, id)`, never `OFFSET`.

## Commands

```bash
supabase start                 # local Postgres + Auth (Docker must be running)
redis-server --daemonize yes   # R2 tests need a real Redis (REDIS_URL, default :6379)
supabase db reset              # apply every migration to an empty database
npm test                       # all tests, against real Postgres
npm run build                  # next build
npm run lint                   # includes the no-any rule for src/accounting
npm run test:perf              # 1M-line trial balance; writes docs/perf/
psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql     # must be 0 rows
psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql  # must be 0 rows
```

## Hard-won facts (save a future run the discovery time)

* **Adding a table means three edits, not one:** the migration, plus registering the table in
  `scripts/check-tenant-tables.sql` and `tests/support/tenant-tables.ts` (and seeding a row in the
  latter, so core test 2's table-driven RLS check covers it).
* **Composite foreign keys need an index on the leading columns in order**, or core test 9 fails.
  A self-referencing composite FK also needs its referenced `UNIQUE (org_id, id)` to exist at
  `CREATE TABLE` time.
* **A SQL function only inlines if it has no `set search_path` clause.** No inlining means no
  index choice to inspect and, usually, a worse plan. Qualify every object and drop the clause.
* **A CTE in a SQL function is materialised**, which hides a constant term from the planner and
  drops the index. Use a parenthesised `UNION ALL` of branches instead.
* **`pg_trgm` and `btree_gin` live in the `extensions` schema.** The combined GIN index is
  `(org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`; `extensions.gin_uuid_ops` does not
  exist, the name is `extensions.uuid_ops`.
* **The planner only prefers a trigram index once the table is big enough to beat a sequential
  scan** (measured ~15,000 products in one org). Seed that many rows, then `analyze`, before
  asserting an `EXPLAIN` shows the index.
* **`delete` + reinsert bloats a table and makes the planner flip-flop.** Use a fresh table, or
  `vacuum analyze`, when probing plan choices.
* **`ANALYZE` on a shared table leaks across test files.** Re-analysing `products` in one file
  changed the planner for the R1 search test in another. Seed and analyse only the table under
  test; keep the shared-table statistics untouched.
* **R2 caches promotion candidates, never prices.** Redis key `promos:{org_id}`, TTL 300s. Every
  evaluation re-checks the validity window in SQL (`app.apply_promotions`), so a stale entry cannot
  apply an expired promotion. A write to `promotions` invalidates the key, but correctness does not
  depend on it.
* **`language sql` pricing functions must have no `set search_path` clause**, or they will not
  inline and `EXPLAIN` will not show `price_list_items_list_variant_key`.
* **A route file may only export HTTP handlers.** Exporting a plain constant (e.g. a batch size)
  from `src/app/api/**/route.ts` fails `next build` with "is not a valid Route export field". Keep
  such constants in a module the route imports.
* **Re-creating a function is the additive way to change it.** `create or replace function` in a
  new migration leaves the applied migration untouched; the newest definition wins. R4 re-creates
  `app.create_invoice` and `app.consume_fifo` this way, changing only the availability guard.
* **The offline hook is a transaction-local GUC.** `app.negative_stock_allowed()` reads
  `current_setting('app.allow_negative_stock', true)`, set with `set_config(..., true)` only by the
  sync retry. It never leaks to another pooled request, and the live path never sets it.
* **`fake-indexeddb` is a real IndexedDB implementation, not a mock.** Import
  `fake-indexeddb/auto` at the top of a test that uses the outbox; the outbox module runs for real.
  `vi.resetModules()` plus a fresh dynamic `import()` simulates a page reload (only IndexedDB
  carries state).
* **The sync endpoint is exempt from the rate limiter.** `POST /api/pos/sales` is limited per
  cashier; `POST /api/pos/sync` is not, so a backlog is never throttled away.

## Test numbering

Phase 1 owns 1–40. R1 owns 41–44 (`tests/retail-r1.test.ts`). R2 owns 45–48
(`tests/retail-r2.test.ts`). R3 owns 9–13 (`tests/pos-r3.test.ts` plus the keyboard e2e). R4 owns
14–18 (`tests/pos-r4.test.ts` plus the offline e2e). A new run continues from the highest number
actually present; ranges in `docs/phase2/README.md` are indicative only (ADR-0010).
