# Architecture Decision Records — ERP Core

Format: one section per decision. The Phase 1 spec fixes several decisions already; where a
decision was made *during* implementation (or where an open item exists) it is recorded here.

## ADR-0001 — Balance-check trigger attached to the partitioned `journals` parent

**Context.** The spec requires a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on
`journal_lines` that verifies, at commit, that each journal has at least two lines and that
`sum(base_debit) = sum(base_credit)`. `journals` and `journal_lines` are RANGE-partitioned
monthly on `created_at`. Historically, `CREATE CONSTRAINT TRIGGER` on a partitioned table raised
`"constraint triggers are not supported on partitioned tables"`.

**Decision.** Postgres 17 supports `CREATE CONSTRAINT TRIGGER` on a partitioned table, and the
parent's trigger is automatically cloned onto every partition — including partitions created
*after* the trigger (verified against `supabase start`, PG 17.11). We therefore attach the
deferred balance trigger **once, to the `journals` parent**, and do not write a per-partition
attach helper.

**Consequence.** `ensure_partitions()` needs no trigger bookkeeping. The spec's fallback
("attach the trigger to each partition with a helper function") is not required; this ADR records
that choice. If the project is later pinned to a Postgres version without partitioned constraint
triggers, the fallback becomes mandatory.

## ADR-0002 — Zimbabwe currency code seeded as ZWG

**Context.** The spec is ambiguous between `ZWG` (Zimbabwe Gold, introduced 2024) and `ZWL`
(the older Zimbabwe dollar).

**Decision.** Seed `ZWG` as instructed. `ZWL` remains an open item; no ZWL rows are seeded.

## ADR-0003 — ZIMRA fiscalisation not implemented

**Context.** It is unclear whether ZIMRA requires a specific invoice numbering format or fiscal
device integration. Invoice numbers in Phase 1 are gapless integers from `number_series`.

**Decision.** Neither a ZIMRA-specific format nor fiscal device integration is built. The
numbering abstraction (`number_series` + `next_number()` locked with `SELECT ... FOR UPDATE`)
is the single place a future vertical would hook a fiscal format into.

## ADR-0004 — Rounding residual always posts to the rounding account

**Context.** `base_debit`/`base_credit` are rounded to 4 decimal places per line. Foreign-currency
lines can therefore produce a residual that leaves `sum(base_debit) != sum(base_credit)`.

**Decision.** When a document's posted lines do not balance after per-line rounding, the residual
is posted as an extra journal line against the rounding account named in `settings`
(`rounding_account_code`, default `6999`). The residual is never dropped and never absorbed
silently into an existing line. This is implemented in `post_journal()`.

## ADR-0005 — Trial balance over 1M lines: no summary table in Phase 1

**Context.** The spec forbids materialized views / summary tables in Phase 1, but requires an ADR
if the perf run shows a trial balance over 1M lines takes more than 500 ms.

**Decision.** The perf run (`npm run test:perf`, output in `docs/perf/`) seeds 1,000,000 journal
lines and records the plans. The one-month trial balance prunes to a single partition and uses
`journal_lines_<YYYYMM>_org_id_idx`; the full-range query reads every partition. Both are well
under 500 ms, so no summary table is added in Phase 1.

**Consequence.** Reports keep querying `journal_lines` directly with indexed date-range
predicates. If a future dataset pushes the trial balance past 500 ms, a follow-up ADR proposing a
summary table is the next step; it is not added without one.

## ADR-0006 — Audit rows record the logical table name, not the partition

**Context.** The generic audit trigger fires on `journals` and `stock_ledger`, which are
partitioned. In a row-level trigger `tg_table_name` is the partition (`journals_202611`), so audit
rows would name a different table each month.

**Decision.** `app.write_audit_log()` resolves `tg_relid` through `pg_inherits` and stores the
parent's name (`journals`, `stock_ledger`). A non-partitioned table has no `pg_inherits` row, so
its name is stored unchanged.

## ADR-0007 — The perf seed spreads rows across organisations

**Context.** The perf run must show the one-month trial balance pruning to a single partition and
using an index. If one organisation owned an entire partition, `org_id` would not be selective and
the planner would correctly prefer a sequential scan — an artefact of the seed, not of the schema.

**Decision.** `npm run test:perf` seeds 1,000,000 journal lines across several organisations, so the
partition holds realistic multi-tenant data and the measured plan reflects production. With that
distribution the one-month query prunes to one partition and uses
`journal_lines_<YYYYMM>_org_id_idx`. Timings are recorded, not enforced.

