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

## R6 extension (Fiscal integration adapter)

Additive, recorded in ADR-0022. It does not change core accounting logic. The adapter is **queue
only**: a sale appends at most one job row, and a worker delivers jobs later. There is no blocking
mode in this run — whether ZIMRA requires printing at the moment of sale is an **open item** in
`docs/ADR.md`.

* New branch-scoped tables: `fiscal_device_integration` (per-branch device config and `mode`:
  `none` or `async`), `fiscal_jobs` (APPEND-ONLY job queue; `unique (org_id, sale_id)`),
  `fiscal_job_attempts` (APPEND-ONLY delivery attempts).
* `app.enqueue_fiscal_job(org_id, branch_id, sale_id, invoice_id)` — inserts exactly one job when
  the branch mode is `async`, and nothing otherwise. Idempotent per `(org_id, sale_id)`.
* `app.fiscal_enqueue_on_sale()` — the `AFTER INSERT` trigger on the partitioned `pos_sales`
  parent. It is the only fiscal work on the sale path: one insert, in the sale's own transaction,
  no network call and no wait.
* `app.fiscal_jobs_due(org_id, branch_id, now, limit, base_seconds, max_seconds)` — the queued,
  not-yet-sent jobs whose exponential backoff has elapsed (base 30s, capped 1h). Delivery state is
  derived from `fiscal_job_attempts`, so a job row is never updated.
* `app.record_fiscal_attempt(org_id, branch_id, job_id, outcome, error)` — appends one delivery
  attempt (`sent`, `failed` or `unreachable`); the job row is locked `FOR UPDATE` while the attempt
  number is computed.
* TypeScript: `src/fiscal/` (`types.ts`, `adapter.ts`, `worker.ts`, `index.ts`).
  `enqueueFiscalJob` queues a job; `drainFiscalJobs` / `drainFiscalJobsOn` run a delivery pass;
  `unreachableTransport()` reports `unreachable` without any network call.
* Endpoints: `GET/PUT /api/fiscal/integration`, `GET /api/fiscal/jobs`, `POST /api/fiscal/drain`.

## H1 extension (Branch server foundation)

Additive, recorded in ADR-0023 to ADR-0027. It does not change core accounting logic; a branch runs
the same migrations and the same posting functions as the cloud. Everything here is guarded by
`BRANCH_MODE=branch` (default `cloud`), so the cloud path is unchanged.

