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
`fiscal_periods`, `number_series`, `settings`, the R1 additions `categories` and
`product_batches`, and the R2 additions `price_lists`, `price_list_items`, `customer_groups`,
`promotions`, `discount_limits`.

Branch-scoped (also `branch_id`): `warehouses`, `stock_ledger`, `stock_consumptions`,
`stock_balances`, `stock_layer_balances`, `stock_transfers`, `journals`, `journal_lines`,
`sales_orders`, `invoices`, `invoice_lines`, `payments`, `credit_notes`, `purchase_orders`,
`audit_logs`, the R2 addition `manual_discounts`, and the R3 additions `shifts`, `pos_sales`,
`pos_payments`.

Partitioned monthly on `created_at`: `journals`, `journal_lines`, `stock_ledger`,
`stock_consumptions`, `audit_logs`, and the R3 addition `pos_sales`. Their primary keys include
`created_at`.

## TypeScript modules

| Module | Exposes |
|---|---|
| `src/core/auth.ts` | `AuthClaims`, `applyUserContext`. |
| `src/core/env.ts` | `databaseUrl`, `testDatabaseUrl`, `required`. |
| `src/core/money.ts` | `money`, `moneyFromSql` (decimal.js). |
| `src/core/sales.ts` | `createInvoice`, `listInvoices`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `InvoiceLineInput`. |
| `src/core/redis.ts` | `getRedis`, `closeRedis`, `redisUrl` (shared ioredis client; `REDIS_URL`, default `redis://127.0.0.1:6379`). |
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

## R2 extension (Retail: pricing and promotions)

Additive, recorded in ADR-0011 to ADR-0013. It does not change core accounting logic; posting still
reads the rate and tax it stores on the line.

* New org-scoped tables: `price_lists` (one `retail`, one `wholesale` per org), `price_list_items`,
  `customer_groups`, `promotions`, `discount_limits`.
* New branch-scoped table: `manual_discounts` (every manual discount with its reason).
* Additive core change: `contacts.group_id` (nullable, `(org_id, group_id)` foreign key).
* `app.get_price(org_id, variant_id, group_id, at_time, qty, subtotal)` — one variant.
* `app.get_prices(org_id, group_id, variant_ids, qtys, at_time, candidates)` — a batched cart.
* `app.apply_promotions(...)`, `app.promotion_candidates(org_id)`, `app.assert_manual_discount(...)`,
  `app.record_manual_discount(...)`, `app.convert_for_display(...)`.
* Precedence: the customer group's price list (falling back to the retail list per item), then
  active promotions by priority (stacking only when stackable), then a manual discount for a role
  whose `discount_limits` row allows it and with a reason.
* `POST /api/pos/price` and `src/verticals/retail/pricing.ts`. Redis caches promotion candidates
  only (key `promos:{org_id}`, TTL 300s), never a resolved price.

## R3 extension (Retail: online POS sale)

Additive, recorded in ADR-0014. It does not change core accounting logic; a sale calls the core
invoice and payment functions.

* New branch-scoped tables: `shifts` (till, `opened_at`, `closed_at`, `opening_float`),
  `pos_sales` (partitioned monthly, PK `(id, created_at)`), `pos_payments` (one row per tender).
* New org-scoped table: `pos_sale_keys` (the idempotency claim, `unique (org_id, client_sale_id)`).
* `app.post_pos_sale(org_id, branch_id, warehouse_id, shift_id, client_sale_id, lines, tenders, ...)`
  — one transaction: resolve lines, price via R2, `app.create_invoice`, one `app.allocate_payment`
  per tender, write `pos_sales` and `pos_payments`. Idempotent on `client_sale_id`.
* `app.open_shift(...)`, `app.list_pos_sales(...)`, `app.pos_sale_receipt(sale_id)`.
* `POST /api/pos/sales`, `GET /api/pos/sales`, `GET /api/pos/shifts`, `POST /api/pos/shifts`, and
  `src/verticals/pos/*` (`sales.ts`, `cart.ts`, `api.ts`). The till at `/pos` is keyboard only.

## R4 extension (Retail: offline outbox and sync)

