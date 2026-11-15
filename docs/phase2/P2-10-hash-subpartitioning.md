# P2-10 — Hash sub-partitioning of `stock_ledger` by org (CONDITIONAL — currently gated OFF)

## Status: do not run

This item is **conditional**. Per the backlog: *"Hash sub-partitioning: stock_ledger by org hash,
only if measured need appears."*

**No measured need currently exists.** Phase 1 explicitly deferred hash-by-org sub-partitioning
("Do not add hash-by-org sub-partitioning in this phase"), and nothing since has produced a
measurement that calls for it. The monthly RANGE partitioning on `created_at` is working.

**Do not start this prompt until a measurement justifies it and a new ADR is written.**

## Trigger condition

Start this prompt only when **all** of the following hold:

1. A measurement exists showing `stock_ledger` (or a specific query pattern against it) is too slow
   **for reasons that sub-partitioning would actually fix** — for example, an org-scoped scan within a
   single monthly partition still reads far more than it should, and the plan shows it.
2. The measurement is committed to `docs/perf/` with `EXPLAIN ANALYZE`.
3. A new ADR is written **before** any code, comparing the alternatives: a better index, a covering
   index, `CLUSTER`/fillfactor tuning, partition pruning improvements, and finally hash
   sub-partitioning. Hash sub-partitioning is the last resort, not the first.

If those do not hold, this prompt is closed and stays closed.

## Why this is the last resort

Sub-partitioning a partitioned table is a heavy, invasive change:

* It multiplies the number of physical relations (monthly × org buckets) and every partition must be
  created and maintained by `ensure_partitions`.
* It changes the primary key to include the hash key, which ripples into every foreign key that
  references `stock_ledger` — including the composite `(id, created_at)` pattern Phase 1 uses.
* It interacts with the immutability triggers and the RLS policies, all of which are per-partition.
* Reversing it is expensive. An index is cheap and reversible.

An ADR must argue why a cheaper option cannot solve the measured problem.

## Scope (once triggered)

Sub-partition `stock_ledger` by hash of `org_id`, as the ADR specifies, and update everything that
depends on its shape.

## Requirements

1. The new ADR (measured evidence + rejected alternatives).
2. Migration(s) converting `stock_ledger` to RANGE(created_at) → HASH(org_id). Because you cannot
   convert a populated partitioned table in place, the migration creates the new table, copies, and
   swaps — and the ADR states the downtime/backfill expectation.
3. `app.ensure_partitions` updated to create and maintain the sub-partitions.
4. Composite foreign keys, immutability triggers, RLS policies, and indexes re-applied to the new
   shape.
5. All 40 Phase 1 tests still pass, especially the partitioning and immutability ones.

## Milestones and gates

**M1 — ADR + new partitioned shape + migration.**
Gate: tests 67–68 pass, all 40 Phase 1 tests still pass, build and lint pass.

**M2 — verification and perf evidence.**
Gate: the measured query now meets its target, new `docs/perf/` output saved, `PROGRESS.md` updated,
commit.

## Tests (67–68)

67. The new shape preserves Phase 1 behaviour: inserts route to the correct month **and** org bucket;
    pruning still works on `created_at`; immutability triggers still reject UPDATE/DELETE.
68. The measured query now performs within its target, shown by `EXPLAIN ANALYZE`.

## Out of scope

* Sub-partitioning any table other than `stock_ledger`.
* Hash partitioning by anything other than `org_id`.
* Changing the monthly RANGE partitioning on `created_at`.

## Deliverables

* New ADR with measured evidence and rejected alternatives.
* Migration(s) and `ensure_partitions` changes.
* `tests/stock-ledger-subpartition.test.ts` (tests 67–68) and `docs/perf/` output.
* `PROGRESS.md` section with the gate output.