* New branch-scoped tables: `device_registrations` (a one-time code that mints a device token; only
  hashes stored), `cashier_pins` (a bcrypt PIN hash, lockout state, manager flag), `sync_state`
  (the branch's sync protocol version and push/pull cursors).
* `app.branch_protocol_version()` — the branch/cloud sync protocol version (constant; bump with the
  TypeScript constant and an ADR).
* `app.create_device_registration(org_id, branch_id, till_id, ttl_hours)` — mints a one-time code,
  stores only its sha256 hash, returns the raw code once.
* `app.register_device(org_id, branch_id, code, label)` — redeems the code once; stores only the
  hash of the issued device token, returns the raw token once.
* `app.authenticate_device(org_id, branch_id, token)` — verifies a device token by hash; rejects a
  revoked device.
* `app.hash_secret(secret)` — sha256 hex, the hash used for codes and device tokens.
* `app.set_cashier_pin(org_id, branch_id, cashier_id, pin, is_manager)` — stores a bcrypt hash.
* `app.authenticate_cashier(org_id, branch_id, cashier_id, pin)` — verifies a PIN locally; five
  wrong attempts lock it for 15 minutes. Returns jsonb (`ok`, `locked`, `failed_attempts`,
  `locked_until`, `is_manager`); never raises for a wrong PIN.
* `app.manager_override(org_id, branch_id, manager_id, pin)` — true only for a correct manager PIN.
* `app.branch_sync_state(org_id, branch_id)` — ensures and returns the branch's sync state as jsonb.
* `app.record_cloud_contact(org_id, branch_id, cloud_version, online)` — stores the branch's
  observation of the cloud; a version mismatch marks it `incompatible`.
* TypeScript: `src/branch/` (`config.ts`, `connectivity.ts`, `pin.ts`, `device.ts`, `session.ts`,
  `health.ts`, `cache.ts`, `useBranchHealth.ts`, `RegisterServiceWorker.tsx`).
  `isBranchMode()` gates every branch-only path. `probeCloud` compares protocol versions.
  `signInWithPin` mints a branch access token after a local PIN check.
* Endpoints: `GET /api/branch/health` (also probed by the cloud; reachable without a token so it
  answers when auth is broken), `POST /api/branch/login` (local PIN sign-in), `POST /api/branch/devices`
  (`action: create | register | verify`).
* PWA: `public/manifest.webmanifest`, `public/sw.js` (never caches `/api/`), `/pos` shows a
  cloud-status badge polled from the branch (not `navigator.onLine`).
* `scripts/branch-https.sh` issues a self-signed LAN certificate; `scripts/branch-server.mjs` serves
  the build over HTTPS when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set. `npm run start:branch`.
* Redis is cloud-only (ADR-0027): `redisCounterStore()` and `defaultPromoCache()` return in-process
  stores when `isBranchMode()`.

## H3 extension (Fiscal and numbering)

Additive, recorded in ADR-0035 to ADR-0038. It does not change core accounting logic; a branch runs
the same migrations and the same posting functions as the cloud. The fiscal enqueue is guarded by
`app.branch_mode_enabled()` (default off), so the cloud path is unchanged.

* New branch-scoped tables: `fiscal_invoices` (the FDMS submission queue; one pending row per
  invoice, unique per `(org_id, invoice_id)`; `status` `pending` | `sent` | `failed`; `fdms_payload`,
  `fdms_response`, `attempts`, `next_attempt_at`, `last_error`), `fiscal_invoice_attempts`
  (APPEND-ONLY delivery attempts; `outcome` `sent` | `failed` | `unreachable`), `number_blocks`
  (cloud-issued contiguous invoice-number ranges; unique per `(org_id, branch_id, series_code,
  block_no)`).
* `app.fiscal_invoice_enqueue(org_id, branch_id, invoice_id)` — inserts exactly one pending fiscal
  row in the caller's transaction, and nothing unless `app.branch_mode` is on. Idempotent per
  `(org_id, invoice_id)`. Called by `app.create_invoice` and `app.pos_sale_receipt`.
* `app.fiscal_claim_pending(org_id, branch_id, limit)` — the pending rows due now, oldest first,
  `FOR UPDATE SKIP LOCKED`. The caller holds the transaction so the lock covers the submission.
* `app.fiscal_invoice_attempt(org_id, branch_id, id, outcome, response, error)` — records one real
  submission. `sent` marks the row sent with its response; `failed` increments `attempts` and sets
  the backoff, moving to `failed` at 5; `unreachable` leaves the row pending and does NOT touch
  `attempts`. Appends a `fiscal_invoice_attempts` row for every call.
* `app.fiscal_invoice_queue(...)`, `app.fiscal_invoice_summary(...)`,
  `app.fiscal_invoice_retry(...)`, `app.fiscal_invoice_manual_send(...)` — the admin reads and
  actions (keyset page, counts by status, re-arm a failed row, submit a row now).
* Number blocks: `app.issue_number_block(org_id, branch_id, series_code, size)` (CLOUD; carves a
  range from `number_series` under `FOR UPDATE`), `app.store_number_block(...)` (branch; idempotent),
  `app.number_block_active(...)`, `app.number_block_status(...)`, and `app.claim_invoice_number(...)`
  (the next number from the branch's oldest block with numbers; raises `'invoice number block
  exhausted...'` when none is left). `app.next_number` for the `INVOICE` series routes to
  `app.claim_invoice_number`; a branch with no block falls back to the org series.
* TypeScript: `src/fiscal/fdms.ts` (`FdmsClient`, `MockFdmsClient`, `httpFdmsClient`, `fdmsCredentials`),
  `src/fiscal/queue.ts` (`listFiscalQueue`, `fiscalSummary`, `retryFiscalInvoice`,
  `manualSendFiscalInvoice`, `claimPendingFiscalInvoices`, `recordFiscalOutcome`, `runFiscalPassOn`),
  `src/fiscal/invoiceWorker.ts` (`runFiscalPass`, `startFiscalLoop`),
  `src/fiscal/numberBlocks.ts` (`numberBlockStatus`, `issueNumberBlock`, `storeNumberBlock`,
  `cloudBlockFetcher`, `ensureNextBlock`).
* Endpoints: `GET /api/fiscal/invoices`, `POST /api/fiscal/invoices/:id/retry`,
  `POST /api/fiscal/invoices/:id/send`, `GET/POST /api/fiscal/numbers`,
  `POST /api/branch/numbers/claim` (cloud). Page `/settings/fiscal`.
* Loop: `npm run branch:fiscal` (`scripts/branch-fiscal-loop.ts`).
