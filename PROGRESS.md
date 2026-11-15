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
| M3 | Inventory | tests 25–31 | todo |
| M4 | Sales & purchases + concurrency | tests 32–40 | todo |
| M5 | Hardening (audit, checks, perf, README) | verification list | todo |

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

## Notes / decisions recorded in docs/ADR.md

* ADR-0001 Deferred balance-check trigger on the partitioned `journals` parent (PG17 clones the
  parent's constraint trigger onto every new partition, so no per-partition attach helper is needed).
* ADR-0002 ZWG seeded as the Zimbabwe currency code (ZWL open item).
* ADR-0003 ZIMRA fiscalisation format unknown — not built this phase.
* ADR-0004 Rounding residual posts to the rounding account from settings, never dropped.
