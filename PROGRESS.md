# PROGRESS — ERP Core Phase 1 (Backend)

Repo root: `/workspace/project`
Stack: Next.js 14 (App Router) · TypeScript strict · Supabase (local Postgres 17 + Auth) · Vitest · `pg`
Schema: plain SQL migrations in `supabase/migrations/` (no Prisma).

## Status

| Milestone | Scope | Gate | State |
|-----------|-------|------|-------|
| M0 | Setup | build passes on empty app | DONE |
| M1 | Tenancy (RLS, indexes, partitions) | tests 1–14 | DONE |
| M2 | Accounting | tests 15–24 | DONE |
| M3 | Inventory | tests 25–31 | DONE |
| M4 | Sales & purchases + concurrency | tests 32–40 | DONE |
| M5 | Hardening (audit, checks, perf, README) | verification list | DONE |

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
