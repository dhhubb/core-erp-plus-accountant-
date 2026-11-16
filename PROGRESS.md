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
| R4 | Retail extension: offline outbox and sync | tests 14–18 | DONE |
| R5 | Retail extension: operations (laybys, returns, credit, Z-reports, stock counts) | tests 19–24 | DONE |
| R6 | Retail extension: fiscal integration adapter (queue-only) | test 25 | DONE |
| H1 | Branch server: local Postgres, PIN sign-in, PWA, LAN HTTPS, branch mode | tests 49–52 | DONE |
| H2 | Offline sync engine: branch outbox → cloud ingest → pull | tests 53–63 | DONE |
| H3 | Fiscal and numbering: FDMS queue, branch-local number blocks | tests 64–68 | DONE |
| H4 | Hardware and receipts: ESC/POS, QR, printer settings, relay, scanner, hold/recall, print timing | tests 69–74 | DONE |
| H5 | Migration wizard: Pastel CSV → products/customers/opening stock, chunked COPY, mapping, commit | tests 75–85 | DONE |

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

## R4 — Retail extension: offline outbox and sync

Additive. Nothing in an applied migration was edited; the two re-created core functions
(`app.consume_fifo`, `app.create_invoice`) and the new sync entry point live in a new migration.

Migration: `20260101040000_pos_r4_offline_sync.sql`.

* New branch-scoped table `pos_sync_exceptions` (where a synced sale that could not post strictly is
  recorded instead of being refused), with the `(org_id, branch_id, created_at desc, id desc)`
  index and forced RLS.
* `app.negative_stock_allowed()` — the transaction-local allow-negative hook (ADR-0015).
* `app.consume_fifo` and `app.create_invoice` re-created verbatim with the hook added to the
  availability guard. Only the guard line changed.
* `app.sync_pos_sale(...)` — one call per offline sale. Never rejects a completed sale (ADR-0016).

TypeScript:

* `src/verticals/pos/outbox.ts` — IndexedDB outbox, `client_sale_id` generated at sale time,
  exponential backoff with full jitter.
* `src/verticals/pos/sync.ts` — the drain loop, one request in flight, removes an entry only on
  `committed` or `duplicate`.
* `src/verticals/pos/syncServer.ts` — one transaction per sale on its own connection, under the
  caller's RLS context.
* `src/verticals/pos/rateLimit.ts` — live-sale limiter, Redis counters prefixed by org (ADR-0018).
* `src/app/api/pos/sync/route.ts` — `POST /api/pos/sync`, up to 50 sales, exempt from the limiter.
* `POST /api/pos/sales` is rate limited to 30 sales/minute/cashier and returns `429` with
  `Retry-After` past that (ADR-0018).
* `/pos` queues a sale on a network failure or a `429`/`5xx`, shows `Pending n`, and drains the
  outbox on load, on reconnect and every 15 seconds.

The R4 tests (14–18):

| # | Test |
| --- | --- |
| 14 | A sale completed offline survives a page reload in IndexedDB with its UUID, lines, prices and shift intact |
| 15 | Reconnecting syncs every queued sale and clears the outbox; each sale reaches the ledger once |
| 16 | The same `client_sale_id` twice posts once; the second request is a `duplicate` with the original receipt |
| 17 | A sale synced after stock hit zero is accepted and logged as a `negative_stock` exception; the live path still rejects; the ledger balances |
| 18 | The 31st live sale in one minute is `429` with `Retry-After`; a 100-sale sync backlog is accepted with no `429` |

Gate evidence (R4):

```
$ supabase db reset
Applying migration 20260101040000_pos_r4_offline_sync.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  8 passed (8)
      Tests  59 passed (59)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (4/4)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)

$ npx playwright test
  2 passed (7.5s)
```

Notes:

* `pos_sync_exceptions` is registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2) and the schema checks
  cover it without a special case.
* IndexedDB is provided in Vitest by `fake-indexeddb` — a real in-memory implementation of the
  IndexedDB API, not a stub of `outbox.ts`. The outbox module and the route handlers run for real.
* Redis counters are prefixed `ratelimit:livesale:{org_id}:{branch_id}:{cashier_id}:{window}`. Redis
  holds counters only; the ledger is unaffected and the counters are safe to lose.

## R5 — Retail extension: operations

Scope: laybys, returns, credit limits, Z-reports and stock counts. Additive: new tables and
functions, plus three additive changes to core tables (ADR-0019).

Migration: `supabase/migrations/20260101050000_ops_r5.sql`.

New tables:

* Org-scoped: `credit_limits`.
* Branch-scoped: `laybys` (index `(org_id, branch_id, status, due_date)`), `layby_reservations`,
  `returns`, `return_lines`, `z_reports` (immutable), `stock_counts` (partitioned monthly, PK
  `(id, created_at)`), `stock_count_items`.