## ADR-0008 — R1 adds columns to the core `products` and `product_variants` tables

**Context.** R1 (Retail: products, barcodes, search) needs a unit of measure, a weighable flag, a
category, and a barcode. The core already owns `products` and `product_variants`, and the standing
rule is that a vertical never edits a core table without an ADR. Putting the barcode on a separate
table was considered, but a barcode identifies a sellable unit (a variant), so it belongs with the
variant, and a partial unique index enforces uniqueness only when a barcode is present.

**Decision.** Extend the core tables additively rather than forking them:

* `products` gains `category_id uuid`, `unit product_unit not null default 'each'`,
  `is_weighable boolean not null default false`, and a generated `name_search tsvector`.
* `product_variants` gains `size`, `color` and `barcode`.
* Two new org-scoped tables, `categories` (nested) and `product_batches` (batch master).
* A `(org_id, name gin_trgm_ops)` GIN index on `products.name`, and
  `app.search_products(org_id, query, limit)`.

All new columns are nullable or have a default, so existing rows and existing core code are
unaffected. No core accounting path is touched.

**Consequence.** `docs/CORE_INTERFACE.md` records the additions. A later vertical that needs its own
product attributes should still prefer its own table keyed on `product_id`, and must write its own
ADR before adding another column to `products`.

## ADR-0009 — Search is a GIN trigram index plus an inlined SQL function

**Context.** The till must find a product by exact barcode, or by a partial name, in well under
100 ms, without loading the catalogue at startup. The name search must stay an index scan as the
catalogue grows, and an `EXPLAIN` of the search must show the index in use.

**Decision.**

* The name predicate is `name ILIKE '%term%'`. That is the operator a `gin_trgm_ops` index serves
  directly, so a substring search stays an index scan rather than scanning the org's whole
  catalogue.
* The index is a single combined GIN index `(org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`,
  so the RLS org predicate and the trigram predicate are served by one index.
* `app.search_products` is `language sql`, `security invoker`, with **no `set search_path` clause**.
  A `set` clause stops the planner inlining a SQL function, and an inlined body is what lets
  `EXPLAIN` show the trigram index. Every object in the body is schema-qualified, so inlining is
  safe.
* The body is a parenthesised `UNION ALL` (barcode hit first, then name hits), not a CTE. A CTE is
  materialised, which hides the constant term from the planner and drops the index.

**Consequence.** `tests/retail-r1.test.ts` asserts the plan contains `products_name_trgm_idx`. The
planner only prefers the trigram index once an org's catalogue is large enough to beat a sequential
scan (measured at roughly 15,000 products in one org), so that test seeds 20,000 rows. Relevance is
`extensions.word_similarity(term, name)`, which ranks a term found inside a longer name above a
merely similar one.

## ADR-0010 — R1 test numbering continues from the core's 40

**Context.** Phase 1 owns tests 1–40 and forbids renumbering. The Phase 2 backlog planned tests
41–44 for rate limiting (P2-01), which is not built.

**Decision.** The R1 run (this one) owns tests 41–44 in `tests/retail-r1.test.ts`. A later run that
implements a different Phase 2 item continues from the highest number actually present, not from a
range reserved in the backlog. Ranges in `docs/phase2/README.md` are indicative, as that document
already states.

**Consequence.** Test numbers are allocated in the order items are actually built, so no number is
skipped and no two runs collide.

## ADR-0011 — R2 adds a nullable `contacts.group_id` column

**Context.** R2 (Retail: pricing and promotions) needs a customer to belong to a group so the group
can map to a wholesale price list. The core already owns `contacts`, and the standing rule is that a
vertical never edits a core table without an ADR.

**Decision.** Extend `contacts` additively with one nullable column, `group_id uuid`, plus a
composite foreign key `(org_id, group_id) -> customer_groups (org_id, id) on delete set null`. The
column is nullable, so every existing row and every core code path is unaffected; a contact with no
group simply resolves at the retail price list. All of R2's own tables (`price_lists`,
`price_list_items`, `customer_groups`, `promotions`, `discount_limits`, `manual_discounts`) are new,
so nothing else in the core is touched.

**Consequence.** `docs/CORE_INTERFACE.md` records the addition. A later vertical that needs more
customer attributes should prefer its own table keyed on `contact_id`, and must write its own ADR
before adding another column to `contacts`.

