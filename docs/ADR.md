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