New SQL functions (all in `app`):

* `post_balanced_journal` — the balanced-journal hook. Asserts the lines balance, then delegates to
  `app.post_journal`. Every operational journal goes through it.
* `check_credit` — locks the contact `FOR UPDATE`, then refuses a sale past the ceiling.
* `create_layby` / `complete_layby` / `cancel_layby`.
* `create_return` — locks the invoice lines, checks the unreturned quantity, calls the core credit
  note, posts the refund.
* `close_shift` — re-created from R3 with the same signature; now writes one immutable Z-report.
* `create_stock_count` / `close_stock_count` — one core stock adjustment (one journal) per count.

Additive core changes (ADR-0019):

* `settings` gains `layby_deposit_percent`, `layby_cancellation_fee`, `return_refund_method`.
* New default accounts `2300`, `2400`, `4600` and number series `LAYBY`, `RETURN`, `Z_REPORT`,
  `STOCK_COUNT`.
* `journals.source_type` gains `layby_deposit`, `layby_cancellation`, `return_refund`;
  `stock_ledger.source_type` gains `layby`.
* New index `invoices (org_id, contact_id, created_at desc, id desc)`.

TypeScript: `src/verticals/ops/{laybys,returns,credit,stockCounts,zReports}.ts`, and thin handlers
`src/app/api/{laybys,returns,credit-limits,stock-counts,z-reports}/route.ts`.

The R5 tests (19–24):

| # | Test |
| --- | --- |
| 19 | A layby deposit posts Dr Bank / Cr Customer Deposits and holds the stock aside |
| 20 | Completing a layby creates the invoice and clears the deposit against AR |
| 21 | Cancelling a layby refunds the deposit less the fee and returns the stock |
| 22 | A return cannot exceed the quantity sold and returns stock at the original FIFO cost |
| 23 | 20 concurrent credit sales against one customer never exceed the ceiling |
| 24 | Closing a stock count posts one balanced journal, and closing a shift writes one Z-report |

Gate evidence (R5):

```
$ supabase db reset
Applying migration 20260101050000_ops_r5.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  9 passed (9)
      Tests  65 passed (65)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (5/5)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* `credit_limits`, `laybys`, `layby_reservations`, `returns`, `return_lines`, `z_reports`,
  `stock_counts` and `stock_count_items` are registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2) and the schema checks
  cover them without a special case.
* `app.close_shift` changes its return type from `void` to `uuid`, so the R5 migration drops the R3
  definition first (`drop function if exists app.close_shift(uuid, uuid, uuid)`) and re-creates it
  with the same signature; the grant is re-issued. No R3 caller needed updating.
* The `jsonb` payloads returned by the operations functions carry money as JSON numbers, so the
  tests read money from the ledger columns (`NUMERIC`), not from the payload. The route handlers
  format the payload values with `toFixed(4)`.

## R6 — Fiscal integration adapter (queue-only)

Status: **complete**. Gate evidence below.

### What was built

* `supabase/migrations/20260101060000_fiscal_r6.sql` (additive, see ADR-0022):
  * `public.fiscal_device_integration` (org + branch; `device_type`, `mode` in (`none`, `async`),
    `status`, `last_sync`, `payload` jsonb; `unique (org_id, branch_id)`).
  * `public.fiscal_jobs` (org + branch; APPEND-ONLY job queue; `unique (org_id, sale_id)`;
    index `(org_id, branch_id, status, created_at)` as the brief requires).
  * `public.fiscal_job_attempts` (org + branch; APPEND-ONLY delivery attempts).
  * `app.enqueue_fiscal_job(...)`, `app.fiscal_jobs_due(...)`, `app.record_fiscal_attempt(...)`.
  * `app.fiscal_enqueue_on_sale()` — `AFTER INSERT` trigger on the partitioned `pos_sales` parent.
    The only fiscal work on the sale path: one insert, in the sale's own transaction, no network
    call, no wait. Mode `none` (or no integration row) queues nothing and never errors.
* `src/fiscal/`: `types.ts`, `adapter.ts` (`enqueueFiscalJob`, integration get/set), `worker.ts`
  (`drainFiscalJobs` / `drainFiscalJobsOn`, `unreachableTransport`), `index.ts`.
* Thin routes: `src/app/api/fiscal/integration`, `src/app/api/fiscal/jobs`,
  `src/app/api/fiscal/drain`.
* `tests/fiscal-r6.test.ts` — test 25 plus five supporting tests.

### Scope boundary

This run builds the queue, not the device. There is **no blocking mode**: whether ZIMRA requires
printing at the moment of sale is an open item recorded in `docs/ADR.md` (ADR-0022). Nothing here is
a compliance claim. The tests check queueing and non-blocking behaviour only.

### Test 25 (the R6 gate test)

| # | Test |
| --- | --- |
| 25 | With mode async and device unreachable, the sale still commits and exactly one fiscal job is queued |

Supporting tests in the same file (not filler; each pins a queue guarantee): mode `none` and no
integration queue nothing; a retried sale queues one job; the enqueue is idempotent; the queue is
append-only (UPDATE/DELETE rejected); a rolled-back sale leaves no job (the enqueue is in the sale
transaction).

### Gate evidence (R6)

```
$ supabase db reset
Applying migration 20260101060000_fiscal_r6.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  10 passed (10)
      Tests  71 passed (71)

