# Core interface

This is the contract a vertical module (Retail, Pharmacy, Hardware, School) or a later phase builds
on. It lists what the core exposes, what a caller may rely on, and what must not change without an
ADR.

Nothing here is new behaviour: it documents the interface that the Phase 1 migrations already
implement, so a fresh run can extend the core without reading every migration.

## Rules that bind every caller

* Extend, do not rewrite. Add migrations and modules; never edit an applied migration.
* Never edit a core table without an ADR. Additive changes (new nullable column, new index, new
  function) still need an ADR, because they change a shared table.
* Money is `NUMERIC(19,4)` in Postgres and `decimal.js` in TypeScript. No floats, ever.
* Ledger tables are immutable. A correction is a reversing row (`reversal_of`), never an update or
  delete.
* Business logic lives in SQL functions under the `app` schema. TypeScript route handlers stay thin.
* Tests run against the real local Postgres. Nothing is mocked.

## SQL functions (schema `app`)

Call these; do not reimplement them.

| Function | Purpose |
|---|---|
| `app.next_number(org_id, series_key)` | Gapless number from `number_series`, locked `FOR UPDATE`. Used for invoice numbers and SKUs. |
| `app.post_journal(...)` | Posts a balanced journal; rounds base amounts to 4 dp and posts any residual to the rounding account. |
| `app.reverse_journal(journal_id, ...)` | Posts a reversing journal whose `reversal_of` points at the original. |
| `app.post_receipt(...)` | Inbound stock layer plus a balanced journal (Dr Inventory, Cr Accounts Payable). |
| `app.post_stock_adjustment(...)` | Ledger rows plus a balanced journal, in one transaction. |
| `app.consume_fifo(...)` | Consumes the oldest layer first; writes `stock_consumptions` rows. |
| `app.create_invoice(...)` | Gapless number, sorted stock locks, FIFO consumption, invoice + lines, balanced journal. |
| `app.allocate_payment(...)` | Applies a payment to invoices, capped at the open balance. |
| `app.create_credit_note(...)` | Reverses revenue, VAT and AR; returns stock at the original FIFO cost. |
| `app.ensure_partitions(months_ahead int)` | Creates monthly partitions ahead of now. |
| `app.apply_tenant_rls(regclass, scope, allow_write)` | Enables and forces RLS on a tenant table with the standard policies. |
| `app.assert_period_open(...)` | Raises if a date falls in a closed fiscal period. |

## Access predicates

* `app.has_org_access(org_id)` — true when the JWT claim `org_id` matches.
* `app.current_branch_ids()` — the JWT claim `branch_ids`.
* Claims come from `auth.jwt() ->> 'org_id'` and `auth.jwt() -> 'branch_ids'`, populated by the
  Supabase custom access token hook (`app.custom_access_token_hook`).

Membership changes take effect on token refresh, not before. This is documented in `README.md`.

## Tables

Org-scoped (no `branch_id`): `organizations`, `branches`, `memberships`, `invites`, `products`,
`product_variants`, `contacts`, `chart_of_accounts`, `tax_rates`, `exchange_rates`,
`fiscal_periods`, `number_series`, `settings`, and the R1 additions `categories` and
`product_batches`.

Branch-scoped (also `branch_id`): `warehouses`, `stock_ledger`, `stock_consumptions`,
`stock_balances`, `stock_layer_balances`, `stock_transfers`, `journals`, `journal_lines`,
`sales_orders`, `invoices`, `invoice_lines`, `payments`, `credit_notes`, `purchase_orders`,
`audit_logs`.

Partitioned monthly on `created_at`: `journals`, `journal_lines`, `stock_ledger`,
`stock_consumptions`, `audit_logs`. Their primary keys include `created_at`.

## TypeScript modules

| Module | Exposes |
|---|---|
| `src/core/auth.ts` | `AuthClaims`, `applyUserContext`. |
| `src/core/env.ts` | `databaseUrl`, `testDatabaseUrl`, `required`. |
| `src/core/money.ts` | `money`, `moneyFromSql` (decimal.js). |
| `src/core/sales.ts` | `createInvoice`, `listInvoices`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `InvoiceLineInput`. |
| `src/app/api/_lib.ts` | `withAuth`, `parseLimit`, `parseCursor` for thin handlers. |

## Vertical modules

A vertical lives in its own folder (`src/verticals/<name>/`) with its own migrations
(`supabase/migrations/<timestamp>_<name>_*.sql`). It depends only on the functions above. See
`README.md` → "Adding a vertical module".

## R1 extension (Retail: products, barcodes, search)

Additive, recorded in ADR-0008. It does not change core accounting logic.

* New org-scoped tables: `categories` (nested via `parent_id`), `product_batches` (batch master).
* New columns on `products`: `category_id`, `unit` (`product_unit` enum), `is_weighable`,
  `name_search` (generated `tsvector`).
* New columns on `product_variants`: `size`, `color`, `barcode` (partial unique per org).
* `app.search_products(org_id, query, limit)` — exact barcode first, then a trigram name match,
  backed by a `(org_id, name gin_trgm_ops)` GIN index. At most 20 rows.
* `GET /api/pos/search?q=` and `src/verticals/retail/*`.
