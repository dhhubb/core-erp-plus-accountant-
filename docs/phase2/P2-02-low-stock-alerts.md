# P2-02 — Low-stock alerts (a view backed by an index on stock_balances)

## Scope

Give the app a way to answer "what is below its reorder level?" without scanning balances. The
answer is a **view backed by an index on `stock_balances`**, not a background job and not a new
materialized view.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* `stock_balances` is the mutable, rebuildable cache from Phase 1. Its uniqueness is
  `(org_id, warehouse_id, product_id, variant_id) NULLS NOT DISTINCT` (`stock_balances_key`).

## Decisions

* **Reorder level is a property of the product, not of the balance.** Add
  `products.reorder_level numeric(19,4)` (nullable). A per-warehouse override is out of scope for
  this prompt; if it is ever needed, it becomes its own ADR because it changes the key shape.
* The alert view is a **plain view**, `public.low_stock`, filtered to `is_active` products whose
  on-hand `qty` is at or below `reorder_level`. Plain views are allowed here; Phase 1's ban on
  materialized views for the trial balance was about the ledger, and this view is cheap and
  indexed.
* The view must be **RLS-aware**: because a view runs with the privileges of its owner by default,
  mark it `security_invoker = true` so the caller's RLS on `stock_balances` and `products` applies.
  Without this the view would leak other tenants' rows. This is the crux of the item.
* Support the index the view needs. Add a partial/composite index that lets the planner find
  at-or-below rows without a full scan, and prove it with `EXPLAIN` in a test.

## Requirements

1. Migration adding `products.reorder_level` and the `low_stock` view (`security_invoker = true`).
2. An index that the view's predicate can use. If the predicate is `qty <= reorder_level` across two
   tables, the practical index is on `stock_balances (org_id, warehouse_id, product_id)` plus the
   existing product index; document exactly which index the planner picks and why.
3. Keyset-paginated list endpoint `GET /api/low-stock` with the Phase 1 pagination contract:
   `(created_at, id)` cursor, default limit 50, maximum 100, no `OFFSET`.
4. `EXPLAIN` evidence committed to `docs/perf/` showing an index path, not a sequential scan of
   `stock_balances`, for a single-warehouse query.

## Milestones and gates

**M1 — schema: column, view, index.**
Gate: tests 45–46 pass, build and lint pass.

**M2 — endpoint and EXPLAIN evidence.**
Gate: test 47 passes, build and lint pass, EXPLAIN output saved, `PROGRESS.md` updated, commit.

## Tests (45–47)

45. A product at or below its reorder level appears in `low_stock`; one above it does not.
46. The view is tenant-safe: an Org A user querying `low_stock` sees no Org B rows (this is the RLS
    test; it fails if `security_invoker` is forgotten).
47. `EXPLAIN` of the single-warehouse low-stock query shows an index path on `stock_balances`, not a
    sequential scan.

## Out of scope

* Sending the alerts anywhere (email, webhook, push). This prompt only produces the query surface.
* Low-stock *notifications* and any scheduler — that is a separate prompt if wanted.
* Per-warehouse reorder overrides.
* Materialized views.

## Deliverables

* Migration(s) under `supabase/migrations/`.
* `GET /api/low-stock` route handler (thin).
* `tests/low-stock.test.ts` (tests 45–47).
* `docs/perf/low-stock-explain-<timestamp>.md`.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm whether the reorder level is per product or per product-per-warehouse. This prompt assumes
  per product; changing it needs an ADR because it changes the uniqueness key.