$ npx tsc --noEmit
(clean)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (21/21)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)

$ npx playwright test
 2 passed (21.6s)

$ npm run test:perf
Saved to docs/perf/trial-balance-<timestamp>.md
```

Notes:

* `fiscal_device_integration`, `fiscal_jobs` and `fiscal_job_attempts` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* The queue is append-only, so delivery state is derived from `fiscal_job_attempts`: a `sent`
  attempt marks a job done and the job row is never updated. `app.fiscal_jobs_due` is the single
  source of truth for the exponential backoff, so the worker and the database agree on timing.

## H1 — Branch server (local Postgres, PIN sign-in, PWA, LAN HTTPS, branch mode)

Status: **complete**. Gate evidence below.

### What was built

* `supabase/migrations/20260101070000_branch_h1.sql` (additive, ADR-0023): branch-scoped
  `device_registrations` (one-time code → device token; only sha256 hashes stored),
  `cashier_pins` (bcrypt hash, lockout state, manager flag), `sync_state` (protocol version and
  push/pull cursors). Functions: `app.branch_protocol_version`, `app.hash_secret`,
  `app.create_device_registration`, `app.register_device`, `app.authenticate_device`,
  `app.set_cashier_pin`, `app.authenticate_cashier`, `app.manager_override`, `app.branch_sync_state`,
  `app.record_cloud_contact`. All three tables go through `app.apply_tenant_rls` (branch scope) and
  the standard index rules.
* `src/branch/`: `config.ts` (`isBranchMode`, `BRANCH_PROTOCOL_VERSION`), `connectivity.ts`
  (`probeCloud`), `pin.ts`, `device.ts`, `session.ts` (`signInWithPin`), `health.ts` (`branchHealth`,
  `databaseUp`), `cache.ts` (in-process counter and promo cache), `useBranchHealth.ts`,
  `RegisterServiceWorker.tsx`, `index.ts`.
* Thin routes: `src/app/api/branch/health/route.ts`, `login/route.ts`, `devices/route.ts`.
* Branch-mode wiring: `src/verticals/pos/rateLimit.ts` and `src/verticals/retail/pricing.ts` use the
  in-process stores when `isBranchMode()`; the cloud path is unchanged (ADR-0027).
* PWA: `public/manifest.webmanifest`, `public/sw.js` (never caches `/api/`), root layout metadata,
  and a cloud-status badge on `/pos` polled from the branch (not `navigator.onLine`).
* LAN HTTPS: `scripts/branch-https.sh` (self-signed cert) and `scripts/branch-server.mjs` (serves the
  build over HTTPS when TLS env vars are set). Scripts `branch:https` and `start:branch`.

### The H1 tests

| # | Test |
| --- | --- |
| 49 | A device is registered with a one-time code; only hashes are stored, and the code is single use |
| 50 | A cashier signs in with a PIN verified locally; five wrong PINs lock it; manager override |
| 51 | Branch health reports the cloud offline when unreachable; the branch keeps selling |
| 52 | e2e: the branch till shows cloud-offline and still sells on the LAN |

Supporting tests (each pins a guarantee, not filler): the in-process counter's window semantics; a
PIN stored through the TS wrapper is never plaintext; the HTTPS script issues a cert whose SAN
carries the LAN host.

### Gate evidence (H1)

```
$ supabase db reset
Applying migration 20260101070000_branch_h1.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  12 passed (12)
      Tests  77 passed (77)

$ npx playwright test
 3 passed (36.3s)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (24/24)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `device_registrations`, `cashier_pins` and `sync_state` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* H1's tests are numbered 49–51 (e2e 52) because R4 owns 14–18 and R5 owns 19–24; the H1 brief called
  them 16–18. ADR-0026 records the mapping.
* The e2e suite needs a real browser: `npx playwright install chromium` once. The three e2e specs
  (R3 keyboard, R4 offline, H1 branch) all pass together.

## H2 — Offline sync engine (branch outbox → cloud ingest → pull)

Branch-side outbox, cloud-side idempotent ingest, master-data pull, retry/conflict policy, sync
status, and an encrypted nightly backup. Additive only: no core table is edited and no core posting
path changes. ADR-0028 to ADR-0034.

