# PROGRESS — ERP Core

Repo root: `/workspace/project`
Stack: Next.js 14 (App Router) · TypeScript strict · Supabase (local Postgres 17 + Auth) · Vitest · `pg`
Schema: plain SQL migrations in `supabase/migrations/` (no Prisma).

Phase 1 (the core) is complete: tests 1–40. R1 extends the core additively: tests 41–44. R2 adds
pricing and promotions: tests 45–48.

## Status

| Milestone | Scope | Gate | State |
|-----------|-------|------|-------|
| M0 | Setup | build passes on empty app | DONE |
| M1 | Tenancy (RLS, indexes, partitions) | tests 1–14 | DONE |
| M2 | Accounting | tests 15–24 | DONE |
| M3 | Inventory | tests 25–31 | DONE |
| M4 | Sales & purchases + concurrency | tests 32–40 | DONE |
| M5 | Hardening (audit, checks, perf, README) | verification list | DONE |
| R1 | Retail extension: products, barcodes, search | tests 41–44 | DONE |
| R2 | Retail extension: pricing and promotions | tests 45–48 | DONE |
| R3 | Retail extension: online POS sale | tests 9–13 | DONE |

## M0 — Setup

* `supabase init` + `supabase start` (local Postgres 17.11).
* Next.js 14.2.15, React 18, TypeScript 5.6 strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
* Vitest 2.1 (`tests/**/*.test.ts`, node env, `fileParallelism: false` so concurrency tests get
  real parallel connections).
* ESLint via `next/core-web-vitals` + an override that sets `@typescript-eslint/no-explicit-any:
  error` for `src/accounting/**`.
* Placeholder page at `src/app/page.tsx`.

Gate evidence:

```
$ npm run build
   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
 ✓ Generating static pages (4/4)
```

## M1 — Tenancy

Migrations (restructured so that every tenant table exists at M1, because the M1 gate includes
the table-driven RLS test and the RLS/partition schema tests):

* `20260101000000_extensions_and_helpers.sql` — `pgcrypto`, `app` schema, `set_updated_at`,
  `current_org_id()`, `current_branch_ids()`.
* `20260101000100_tenancy_tables.sql` — organizations, branches, memberships, invites, settings,
  number_series.
* `20260101000200_accounting_tables.sql` — chart_of_accounts, fiscal_periods, tax_rates,
  exchange_rates, journals (partitioned), journal_lines (partitioned).
* `20260101000300_inventory_tables.sql` — products, product_variants, warehouses, stock_ledger
  (partitioned), stock_consumptions (partitioned), stock_balances, stock_layer_balances,
  stock_transfers.
* `20260101000400_sales_tables.sql` — contacts, sales_orders, invoices, invoice_lines, payments,
  credit_notes, purchase_orders, audit_logs (partitioned).
* `20260101000500_indexes.sql` — `(org_id, created_at desc, id desc)` on org-scoped tables,
  `(org_id, branch_id, created_at desc, id desc)` on branch-scoped high-volume tables, composite
  business-key uniques, and an index on every FK column.
* `20260101000600_functions.sql` — access predicates, `next_number`, invites,
  `custom_access_token_hook`, `ensure_partitions`, `enforce_immutable`, `apply_tenant_rls`.
* `20260101000700_accounting_functions.sql` — rates, tax rates, closed-period guard, balance
  trigger, `post_journal`, `reverse_journal`.
* `20260101000800_inventory_functions.sql` — `lock_stock_balances`, `post_receipt`,
  `consume_fifo`, `post_stock_adjustment`.
* `20260101000900_sales_functions.sql` — `create_invoice`, `allocate_payment`,
  `create_credit_note`, `assert_page_limit`.
* `20260101001000_defaults_rls_partitions.sql` — per-org defaults, audit trigger, RLS, immutability
  grants, partitions.

Design notes:

* `organizations.org_id` is a real `uuid NOT NULL` column set from `id` by a BEFORE INSERT trigger
  (a generated column cannot be `NOT NULL`), so the "every tenant table has `org_id`" invariant
  holds literally.
* `invoices`, `invoice_lines`, `payments` and `credit_notes` are **not** partitioned: their
  business keys (`unique (org_id, invoice_no)`) cannot be enforced on a partitioned table without
  adding the partition key. They keep a composite `journal_created_at` FK to the partitioned
  `journals`.
* Access predicates read JWT claims only (`auth.jwt() ->> 'org_id'`, `auth.jwt() -> 'branch_ids'`),
  so membership changes take effect on token refresh.

Gate evidence:

```
$ npx vitest run tests/tenancy.test.ts
 Test Files  1 passed (1)
      Tests  15 passed (15)

$ psql -f scripts/check-fk-indexes.sql
(0 rows)

$ psql -f scripts/check-tenant-tables.sql
(0 rows)
```

