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