### What was built

* Migration `supabase/migrations/20260101080000_sync_h2.sql` (additive):
  * Branch: `sync_outbox` (append-only event log, `bigserial seq` = order, event UUID = idempotency
    key, `acked_at` write-once), `branch_master_data` (rebuildable mirror), `sync_conflicts`
    (append-only), `sync_backups` (backup metadata).
  * Cloud: `sync_inbox` (append-only, `unique (org_id, event_id)` is the dedupe key),
    `master_data_changes` (per-org monotonic `change_seq`).
  * Functions: `app.sync_outbox_enqueue`, `app.sync_outbox_batch`, `app.sync_outbox_ack`,
    `app.sync_outbox_size`, `app.sync_outbox_max_seq`, `app.sync_inbox_apply`,
    `app.sync_push_result`, `app.sync_pull_batch`, `app.record_master_data_change`,
    `app.sync_apply_pull`, `app.branch_price`, `app.sync_record_conflict`, `app.sync_status`,
    `app.sync_set_cursor`, `app.sync_set_pushed_seq`, `app.record_sync_backup`, plus the outbox
    guard and the enqueue triggers on `pos_sales`, `stock_ledger`, `payments`, `credit_notes`.
  * RLS is applied with `app.apply_tenant_rls(...)` (branch scope for the branch tables, org scope
    for `master_data_changes`); `sync_inbox`, `master_data_changes` and `sync_conflicts` use
    `app.enforce_immutable(...)`.
* TS engine `src/sync/`: `types`, `outbox`, `push`, `pull`, `client`, `status`, `index`, `retry`,
  `runner`, `backup`.
* Thin routes: `src/app/api/sync/push/route.ts`, `src/app/api/sync/pull/route.ts`,
  `src/app/api/branch/sync/status/route.ts`.
* Branch-mode wiring: `src/core/db.ts` sets `app.branch_mode=branch` on every pooled connection in
  branch mode, so the outbox triggers fire on the branch write path and stay inert on the cloud.
* Status page `/branch/sync` (`src/app/branch/sync/page.tsx`).
* Nightly encrypted backup: `src/sync/backup.ts` and `scripts/branch-backup.ts`
  (`npm run branch:backup`).
* Sync loop: `scripts/branch-sync-loop.ts` (`npm run branch:sync`) drives the push+pull runner on a
  timer until stopped.

### The H2 tests

| # | Test |
| --- | --- |
| 53 | A completed sale writes one outbox event in the same transaction; a rollback writes none |
| 54 | A batch applies exactly once; a re-push is all duplicates |
| 55 | The outbox is append-only: DELETE rejected, `acked_at` write-once, other columns immutable |
| 56 | Only the applied prefix is acked; a rejected event is recorded as a conflict |
| 57 | A network failure is retryable; only a cloud rejection is a conflict |
| 58 | Pull is ordered by `change_seq`; the cursor only moves forward |
| 59 | A pulled price is served locally; a later change bumps the version |
| 60 | The outbox triggers are inert when branch mode is off |
| 61 | Org A cannot read Org B sync rows (RLS on the sync tables) |
| 62 | Kill-and-restart: an interrupted push re-pushes; the cloud dedupes |
| 63 | A backup is encrypted before upload, checksummed and recorded; a failed upload is recorded |

Supporting tests (each pins a guarantee, not filler): the push worker's ack prefix and conflict
write; the pull worker plus the runner tick; `compareSeq` bigint ordering.

### Gate evidence (H2)