## ADR-0012 — Promotion candidates are cached in Redis, never prices

**Context.** Pricing must read the org's active promotions on every cart. That is a small read but a
hot one, and the brief allows Redis for the promotion cache. The risk of any cache is serving a
value that the ledger no longer agrees with: a promotion that has been deactivated, or whose window
has closed, must not keep applying.

**Decision.** Redis holds the *candidate* list only (id, type, priority, stackable, validity window,
conditions), under the key `promos:{org_id}` with a 300-second TTL. It never holds a resolved price.
Every evaluation re-checks the validity window against the caller's timestamp inside
`app.apply_promotions`, which is the single implementation used by both the cached path and the SQL
path. A write to `promotions` invalidates the key, but correctness does not depend on invalidation:
a stale entry that still names an expired promotion is filtered out at evaluation time. The cache is
therefore rebuildable from the immutable source at any moment, and losing it only costs one read.

**Consequence.** `tests/retail-r2.test.ts` writes a real Redis key with a real 300s TTL containing an
expired promotion and asserts the price is still the full list price. Redis is not a source of
truth, so no posting path reads it.

## ADR-0013 — Pricing precedence is enforced in one SQL function

**Context.** Precedence is: the customer group's price list (falling back to the retail list), then
active promotions by priority, then a manual discount for a role that is allowed one. If the till,
the cart API and any future channel each implement this, they will drift.

**Decision.** `app.get_price` (single variant) and `app.get_prices` (batched cart) own the ordering,
and `app.apply_promotions` owns the promotion rules (highest priority is the primary; further
promotions apply only when both it and the primary are stackable). `app.assert_manual_discount` owns
the manual-discount cap and the reason requirement. The TypeScript layer only marshals input and
formats output. Both pricing functions are `language sql`, `security invoker`, with no
`set search_path` clause, so the planner can inline them and use the `price_list_items` index.

**Consequence.** A cart of N items costs one batched query (plus, on a cold cache, one candidates
read), never N. `tests/retail-r2.test.ts` counts the round trips and asserts `EXPLAIN` shows
`price_list_items_list_variant_key`.

## ADR-0014 — The POS idempotency key lives on a small claim table, not on `pos_sales`

**Context.** R3 asks for a `unique (org_id, client_sale_id)` constraint on `pos_sales` so that a
retried sale (the terminal re-sends after a dropped response) does not ring twice. `pos_sales` is
also required to be partitioned monthly on `created_at`. Postgres requires every unique constraint on
a partitioned table to include all of the partitioning columns, so `unique (org_id, client_sale_id)`
cannot exist on `pos_sales` — it would have to be `unique (org_id, client_sale_id, created_at)`,
which does not prevent a duplicate with a different `created_at`. This was confirmed against the
running Postgres with a probe table.

**Decision.** The claim is enforced on `pos_sale_keys`, a small non-partitioned org-scoped table with
`unique (org_id, client_sale_id)`. `app.post_pos_sale` inserts the claim as its first statement. A
duplicate key raises a unique violation, the function catches it, looks up the original sale through
the claim row and returns the original receipt unchanged. The retry therefore consumes no invoice
number, takes no stock and posts no second journal. `pos_sales` keeps the required indexes
`(org_id, branch_id, created_at desc, id desc)` and `(org_id, branch_id, shift_id)`.

**Consequence.** `tests/pos-r3.test.ts` retries a sale with the same `client_sale_id` and asserts the
same `sale_id` and `invoice_no` come back and that exactly one `pos_sales` row exists. The unique
constraint the brief asks for exists in the schema, on the table where Postgres can enforce it. The
claim table is mutable in the sense that it is inserted once and never updated; it carries no money
and is rebuildable from `pos_sales`.

## ADR-0015 — The allow-negative hook is a transaction-local GUC read by the core posting functions

**Context.** R4 requires that a sale completed offline is never rejected, even when the stock it
sold is gone by the time it syncs. The core rejects an outbound movement beyond available stock
unless the warehouse's `allow_negative_stock` is set, and that setting belongs to the warehouse, not
to a single caller. Flipping it on the warehouse to accept one backlog sale would permanently permit
overselling for every later sale at that till, which is not acceptable.

`app.create_invoice` and `app.consume_fifo` are the two places that raise `insufficient stock`. They
live in applied migrations, and an applied migration is never edited (AGENTS.md).