## M2 — Accounting

`tests/accounting.test.ts` covers tests 15–24.

```
$ npx vitest run tests/accounting.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

* Balance check: `journal_lines_balance` is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger
  on the `journal_lines` parent; PG17 clones it onto every existing and future partition (ADR-0001).
* A line carries either a debit or a credit (`journal_lines_single_sided_check`) and never a
  negative value.
* Closed periods: `app.assert_period_open` plus a BEFORE INSERT trigger on `journals`.
* Rates: `app.rate_on` and `app.tax_rate_on` are effective-dated; each journal line stores the
  rate it used, so later rate changes do not rewrite history.
* Rounding: `post_journal` rounds base amounts to 4 dp per line and posts any residual to the
  rounding account from `settings`.

## M3 — Inventory

`tests/inventory.test.ts` covers tests 25–31.

```
$ npx vitest run tests/inventory.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

* FIFO: `app.consume_fifo` walks `stock_layer_balances` ordered by `(in_ledger_created_at,
  in_ledger_id)`, locking each layer `FOR UPDATE`. Every consumption is a new
  `stock_consumptions` row; a layer row is only ever decremented, never rewritten.
* Lock order: `app.lock_stock_balances(org, branch, keys)` locks the `stock_balances` rows one key
  at a time in ascending `(warehouse_id, product_id, variant_id)` order.
* Negative stock is rejected by default; `warehouses.allow_negative_stock` opts a warehouse in,
  in which case the shortfall is valued at the most recent inbound cost.
* `post_receipt` and `post_stock_adjustment` each write ledger rows and a balanced journal in one
  transaction.
* SKUs come from `number_series` via `app.next_number` (locked `FOR UPDATE`), never from a
  Postgres sequence.

## M4 — Sales and purchases

`tests/sales.test.ts` covers tests 32–40.

```
$ npx vitest run
 Test Files  4 passed (4)
      Tests  40 passed (40)
```

* Business logic is in SQL: `app.create_invoice`, `app.allocate_payment`, `app.create_credit_note`,
  `app.post_receipt`, `app.post_stock_adjustment`. Route handlers (`src/app/api/**`) only parse the
  request, call one function inside a user-scoped transaction, and serialise the result.
* `create_invoice` takes a gapless number from `number_series` (`FOR UPDATE`) inside its own
  transaction, so a rollback does not consume a number.
* `app.allocate_payment` locks the invoice `FOR UPDATE` and refuses an amount above the open
  balance.
* `app.create_credit_note` returns stock as a new inbound layer at the invoice line's original FIFO
  cost and posts a reversing journal.
* Listing: `app.list_invoices` keysets on `(created_at, id)` with an explicit column list. The
  default limit is 50 and the maximum is 100; anything else raises. `app.invoice_lines_for(uuid[])`
  batches child rows with `= ANY($1)`.
* Concurrency: `app.lock_stock_balances` sorts keys, so invoices that touch the same products in
  opposite order cannot deadlock.

## M5 — Hardening

Verification list, all green:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  4 passed (4)
      Tests  40 passed (40)

$ npm run build
 ✓ Compiled successfully
   Linting and checking validity of types ...

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

* Audit: `app.write_audit_log()` writes `audit_logs` for invoices, payments, journals, products and
  stock_ledger (receipts and adjustments). It stores the logical table name, not the partition
  (ADR-0006). Nothing on a request path reads it.
* `scripts/check-fk-indexes.sql` and `scripts/check-tenant-tables.sql` both return zero rows.
* `npm run test:perf` seeds 1,000,000 journal lines with `generate_series` inside SQL and writes
  `docs/perf/trial-balance-<timestamp>.md`. The one-month trial balance prunes to a single partition
  and uses `journal_lines_<YYYYMM>_org_id_idx`; the full-range query reads every partition and may
  sequentially scan. Timings are recorded, not enforced (ADR-0005, ADR-0007).
* The no-any rule for `src/accounting/**` is enforced by an ESLint override
  (`@typescript-eslint/no-explicit-any: error`); `npm run lint` fails if `any` appears there.
* `README.md` documents the Mermaid ER diagram, the indexing strategy, how to run
  `ensure_partitions`, how to add a vertical module, and the token-refresh note.

## Notes / decisions recorded in docs/ADR.md