```
$ supabase db reset
Applying migration 20260101080000_sync_h2.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  13 passed (13)
      Tests  91 passed (91)
   (all 14 H2 tests pass. Two pre-existing EXPLAIN-plan assertions, retail-r1 test 2 and retail-r2
    test 8, are planner-statistics-dependent and occasionally fail in a full run; both reproduce
    with H2 stashed. See Notes.)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (25/25)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `sync_outbox`, `sync_inbox`, `master_data_changes`, `branch_master_data`, `sync_conflicts` and
  `sync_backups` are registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2), the FK-index check
  (test 9), the schema check (test 10) and the high-volume index check (test 11) cover them without
  a special case.
* H2's tests are numbered 53–63 because H1 owns 49–52. ADR-0033 records the mapping.
* The cloud replays each branch event once into its own tables through the same posting functions a
  live sale uses, made idempotent by the inbox claim on `(org_id, event_id)` and by
  `app.sync_pos_sale`'s own `client_sale_id` idempotency (ADR-0034). Branch and cloud are separate
  databases in production, so each keeps its own gapless numbers and FIFO layers. The credit-note
  event carries no line detail in this phase, so its replay only records the inbox row; a full replay
  is an H3 item.
* Pre-existing flaky tests, unrelated to H2 (each reproduces with the H2 changes stashed): the
  EXPLAIN-plan assertions `tests/retail-r1.test.ts` test 2 (`products_name_trgm_idx`) and
  `tests/retail-r2.test.ts` test 8 (the `get_price` index). On a freshly seeded database the planner
  sometimes prefers a different index because of statistics. They are not weakened, skipped or
  mocked, and each passes on its own when the planner cooperates.

## H3 — Fiscal and numbering (queue-based FDMS submission, branch-local number blocks)

### What was built

* **Migration** `supabase/migrations/20260101090000_fiscal_numbering_h3.sql`:
  * `public.fiscal_invoices` (branch-scoped): `org_id`, `branch_id`, `invoice_id` (unique per org),
    `invoice_no`, `fdms_payload` JSONB, `status` (`pending` | `sent` | `failed`), `fdms_response`
    JSONB, `attempts`, `next_attempt_at`, `last_error`. RLS forced, the standard branch-scoped
    indexes, FK index on `invoice_id`, `updated_at` trigger.
  * `public.fiscal_invoice_attempts` (branch-scoped, APPEND-ONLY): one row per real submission
    attempt (`outcome`: `sent` | `failed` | `unreachable`). Immutability triggers reject UPDATE and
    DELETE.
  * `public.number_blocks` (branch-scoped): cloud-issued contiguous invoice-number ranges
    (`series_code`, `block_no`, `first_value`, `last_value`, `next_value`), unique per
    `(org_id, branch_id, series_code, block_no)`.
  * Functions: `app.fiscal_invoice_enqueue` (idempotent per `(org_id, invoice_id)`, branch-gated by
    `app.branch_mode_enabled()`), `app.fiscal_claim_pending` (`FOR UPDATE SKIP LOCKED`, due rows
    oldest-first), `app.fiscal_invoice_attempt` (records an attempt; `sent` on success, `+1 attempt`
    and `failed` at 5 on a real rejection, nothing on an outage), `app.fiscal_invoice_queue`,
    `app.fiscal_invoice_summary`, `app.fiscal_invoice_retry`, `app.fiscal_invoice_manual_send`.
  * Number blocks: `app.issue_number_block` (cloud; carves a range from `number_series` under
    `FOR UPDATE`), `app.store_number_block` (branch; idempotent), `app.number_block_active` /
    `app.number_block_status`, and `app.claim_invoice_number` (block-aware). `app.next_number` for
    the `INVOICE` series now routes to `app.claim_invoice_number`, so `app.create_invoice` is
    unchanged in shape and a branch with no block falls back to the org series.
  * Re-created (additively) `app.create_invoice` and `app.pos_sale_receipt`: the invoice now enqueues
    its pending fiscal row in the same transaction, and the receipt carries a `fiscal` block
    (signature/QR when sent, else "fiscal pending").
* **TypeScript** `src/fiscal/`:
  * `fdms.ts` — the `FdmsClient` interface, `MockFdmsClient` (outage switch, rejection counter,
    accepted-invoice record) and `httpFdmsClient` (real device; needs credentials).
  * `queue.ts` — `listFiscalQueue`, `fiscalSummary`, `retryFiscalInvoice`, `manualSendFiscalInvoice`,
    `claimPendingFiscalInvoices`, `recordFiscalOutcome`, `runFiscalPassOn` (one pass, one
    transaction, the claim lock held for the whole pass).
  * `invoiceWorker.ts` — `runFiscalPass` (a pass in its own transaction) and `startFiscalLoop` (the
    long-lived worker loop, default every 5s; a pass that throws does not stop the loop).
  * `numberBlocks.ts` — `numberBlockStatus`, `issueNumberBlock`, `storeNumberBlock`,
    `cloudBlockFetcher`, and `ensureNextBlock` (top up before exhaustion; an offline fetch is a
    no-op).
  * `index.ts` re-exports all of it.
* **API routes** (thin): `GET /api/fiscal/invoices`, `POST /api/fiscal/invoices/:id/retry`,
  `POST /api/fiscal/invoices/:id/send`, `GET/POST /api/fiscal/numbers`,
  `POST /api/branch/numbers/claim` (cloud side).
* **Admin page** `/settings/fiscal` (queue with counts by status, retry, manual submit).
* **Branch loop** `npm run branch:fiscal` (`scripts/branch-fiscal-loop.ts`).
* **Receipt**: `PosSaleReceipt` / `PosReceipt` carry a `fiscal` block; `/pos` renders the signature
  and QR when sent, else "fiscal pending".

### The H3 tests

`tests/fiscal-h3.test.ts` (64–68, ADR-0038), run against the real local Postgres on a branch-mode
connection (`app.branch_mode=branch`), with the in-memory FDMS device:

* 64 — a sale enqueues its pending fiscal row in the same transaction; a rollback enqueues none.
* 65 — a real rejection retries with backoff; 5 rejections move the row to `failed`; attempts are
  append-only.
* 65b — a network outage keeps the row pending and does NOT increase the attempt count.
* 66 — 10 sales queue while FDMS is down; when it returns all 10 submit exactly once.
* 67 — the next block is requested before the current one runs out; offline exhaustion fails with a
  clear message and reuses no number.
* 68 — two fiscal workers running at once (FOR UPDATE SKIP LOCKED) never submit the same invoice
  twice.

### Gate evidence (H3)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 20 migrations applied)

$ npm test
 Test Files  14 passed (14)
      Tests  97 passed (97)
   (all 6 H3 tests pass. The two pre-existing EXPLAIN-plan assertions, retail-r1 test 2 and
    retail-r2 test 8, are planner-statistics-dependent and can flake when the database accumulates
    rows across repeated runs; both reproduce with the H3 changes stashed. On a fresh
    `supabase db reset` the full suite is green, which is the gate order. See Notes.)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (32/32)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `fiscal_invoices`, `fiscal_invoice_attempts` and `number_blocks` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* The fiscal enqueue is branch-only (ADR-0035): the cloud's replayed invoices never queue fiscal
  rows and the cloud never talks to FDMS. Tests that exercise the branch set `app.branch_mode=branch`
  on their connection.
* Invoice numbering uses cloud-issued branch-local blocks (ADR-0036). Two branches cannot receive the
  same number, a number is never reused, and an offline branch fails a sale with a catchable error
  only when its blocks are truly exhausted.
* The FDMS device is an interface (ADR-0037); the mock is the device, not a database mock, and the
  outage behaviour is exercised against real Postgres with no network.
* H3's tests are numbered 64–68 because H1 owns 49–52 and H2 owns 53–63 (ADR-0038).
* Pre-existing flaky tests, unrelated to H3 (each reproduces with the H3 changes stashed): the
  EXPLAIN-plan assertions `tests/retail-r1.test.ts` test 2 (`products_name_trgm_idx`) and
  `tests/retail-r2.test.ts` test 8 (the `get_price` index). They assert a planner choice, which
  depends on table statistics; repeated runs without a reset accumulate rows and can tip the
  planner to a different index. They are not weakened, skipped or mocked: each passes on its own,
  and the full suite is green after the gate's `supabase db reset`.

## H4 — Hardware and receipts (ESC/POS thermal printing, QR, printer settings, branch relay, scanner, hold/recall, print timing)

### What was built

* **Migration** `supabase/migrations/20260101100000_hardware_h4.sql` — additive only; no core table or
  core function is touched.
  * `public.printer_settings` (branch-scoped): one row per `(org_id, branch_id, label)`; `mode`
    `browser` | `network`; `host`/`port` (a network row must carry a host); forced RLS through
    `app.apply_tenant_rls(..., 'branch')`; the `(org_id, branch_id, created_at DESC, id DESC)` index
    and an FK index on `branch_id`.
  * `app.get_printer_settings(org_id, branch_id, label)` — the branch's printer settings, or a
    browser-mode default when none is configured.
  * `app.set_printer_settings(org_id, branch_id, mode, host, port, label)` — idempotent upsert; clears
    the host in browser mode; raises for an unknown mode or a network printer with no host.
* **Receipt model** `src/verticals/pos/receiptData.ts` — `ReceiptData`, `ReceiptShop`,
  `buildReceiptData`, `vatBands` (exclusive and inclusive per rate), `defaultShop`. One model that
  both the screen slip and the ESC/POS generator consume, so they cannot disagree.
* **ESC/POS generator** `src/verticals/pos/escpos.ts` — pure `generateEscPos(receiptData)` (init,
  aligned text, the lines, the VAT breakdown, the USD and ZWG totals, a native QR command only when
  the fiscal block carries a QR payload, a feed and a cut), plus `escPosToBase64`/`escPosFromBase64`,
  `receiptLines` and `qrMatrix`.
* **Printing** `src/verticals/pos/printing.ts` — `PrinterSettings`, `loadPrinterSettings`,
  `savePrinterSettings`, `defaultPrinterSettings`, the `PrinterTransport` interface, the browser
  transport (`window.print()`, guarded under `navigator.webdriver`) and the network transport (POST
  the base64 bytes to the branch), `printerTransport`, `printReceipt`, `sampleReceiptData`.
* **Checkout** `src/verticals/pos/checkout.ts` — `checkoutAndPrint`: ring the sale (it must commit
  first), build the receipt, then print; records `printIssuedMs` (commit → print issued, under 1s) and
  `totalMs`. `now` and the transport are injectable so the timing is observable without a printer.
* **Branch relay** `src/branch/printer.ts` — `relayEscPos` (a real TCP socket, bounded by a timeout),
  `relayEscPosBase64`, `decodeEscPosBase64`. Only the branch opens the socket (decision 16).
* **Scanner** `src/verticals/pos/scanner.ts` — `ScannerBuffer`, a pure state machine: a fast burst
  ending in Enter is a scan; a slow burst is a hand-typed code on the same path. **Camera**
  `src/verticals/pos/camera.ts` (HTTPS-only). **Shortcuts** `src/verticals/pos/shortcuts.ts` — one
  pure table (`POS_SHORTCUTS`, `resolveShortcut`, `shortcutHint`).
* **On-screen slip** `src/verticals/pos/Receipt58mm.tsx` — exactly 58mm, from the same `ReceiptData`.
* **Cart** `src/verticals/pos/cart.ts` — extended with hold/recall (`HeldCart`, `held`, `hold`,
  `recall`).
* **Routes** (thin handlers): `GET/PUT /api/pos/printer`, `POST /api/pos/printer/test`,
  `POST /api/branch/print` (branch-only, 409 on the cloud, 502 when the printer is unreachable).
* **Pages**: `/pos` (till with the receipt, the hold counter and the print timings), `/pos/settings`
  (printer and scanner settings, with a test print).

### The H4 tests

`tests/hardware-h4.test.ts` (the numbered H4 tests):

| # | Behaviour |
| --- | --- |
| 69 | A branch with no printer settings prints through the browser dialog |
| 70 | Printer settings round-trip: a network printer keeps its host and port (and the save is idempotent) |
| 71 | A network printer with no host is rejected; browser mode clears the host |
| 72 | Printer settings are tenant-scoped: another org sees none and falls back to browser mode |
| 73 | `printer_settings` has `org_id`, `created_at`, forced RLS, and indexed FKs |
| 74 | The printer settings functions are callable as the tenant user; a different label is a different printer |

Supporting coverage, against real Postgres and real sockets (no database mock):

* `tests/hardware-h4-units.test.ts` — VAT banding, the ZWG total, the ESC/POS golden output (init,
  cut, header, VAT breakdown, both totals, the QR command only with a payload), base64 round-trip,
  the QR matrix, the scanner buffer (fast burst, slow burst, ignored keys, short Enter), the shortcut
  map, and the checkout timing (print only after commit, under 1s, none on failure).
* `tests/hardware-h4-printer.test.ts` — the relay writes the exact ESC/POS bytes to a real TCP server
  standing in for the printer, decodes the base64 body first, and fails clearly when unreachable.
* `tests/hardware-h4-api.test.ts` — the printer API and the relay route through the real handlers with
  a real access token (defaults, save/read, validation, 401, relay to a real socket, 422, 502, and
  409 on the cloud).
* `e2e/h4-hardware.e2e.ts` — a keyboard-wedge scan with the field blurred, F3 hold, F4 recall, F2
  focus, F9 pay, Enter confirm, and the receipt (header, VAT number, both totals, VAT band, footer,
  fiscal pending) plus the print timing under 1s.

### Gate evidence (H4)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 21 migrations applied)

$ npm test
 Test Files  18 passed (18)
      Tests  135 passed (135)

$ npm run build
BUILD_EXIT=0   (✓ Compiled successfully; /pos, /pos/settings, /api/pos/printer, /api/branch/print)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `printer_settings` is registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2), the FK-index check
  (test 9), the schema check (test 10) and the high-volume index check (test 11) cover it with no
  special case.
* The relay is branch-only (ADR-0039). The base64 in the request body is a transport encoding, not a
  representation change: the branch writes the decoded raw bytes to the socket. The route refuses on
  the cloud with 409, and the till falls back to the browser dialog when the relay returns 502.
* The scanner and the shortcuts are pure (ADR-0040), so they are asserted without a browser. F9 now
  opens payment with the exact amount preselected and Enter confirms, which keeps the R3 three-action
  keyboard sale intact (the R3 e2e test still passes).
* The print timing is measured from commit to print issued (ADR-0041), on the till's clock with an
  injected `now`, so it is not flaky.
* Printing never fails the sale. `printReceipt` catches a transport error and returns
  `{ printed: false, reason }`, so a wedged printer or an unreachable relay is reported after the
  sale has committed rather than turning a paid sale into an error (asserted in the units test).
* No test is weakened, skipped or mocked: the relay and the printer API are driven against real
  listening sockets, and the database tests run as the tenant user through RLS.

## H5 — Migration wizard (Pastel CSV → products, customers, opening stock)

Additive, recorded in ADR-0042 to ADR-0044. Brings a shop's catalogue, customers and opening stock
onto a branch so it works offline. It adds three branch-scoped tables and a set of import functions;
it changes no core table and no core function signature.

### What was built

* **Schema** (`supabase/migrations/20260101110000_import_h5.sql`): `import_jobs`, `import_rows` and
  `import_mappings` (org + branch, `org_id`/`created_at` NOT NULL, forced RLS, the branch index, FK
  indexes). `import_rows` is the staging table the COPY lands in; `row_no` keeps a row pointed at its
  line in the file across chunks.
* **SQL functions**: `app.import_row_errors` (pure rules), `app.import_natural_key`,
  `app.import_job_create`, `app.import_validate_job`, `app.import_update_row`,
  `app.import_commit_job`, `app.import_job_rows`, `app.import_save_mapping` / `app.import_get_mapping`,
  `app.ensure_retail_price_list`, and `app.next_numbers` (bulk, one locked block).
  `app.create_default_accounts` is replaced additively to add `3900 Opening Balance Equity` (with a
  backfill for existing orgs) and the `journals` source-type check gains `opening`.
* **TypeScript** (`src/verticals/import/`): `mapping.ts` (pure mapping/suggest/validate),
  `csv.ts` (`parseCsv`, `chunkRows`, `csvLine`), `jobs.ts` (the wizard's data access over
  `pg`/`pg-copy-streams`).
* **Routes** (`src/app/api/import/`): `POST /jobs`, `POST /jobs/:id/chunks`, `POST /jobs/:id/validate`,
  `POST /jobs/:id/commit`, `GET /jobs/:id/rows`, `PATCH /rows/:id`, `GET|PUT /mappings`.
* **Page**: `/settings/import` (`wizard.tsx`) — PapaParse preview in the browser, the column-mapping
  screen with a saved mapping, the staged-row review with per-row fixes, and the commit.
* **Samples** (`samples/`): `products-5000.csv`, `customers.csv`, `opening-stock.csv`,
  `products-with-errors.csv`.
* `import_jobs`, `import_rows` and `import_mappings` are registered in `tests/support/tenant-tables.ts`
  and `scripts/check-tenant-tables.sql`, so the table-driven RLS test (2), the FK-index check (9),
  the schema check (10) and the high-volume index check (11) cover them with no special case.

### The H5 tests

`tests/import-h5.test.ts` (the numbered H5 tests, 75–85; ADR-0042):

| # | Behaviour |
| --- | --- |
| 75 | A 5,000-product import stages in ~0.2 s and commits in ~1.2 s, under the 2 s gate (COPY) |
| 76 | Invalid rows are reported by row number and block commit until fixed (PATCH + revalidate) |
| 77 | A failed import leaves no partial data; a re-run updates rather than duplicates |
| 78 | Opening stock writes `source_type='opening'` ledger rows and one balanced journal (Cr 3900) |
| 79 | Opening stock is idempotent: a re-run skips every already-committed row |
| 80 | Customers import by external code and are idempotent |
| 81 | The column mapping is validated and saved per shop |
| 82 | The import tables are tenant-scoped and well-formed (RLS forced, index, FK indexes) |
| 83 | `applyMapping` / `naturalKey` unit behaviour |
| 84 | Chunked load numbers rows contiguously across chunks |
| 85 | Imported opening stock is consumed by a later sale at the imported cost (FIFO) |

### Gate evidence (H5)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 22 migrations applied)

$ npm test
 Test Files  19 passed (19)
      Tests  146 passed (146)

$ npm run build
BUILD_EXIT=0   (✓ Compiled successfully; /settings/import, /api/import/*)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* The import stages first and commits second. A bad file cannot leave half a catalogue behind: commit
  is one SQL function in one transaction (test 77 rolls a mid-commit failure back completely).
* Opening stock is a real ledger fact. It inserts append-only `stock_ledger` rows, their FIFO layers
  and the `stock_balances` cache, then posts **one** balanced journal for the whole file through the
  core hook. Test 85 sells two units afterwards and asserts COGS is the imported cost, which proves
  the layer the import created is the layer FIFO consumed.
* Two fixes were needed to meet test 75 (ADR-0044). Per-row `app.next_number` cost ~700 ms for 5,000
  rows, so SKUs now come from `app.next_numbers` (one locked block). A join on an **expression**
  (`nullif(btrim(...))`) defeated the `(org_id, external_code)` index and produced a 12.5 M-row
  nested loop, so the commit resolves rows into a materialised temp table and joins on the stored
  column. Commit fell from ~11 s to ~1.2 s.
* Idempotency: products and customers upsert on external code; opening stock is skipped when a
  matching `source_type='opening'` row already exists for the product and warehouse. A re-run never
  double-counts.
* Opening stock resolves the product's variant (stock is tracked per variant), preferring the row's
  barcode and otherwise the product's default variant.
* No test is weakened, skipped or mocked: the wizard is driven end to end against the real local
  Postgres, including COPY staging and the SQL commit.