**Decision.** Add a transaction-local escape hatch read by those functions:

* `app.negative_stock_allowed()` returns true when the GUC `app.allow_negative_stock` is `on`.
* The R4 migration re-creates `app.create_invoice` and `app.consume_fifo` verbatim, changing only
  the availability guard to `not (coalesce(v_allow_neg, false) or app.negative_stock_allowed())`.
* The sync path sets the GUC for its transaction with `set_config('app.allow_negative_stock','on',
  true)` and only for the retry attempt. The live-sale path never sets it, so the live till keeps
  the strict rule.

Re-creating a function in a new migration is additive: the applied migration is untouched, and the
newest definition wins for every later caller.

**Consequence.** A backlog sale always posts, and the shortfall is valued at the most recent inbound
cost (the existing negative branch of `consume_fifo`). The GUC is transaction-local, so it cannot
leak to another request on the same pooled connection. Every accepted shortfall is written to
`pos_sync_exceptions` as `negative_stock`, so the oversell is visible rather than silent.
`tests/pos-r4.test.ts` test 17 proves the live path still rejects and the sync path accepts.

## ADR-0016 — The sync endpoint never rejects a completed sale; it records an exception

**Context.** An offline till can ring a sale the server would refuse today: the price moved, a
promotion expired, or the stock is gone. The brief is explicit: never reject a completed sale. But
accepting it silently would hide a real disagreement between what the customer was charged and what
the server would charge now.

**Decision.** `POST /api/pos/sync` runs each sale in its own transaction and reports it as
`committed`, `duplicate` or `exception`. Within a sale:

1. A `client_sale_id` that already has a posted sale is a `duplicate`; the original receipt is
   returned and nothing is posted (the `pos_sale_keys` claim of ADR-0014).
2. The charged unit price is kept, never re-priced. When it differs from the current price, a
   `price_variance` row is written to `pos_sync_exceptions`.
3. When the charged price is below the current price and an expired promotion would have explained
   it, a `promotion_expired` row is written and the charged price still stands.
4. When stock is short, the sale is retried with the allow-negative hook (ADR-0015) and a
   `negative_stock` row is written.
5. A sale that cannot post for any other reason (unknown barcode, malformed tender) is reported as
   `exception` and a `rejected` row is written in its own transaction, so it survives the rollback.

Only a malformed sale is refused; a sale that is merely out of date is accepted and logged. The
response carries the per-sale outcome and the ids of any exceptions raised.

**Consequence.** The batch is fault-isolated: one bad sale cannot block the other 49. The till
removes an outbox entry only when the server reports `committed` or `duplicate`, so a `rejected`
sale stays queued for the operator. `tests/pos-r4.test.ts` tests 16 and 17 cover the duplicate and
negative-stock paths.

## ADR-0017 — The offline outbox lives in IndexedDB and syncs one sale per transaction

**Context.** The till must keep selling when the network is down. A completed sale has already
taken the customer's cash, so losing it is not an option, and ringing it twice is not an option
either. The server also has to stay the source of truth: stock, prices and the ledger are decided
there, not on the terminal.

**Decision.**

1. **Storage.** Each offline sale is written to an IndexedDB object store (`erp-pos-outbox`,
   `src/verticals/pos/outbox.ts`) before the network call. IndexedDB is transactional and survives a
   reload, a crash or a flat battery; the cart's in-memory state does not. The entry keeps the
   `client_sale_id` generated at sale time, the `shift_id`, the till's local timestamp, the lines
   with the prices actually charged, the promotions that applied, and the tenders.
2. **Delivery.** `POST /api/pos/sync` accepts up to 50 sales per request. Each sale runs in its own
   transaction on its own pooled connection (`src/verticals/pos/syncServer.ts`), under the caller's
   RLS context, so one bad sale cannot roll back the other 49. The till's drain loop
   (`src/verticals/pos/sync.ts`) keeps exactly one request in flight, so two ticks cannot deliver
   the same sale twice.
3. **Idempotency.** The `client_sale_id` is the idempotency key on both paths (ADR-0014). A sale
   that already posted is a `duplicate`; the original receipt is returned and nothing is posted.
4. **Retries.** An entry is removed from the outbox only when the server reports `committed` or
   `duplicate`. Anything else stays queued and is retried with exponential backoff and full jitter,
   capped at five minutes.