Additive, recorded in ADR-0015, ADR-0016 and ADR-0017. It does not change core accounting logic; a
synced sale still calls the core invoice and payment functions.

* New branch-scoped table: `pos_sync_exceptions` (where a synced sale that could not post strictly
  is recorded, rather than refused).
* `app.negative_stock_allowed()` — the transaction-local allow-negative hook (ADR-0015). Set only by
  the sync retry, with `set_config('app.allow_negative_stock', 'on', true)`.
* `app.sync_pos_sale(org_id, branch_id, warehouse_id, shift_id, client_sale_id, lines, tenders,
  contact_id, sale_date, local_time, tax_code)` — one call per offline sale. Returns
  `{ outcome: 'committed' | 'duplicate' | 'exception', receipt, exceptions }`. It never rejects a
  completed sale: a duplicate returns the original receipt, a short-stock sale posts through the
  hook, and a moved price or expired promotion is honoured and logged.
* `app.consume_fifo` and `app.create_invoice` are re-created in
  `20260101040000_pos_r4_offline_sync.sql` with the hook added to the availability guard. The
  applied migration is untouched; the newest definition wins.
* `POST /api/pos/sync` (up to 50 sales, one transaction each) and `src/verticals/pos/`:
  `outbox.ts` (IndexedDB store, the client_sale_id generated at sale time, backoff),
  `sync.ts` (the drain loop, one request in flight), `syncServer.ts` (per-sale transaction),
  `rateLimit.ts` (live-sale limiter, Redis counters prefixed by org).
* The live sale endpoint `POST /api/pos/sales` is rate limited to 30 sales/minute/cashier and
  returns `429` with `Retry-After` past that. `POST /api/pos/sync` is exempt, so a backlog is never
  throttled. Redis holds counters only; the ledger is unaffected.

## R5 extension (Retail: operations)

Additive, recorded in ADR-0019, ADR-0020 and ADR-0021. It does not change core accounting logic;
the operational rows are mutable, and the only money that moves is posted through the core posting
functions.

* New org-scoped table: `credit_limits` (one ceiling per customer).
* New branch-scoped tables: `laybys`, `layby_reservations`, `returns`, `return_lines`, `z_reports`
  (immutable), `stock_counts` (partitioned monthly, PK `(id, created_at)`), `stock_count_items`.
* `app.post_balanced_journal(...)` — the balanced-journal hook. An operational journal (a layby
  deposit, a layby cancellation, a return refund) goes through this, not `app.post_journal`
  directly. It asserts the lines balance before delegating, then `app.post_journal` posts.
* `app.check_credit(org_id, contact_id, amount)` — locks the contact `FOR UPDATE`, then refuses a
  sale that would push the open balance past the ceiling. Concurrent checks serialise on the lock.
* `app.create_layby(...)` — reserves the goods (FIFO, so they leave the available pool) and posts
  Dr Bank / Cr Customer Deposits. No revenue yet.
* `app.complete_layby(...)` — writes the invoice for the reserved goods at the reserved cost and
  clears the deposit against AR. It does not call `app.create_invoice` (that would consume FIFO a
  second time).
* `app.cancel_layby(...)` — returns the reserved stock and posts Dr Customer Deposits, Cr Bank
  (refund), Cr Fee Income (the cancellation fee).
* `app.create_return(...)` — locks the original invoice lines in order, checks the unreturned
  quantity, calls `app.create_credit_note` for stock and revenue, and posts the refund (Cr Bank or
  Cr Store Credit).
* `app.close_shift(org_id, shift_id, closed_by)` — re-created from R3 with the same signature; it
  now also writes exactly one immutable `z_reports` row from the shift's sales and tenders.
* `app.create_stock_count(...)`, `app.close_stock_count(...)` — a count snapshots the system
  quantity; closing it posts one core stock adjustment (one journal) for the whole count.
* `GET/POST /api/laybys`, `/api/returns`, `/api/credit-limits`, `/api/stock-counts`, `/api/z-reports`
  and `src/verticals/ops/*` (`laybys.ts`, `returns.ts`, `credit.ts`, `stockCounts.ts`,
  `zReports.ts`).