* ADR-0001 Deferred balance-check trigger on the partitioned `journals` parent (PG17 clones the
  parent's constraint trigger onto every new partition, so no per-partition attach helper is needed).
* ADR-0002 ZWG seeded as the Zimbabwe currency code (ZWL open item).
* ADR-0003 ZIMRA fiscalisation format unknown — not built this phase.
* ADR-0004 Rounding residual posts to the rounding account from settings, never dropped.
* ADR-0005 No summary table for the trial balance in Phase 1 (perf run is under 500 ms).
* ADR-0006 Audit rows store the logical table name, not the partition.
* ADR-0007 The perf seed spreads rows across organisations so the plan reflects production.

## Phase 2 backlog — prompts written (not yet executed)

The Phase 2 backlog has been turned into one prompt per item under `docs/phase2/`, each with its own
milestones and gates. Nothing in Phase 2 has been executed; Phase 1 remains the current deliverable.

| # | Item | Tests | Depends on |
|---|------|-------|------------|
| P2-01 | Rate limiting (Upstash Redis) | 41–44 | Phase 1 |
| P2-02 | Low-stock alerts (indexed view) | 45–47 | Phase 1 |
| P2-03 | Audit log viewer (read-only, paginated) | 48–50 | Phase 1 |
| P2-04 | Settings cache (`unstable_cache`, invalidated on write) | 51–53 | Phase 1 |
| P2-05 | Pharmacy readiness: lot/batch/expiry hooks (ADR) | 54–55 | Phase 1 |
| P2-06 | Dashboard (`dashboard_stats` matview, pg_cron 2 min, <100 ms @ 1M rows) | 56–58 | Phase 1 |
| P2-07 | Realtime (branch-scoped subscriptions) | 59–61 | Phase 1 |
| P2-08 | Invite UI + org/branch switcher | 62–64 | Phase 1 |
| P2-09 | Report summary tables | **conditional — gated OFF** | perf ADR triggered |
| P2-10 | Hash sub-partitioning (`stock_ledger` by org) | **conditional — gated OFF** | measured need |
| P2-11 | First vertical module: Retail | 69–75 | P2-05 |
| P2-12 | Frontend vertical slices | 76–80 | P2-08 |

Ordering rules applied from the backlog text: the pharmacy ADR (P2-05) precedes the first vertical
module (P2-11); report summary tables (P2-09) run only if the Phase 1 perf ADR was triggered — it was
not (ADR-0005); hash sub-partitioning (P2-10) runs only on measured need — none exists.

Environment note: this session began on a recycled runtime (Docker down, Supabase CLI off `PATH`).
The environment was restored (dockerd restarted, Supabase CLI v3.1.0 installed, local stack up) and
all Phase 1 gates were re-verified on a clean database: `npm test` 40 passed (40), `npm run build`
compiled successfully, `npm run lint` clean, both check scripts 0 rows.

## R1 — Retail extension: products, barcodes and search

Additive. The core is not rewritten and no core accounting logic changed. Two new org-scoped tables
and a set of nullable/defaulted columns on `products` and `product_variants` (ADR-0008). Tests 41–44
in `tests/retail-r1.test.ts`.

Migration: `supabase/migrations/20260101010000_retail_r1_products_search.sql`.

* `categories` (nested via `parent_id`), `product_batches` (batch master) — org-scoped, RLS forced,
  indexes and FK indexes per the core rules.
* `products`: `category_id`, `unit product_unit`, `is_weighable`, generated `name_search tsvector`.
* `product_variants`: `size`, `color`, `barcode` (partial unique per org).
* `app.search_products(org_id, query, limit)` — exact barcode first, then trigram name match,
  capped at 20, backed by `products (org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`.
* `GET /api/pos/search?q=` plus `src/verticals/retail/{products,quantity,debounce,TillSearch}`.

The 4 tests:

| # | Test |
|---|------|
| 41 | Barcode lookup returns the correct variant in under 100 ms on 1,000 products |
| 42 | Name search returns at most 20 results and EXPLAIN shows the trigram index |
| 43 | Org A cannot read or search Org B rows in every R1 table |
| 44 | A weighable product stores quantity 0.750 kg exactly |

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  5 passed (5)
      Tests  44 passed (44)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* Core test 9 (every FK column has an index) drove two extra indexes on the new composite FKs:
  `categories (org_id, parent_id)` and `products (org_id, category_id)`.
* Search correctness and index use both depend on the function inlining (ADR-0009): no
  `set search_path`, and a parenthesised `UNION ALL` instead of a CTE.
* `docs/CORE_INTERFACE.md` was a stated starting condition but did not exist; it has been written
  from the Phase 1 migrations.

## R2 — Retail extension: pricing and promotions

Additive. The only core-table change is a nullable `contacts.group_id` (ADR-0011); no core
accounting path is touched. See ADR-0011 to ADR-0013 and `docs/CORE_INTERFACE.md`.

Migration: `supabase/migrations/20260101020000_retail_r2_pricing_promotions.sql`.

* New org-scoped tables: `price_lists`, `price_list_items`, `customer_groups`, `promotions`,
  `discount_limits`. New branch-scoped table: `manual_discounts`.
* Additive column: `contacts.group_id uuid` with a `(org_id, group_id)` foreign key.
* Functions: `app.get_price`, `app.get_prices`, `app.apply_promotions`,
  `app.promotion_candidates`, `app.assert_manual_discount`, `app.record_manual_discount`,
  `app.convert_for_display`.
* TypeScript: `src/verticals/retail/pricing.ts`, `src/core/redis.ts`; route
  `src/app/api/pos/price/route.ts`.
* Redis caches promotion *candidates* only (`promos:{org_id}`, TTL 300s), never a resolved price.

The 4 tests:

| # | Test |
|---|------|
| 45 | Matching promotion applies automatically from cache |
| 46 | Promotion past valid_to not applied, even when the cache entry is 3 minutes old |
| 47 | Precedence holds, and a manual discount above the role limit is rejected |
| 48 | A 30-item cart resolves prices in at most two database queries, and get_price uses an index |

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  6 passed (6)
      Tests  48 passed (48)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* Precedence is implemented once, in `app.apply_promotions` and `app.get_price(s)`, so the cached
  path and the SQL path cannot drift. The cached path passes the Redis candidates into the same
  function.
* The retail list is a per-item fallback, not only a fallback when the group has no list: a variant
  missing from the group's list prices at retail (test 47).
* Both pricing functions are `language sql`, `security invoker`, with no `set search_path` clause,
  so the planner inlines them and uses `price_list_items_list_variant_key` (test 48 asserts this).
* Test 48 seeds 2,000 extra price rows and analyses only `price_list_items`; re-analysing the shared
  `products` table perturbed the planner for the R1 search test.
* Core test 9 drove extra indexes on the new composite foreign keys
  (`price_list_items`, `customer_groups`, `contacts.group_id`, `manual_discounts`).

## R3 — Retail extension: online POS sale

Status: complete. Gate evidence below.

What shipped:

* `supabase/migrations/20260101030000_pos_r3_shifts_sales.sql` — `shifts` (org + branch scoped,
  `till_id`, `opened_at`, `closed_at`, `opening_float`, index `(org_id, branch_id, till_id,
  opened_at desc)`); `pos_sales` (partitioned monthly on `created_at`, PK `(id, created_at)`,
  indexes `(org_id, branch_id, created_at desc, id desc)` and `(org_id, branch_id, shift_id)`);
  `pos_payments` (one row per tender, composite FK to `pos_sales (id, created_at)`); `pos_sale_keys`
  (the idempotency claim, `unique (org_id, client_sale_id)` — ADR-0014). RLS forced on all four.
* `app.post_pos_sale` — one transaction: resolve lines, price via R2, `app.create_invoice`,
  one `app.allocate_payment` per tender, write `pos_sales` and `pos_payments`. Idempotent on
  `client_sale_id`. `app.open_shift` and `app.list_pos_sales` alongside it.
* `src/verticals/pos/` — `sales.ts` (typed wrappers), `cart.ts` (Zustand cart, decimal money),
  `api.ts` (bearer-token fetch). `src/app/api/pos/sales` and `src/app/api/pos/shifts` thin routes.
* `/pos` keyboard-only till, 58mm browser receipt, `docs/pos-keys.md`. `npm run db:seed-demo` seeds
  a demo tenant and prints an access token so the receipt can be checked by hand.

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  7 passed (7)
      Tests  54 passed (54)

$ npx playwright test
  1 passed (2.2s)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

The R3 tests (9–13):

| # | Test |
| --- | --- |
| 9 | Sale creates one invoice, one payment and one pos_payments row, and the journal balances to 0.0000 |
| 10 | 50 concurrent sales for 10 units: exactly 10 succeed, 40 fail with insufficient stock, stock lands on 0.0000 |
| 11 | A USD + ZWG sale creates 2 pos_payments rows and 2 core payments, and the invoice is fully paid |
| 12 | 100 concurrent sales across shared products in one branch finish with no non-retryable error and no negative stock |
| 13 | One-item exact cash sale completes in three keyboard-only actions (Playwright) |

Notes:

* `pos_sales` is partitioned monthly, so `unique (org_id, client_sale_id)` cannot sit on it
  (Postgres requires the partition key in every unique constraint). The claim lives on
  `pos_sale_keys`; the retry path returns the original receipt. ADR-0014.
* The till resolves the price for a scanned item through `POST /api/pos/price` before adding it, so
  the F9 exact-cash tender equals the invoice total to the cent.
* `shifts` and `pos_payments` carry the `(org_id, branch_id, created_at desc, id desc)` index so the
  schema invariants (test 11) cover them without a special case.