5. **Never reject a completed sale.** A sale that the strict rules would refuse (short stock, moved
   price, expired promotion) is accepted and logged (ADR-0016). The live path keeps the strict
   rules; only the sync path relaxes them, and only through the transaction-local hook (ADR-0015).

**Consequence.** The outbox is a durable client-side queue whose entries are removed only on a
positive server acknowledgement, so the design is at-least-once with server-side deduplication
rather than at-most-once. A duplicate delivery is a no-op, which is the property that makes the
retries safe. `tests/pos-r4.test.ts` covers survival across a reload (test 14), a full drain
(test 15), duplicate delivery (test 16) and the oversell path (test 17); `e2e/pos-offline.e2e.ts`
covers the reload-and-reconnect flow end to end.

## ADR-0018 — Live sales are rate limited in Redis; the sync backlog is exempt

**Context.** A runaway till (a stuck key, a retry loop, a script) can hammer `POST /api/pos/sales`.
The brief allows Redis for counters and the promotion cache, with keys prefixed by `org_id`. It also
requires that a backlog of completed sales never be throttled away.

**Decision.** Live sales are limited to 30 per minute per cashier. The counter is a fixed-window
counter in Redis (`ratelimit:livesale:{org_id}:{branch_id}:{cashier_id}:{window}`), incremented with
`INCR` and given a TTL on first increment, so the key is prefixed by the org and Redis holds a
counter and nothing else. A request past the limit gets `429` with `Retry-After` and the existing
`{"error": "..."}` body.

`POST /api/pos/sync` is deliberately exempt. It carries sales that are already complete; refusing a
backlog would strand money that has already changed hands. Only the live path is limited.

**Consequence.** The limit is per cashier, so one cashier cannot exhaust another's budget, and the
ledger is unaware of the limiter. Losing the Redis keys costs at most a fresh window; nothing
durable lives there. `tests/pos-r4.test.ts` test 18 proves the 31st live sale is `429` while a
100-sale backlog syncs with no `429`.

## ADR-0019 — Operations post through a balanced-journal hook, and the core tables get additive changes

**Context.** R5 (Operations) adds laybys, returns, credit limits, Z-reports and stock counts. Three
of these move money: a layby deposit (Dr Bank, Cr Customer Deposits), a layby cancellation (Dr
Customer Deposits, Cr Bank and Cr Fee Income) and a return refund (Dr AR, Cr Bank or Cr Store
Credit). Every one of them must post a balanced journal, and the ledger must balance at commit.

The brief names the hook `balanced-journal…` (the message was truncated). It also requires that an
operational journal not be posted by calling `app.post_journal` ad hoc from each function, because
a single mistyped line would only be caught at commit by the deferred trigger.

**Decision.**

1. **One hook.** `app.post_balanced_journal(org_id, branch_id, posting_date, source_type,
   source_id, memo, currency, lines)` sums the debits and credits of the incoming lines, raises
   `23514` with a clear message when they differ, and then delegates to `app.post_journal`. Every
   operational journal goes through it. It is an *earlier* guard, not a replacement: the deferred
   `journals` balance trigger still runs at commit.
2. **Additive core changes** (all recorded here because they touch shared tables):
   * `settings` gains `layby_deposit_percent`, `layby_cancellation_fee` and `return_refund_method`.
   * Three new default accounts (`2300 Customer Deposits`, `2400 Store Credit`, `4600 Layby
     Cancellation Fees`) and four new number series (`LAYBY`, `RETURN`, `Z_REPORT`,
     `STOCK_COUNT`) are added to the org-creation triggers. Existing orgs keep what they have; this
     phase creates orgs only through `app.create_org`.
   * `journals.source_type` gains `layby_deposit`, `layby_cancellation` and `return_refund`;
     `stock_ledger.source_type` gains `layby`.
   * A new index `invoices (org_id, contact_id, created_at desc, id desc)` for the credit check's
     open-balance sum and a customer's keyset invoice listing.
3. **Z-reports are immutable.** `z_reports` is forced-RLS and passed through
   `app.enforce_immutable`, like the ledger tables. It is the only thing a daily summary reads;
   there is no materialized view and no running total on each sale.

**Consequence.** Every operational journal is balanced by construction, and the deferred trigger
remains the last line of defence. The additive changes are visible to any later phase. Re-creating
`app.create_default_accounts` and `app.create_default_number_series` in the R5 migration is
additive: the applied migrations are untouched and the newest definition wins.

## ADR-0020 — Credit limits serialise on the contact row, not on the invoice sum

**Context.** A credit limit must hold under concurrency: twenty simultaneous credit sales must not
each read the same headroom and each pass. The naive check (`select sum(total - amount_paid) ...`
then insert) is a classic read-then-write race, because two transactions can read the same sum
before either writes.

**Decision.** `app.check_credit` first takes `select ... from contacts where id = $contact for
update`. That row lock serialises every credit check for one customer, so each transaction sees the
sum the previous one committed. The check then compares `open + amount` against the ceiling and
raises `23514` when it would exceed it. A customer with no `credit_limits` row has no ceiling and is
allowed.

**Consequence.** Credit checks for one customer are serialised (a deliberate cost: correctness over
throughput for a single customer), while different customers never block each other. The lock order
is the contact first, then stock, which is a different resource than the stock lock order, so no new
deadlock cycle is introduced. `tests/ops-r5.test.ts` test 23 proves 20 concurrent 10-unit credit
sales against a 100 ceiling leave exactly 10 committed and the open balance at exactly 100.

## ADR-0021 — A layby reserves stock by consuming FIFO at creation; a stock count posts one journal

**Context.** Two R5 operations touch stock in ways the core functions do not cover.

A layby holds goods aside until collection, but the brief says a reservation is a *mutable
operational row*, not a ledger row. Left as a pure reservation, the goods would still be sellable
to someone else, and the layby could not be collected.

A stock count produces one variance per line. The core `app.post_stock_adjustment` posts one journal
per movement, so a 500-line count would post 500 journals, which is neither reviewable nor what the
brief asks for.

**Decision.**

* **Layby reservation.** `app.create_layby` consumes the FIFO layers at creation, in the core's
  ascending `(warehouse_id, product_id)` lock order, and records the reserved cost on
  `layby_reservations`. The goods therefore leave the available pool immediately. Collection
  (`app.complete_layby`) writes the invoice for the reserved goods at that reserved cost — it does
  not call `app.create_invoice`, which would consume FIFO a second time. Cancellation
  (`app.cancel_layby`) returns the stock as a new inbound layer at the reserved cost.
* **One journal per count.** `app.close_stock_count` writes one ledger row per variance (a new
  inbound layer for a surplus, a FIFO consumption for a shortfall) but posts a **single** journal
  for the whole count: Dr/Cr Inventory against Dr/Cr Inventory Adjustment, aggregated over the
  lines.

**Consequence.** A layby's stock cannot be oversold while it is open, and a large stock count is one
reviewable journal. The reservation is still an operational row: it is mutable (its `status` moves
from `reserved` to `collected` or `released`), which is why it lives outside the immutable ledger
and carries a mutable status rather than a reversing entry. `tests/ops-r5.test.ts` tests 19 to 21
and 24 cover the deposit journal, collection, cancellation and the single count journal.

## ADR-0022 — The fiscal adapter is queue-only, and blocking mode is an open item

**Context.** R6 adds the fiscal integration adapter. The brief is explicit that the mode must not be
chosen by assumption: if the ZIMRA rule requires printing at the moment of sale, the adapter must
stop after the queue is built and the question must be recorded as an open item. The brief also
requires that, beyond inserting a job row, the adapter never sits on the critical path of a sale.

ADR-0003 already records that no ZIMRA-specific format or fiscal device integration was built in
Phase 1. R6 builds the *queue*, not the device.

**Decision.**

1. **Queue-only, mode `none` or `async`.** `public.fiscal_device_integration` carries a per-branch
   `mode` whose check constraint is `mode in ('none', 'async')`. There is deliberately **no
   `blocking` mode** in this run. The constraint rejects any other value, so the decision cannot be
   made by accident, and a blocking mode is a separate future run with its own ADR.
2. **The sale path does one insert and nothing else.** An `AFTER INSERT` trigger on the partitioned
   `pos_sales` parent (`app.fiscal_enqueue_on_sale`) calls `app.enqueue_fiscal_job`, which inserts
   exactly one row into `public.fiscal_jobs` when the branch mode is `async`. It makes no network
   call and waits for nothing. A sale with mode `none`, or with no integration row, is untouched and
   never errors. Because the trigger runs in the sale's own transaction, a committed sale has queued
   its job or has none to queue; a rolled-back sale leaves no job.
3. **The queue is append-only, and delivery state is derived.** `public.fiscal_jobs` and
   `public.fiscal_job_attempts` are passed through `app.enforce_immutable`, exactly like the ledger
   tables: no UPDATE, no DELETE, and the privileges are revoked from `authenticated`. A job row is
   born `queued` and never changes; each delivery attempt appends a row, and a `sent` attempt is what
   marks a job done. `unique (org_id, sale_id)` on `fiscal_jobs` makes "exactly one job per sale"
   hold even if the enqueue is retried.
4. **Backoff lives in SQL.** `app.fiscal_jobs_due` returns the queued, not-yet-sent jobs whose
   exponential backoff (base 30s, capped 1h) has elapsed, so the worker (`src/fiscal/worker.ts`) and
   the database agree on when a job is next due. An unreachable device records an `unreachable`
   attempt; the job stays queued and becomes due again later. It is never dropped and never blocks
   anything else.

**Consequence.** A sale never depends on the fiscal device: it commits whether or not the device can
be reached, and whether or not the device exists. `tests/fiscal-r6.test.ts` test 25 proves that with
mode `async` and an unreachable device the sale commits and exactly one job is queued, and the
adapter tests check queueing and non-blocking behaviour only — never compliance.

### Open item — does ZIMRA require printing at the moment of sale?

This is **not** decided here, and the adapter stops short of it. If the ZIMRA rule turns out to
require the fiscal receipt to be printed (or the device to acknowledge) *at the moment of sale*,
then a **blocking mode** is needed: the sale would have to wait for the device before committing.
That is a separate future run. It would add a `blocking` value to the mode constraint, a transport
with a real timeout, and a decision about what a sale does when the device does not answer (refuse
the sale, or fall back to `async`). None of that is built now, and nothing in this run should be read
as a compliance claim. The numbering abstraction (`number_series` + `next_number()`, ADR-0003) and
the job queue built here are the two places such a run would hook into.

## ADR-0023 — Branch mode is one codebase and one migration set, switched by `BRANCH_MODE`

**Context.** H1 makes a branch able to run on a shop LAN with the internet down. The obvious
alternative is a separate branch codebase, or a branch-only migration set. Both would drift: the
branch would slowly diverge from the cloud, and the schema would have two truths.

The brief fixes the deployment shape: a branch runs a custom Next.js server (not Supabase's own
server), with a local Postgres and a local PIN sign-in, and the cloud keeps Supabase Auth, Realtime
and Redis.

**Decision.**

1. **One codebase, one build, two modes.** `src/branch/config.ts` reads `BRANCH_MODE` (`cloud` by
   default; `branch` when explicitly set). Every branch-only behaviour is behind `isBranchMode()`.
   The cloud behaviour is the default, so an unset variable is never branch mode.
2. **One migration set.** A branch runs the same `supabase/migrations/` as the cloud. H1 adds only
   *additive* tables and functions; it edits no applied migration and no core accounting path. The
   brief is explicit: a vertical (and a branch) may depend on core functions but must never edit core
   tables without an ADR. The branch-only tables (`device_registrations`, `cashier_pins`,
   `sync_state`) live in the same public schema, tenant-scoped and RLS-forced like every other.
3. **The branch serves the build itself.** `scripts/branch-server.mjs` serves the same Next.js build
   over HTTPS on the LAN when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set, and over HTTP otherwise. The
   cloud keeps `next start`. `scripts/branch-https.sh` issues the self-signed LAN certificate.

**Consequence.** A cloud change is automatically a branch change, and a schema change is applied
identically on both sides. The cost is that branch-only code paths must be guarded, which the
`isBranchMode()` checks make explicit and testable.

## ADR-0024 — A device is registered with a one-time code, and only hashes are stored

**Context.** A till must be able to talk to the branch, and the branch must be able to tell one till
from another. The brief requires the same care as an invite token: single use, expiring, and stored
hashed, with no plaintext in the table.

**Decision.**

1. `app.create_device_registration(...)` mints a random code, stores **only its sha256 hash**
   (`code_hash`) and an expiry (24 hours by default), and returns the raw code once. The raw code is
   never written to a column.
2. `app.register_device(...)` redeems the code **once**: it locks the row `FOR UPDATE`, rejects a
   consumed, expired or unknown code, and on success stores **only the sha256 hash of the issued
   device token** (`device_token_hash`). The raw token is returned once.
3. `app.authenticate_device(...)` verifies a token by comparing its hash, and rejects a revoked
   device. `unique (code_hash)` and `unique (device_token_hash)` make a collision impossible to
   mistake for a valid redemption.
4. The pattern mirrors `app.create_invite`/`app.accept_invite` (M1), which the brief points at.

**Consequence.** `tests/branch-h1.test.ts` test 49 asserts that neither the code nor the token
appears in the table, that both stored values are 64-hex digests, and that a second redemption of the
same code fails. A database dump cannot be used to impersonate a till.

## ADR-0025 — The branch and the cloud carry a sync protocol version, and a mismatch blocks push

**Context.** The branch and the cloud evolve independently. A branch that pushes an event shape the
cloud does not understand must not corrupt the cloud, and a cloud that has moved on must not silently
misread an old branch. The brief makes this decision 17: the branch must refuse to push to a cloud
whose version it does not understand, and show a warning.

**Decision.**

1. The branch carries a protocol version: `app.branch_protocol_version()` in SQL (a constant) and
   `BRANCH_PROTOCOL_VERSION` in `src/branch/config.ts`. The two must be bumped together, in a
   migration, with an ADR.
2. `probeCloud` (in `src/branch/connectivity.ts`) compares the cloud's reported version to the
   branch's. A reachable cloud on a different version yields `incompatible`; a reachable cloud on the
   same version yields `online`; anything unreachable yields `offline`.
3. The branch stores its observation in `public.sync_state` (`cloud_status`,
   `cloud_protocol_version`, `last_cloud_contact_at`), so a health read does not have to reach the
   cloud. An `incompatible` status sets `push_blocked`, and the till shows a version-mismatch warning
   while still selling locally.
4. The cloud is master: the branch is the one that must be upgraded.

**Consequence.** A version skew is visible on the till and stops the push, rather than corrupting the
cloud. `tests/branch-h1.test.ts` test 51 covers `online`, `offline` and `incompatible`.

## ADR-0026 — H1 test numbering continues from 48, and the H1 spec's 16–18 map to 49–51

**Context.** The H1 brief numbers its tests 16, 17 and 18. Those numbers are already taken: R4 owns
tests 14–18 and R5 owns 19–24. ADR-0010 already fixed the rule: a new run continues from the highest
number actually present, not from a range reserved elsewhere.

**Decision.** H1 owns **49, 50 and 51** in `tests/branch-h1.test.ts`, plus supporting tests in the
same file and `tests/branch-https.test.ts`. The mapping is:

| H1 spec | Canonical | Test |
| --- | --- | --- |
| 16 | 49 | A device is registered with a one-time code; only hashes are stored, single use |
| 17 | 50 | A cashier signs in with a local PIN; five wrong PINs lock it; manager override |
| 18 | 51 | Branch health reports the cloud offline when unreachable; the branch keeps selling |
| — | 52 | e2e: the branch till shows cloud-offline and still sells on the LAN (`e2e/branch-offline.e2e.ts`) |

**Consequence.** No number is reused and no test is dropped. The H1 spec's numbers are recorded here
so a reader following the brief can find the right test.

## ADR-0027 — Redis is cloud-only; a branch uses in-process caches and the local database

**Context.** The brief makes decision 13: a branch has no Redis. Redis in this codebase is never a
source of truth; it holds a promotion *candidate* cache (R2) and a live-sale *rate-limit counter*
(R4). Both must keep working on a branch with no Redis.

**Decision.**

1. `src/branch/cache.ts` provides an in-process, TTL-aware map with the same fixed-window semantics
   as the Redis counter (`INCR` + `EXPIRE`, TTL set only when the window opens) and a `PromoCache`
   stand-in.
2. `redisCounterStore()` (R4) returns the in-process store when `isBranchMode()`, and the Redis store
   otherwise. The cloud path is byte-for-byte unchanged.
3. `defaultPromoCache()` (R2) returns the in-process cache when `isBranchMode()`, and the Redis cache
   otherwise. The promotion validity window is still re-checked in SQL at evaluation time on both
   sides, so an in-process entry cannot apply an expired promotion.
4. Nothing else in the branch reads Redis. The branch's durable state is its local Postgres, which
   carries the same immutable ledger.

**Consequence.** A branch needs only its own Postgres. The caches rebuild from the database on a
miss, so a restart loses nothing that matters. `tests/branch-h1.test.ts` covers the counter's window
semantics.
