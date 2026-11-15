# P2-09 — Report summary tables (CONDITIONAL — currently gated OFF)

## Status: do not run

This item is **conditional**. Per the backlog: *"Report summary tables: only if the Phase 1 perf ADR
was triggered."*

**The Phase 1 perf ADR was not triggered.** ADR-0005 records that the 1M-line trial balance came in
comfortably under the 500 ms threshold (one-month ~10 ms with partition pruning and an index;
full-range well under budget). There is therefore no justification for summary tables, and Phase 1
explicitly forbids adding them without an ADR.

**Do not start this prompt until a perf run trips the threshold and a new ADR is written.**

## Trigger condition

Start this prompt only when **all** of the following hold:

1. A `npm run test:perf` run shows the trial balance (or another report named in the trigger) over 1M
   ledger lines taking **more than 500 ms**.
2. The output is committed to `docs/perf/` with the timestamp and the `EXPLAIN ANALYZE` plan.
3. A new ADR is written **before** any code: it names the report, the measured time, the plan, and the
   proposed summary table design.

If those do not hold, this prompt is closed and stays closed.

## Scope (once triggered)

Add the summary table(s) the ADR proposes for the specific slow report — and nothing else.

## Decisions

* One summary table per *measured* slow report. No speculative tables.
* The summary table is **derived and rebuildable** from `journal_lines`. It is never the source of
  truth. A full rebuild must be possible with one SQL statement.
* Refresh strategy (trigger-based, incremental, or `pg_cron`) is decided in the ADR based on the
  report's write/read ratio. If a cron refresh is chosen, follow P2-06's `CONCURRENTLY` + unique-index
  pattern.
* Tenant safety: the same rule as P2-06 — a materialized/summary table cannot carry RLS, so reads go
  through a `security_invoker` wrapper or a filtering function.

## Requirements

1. The new ADR (measured evidence attached).
2. Migration(s) for the summary table, its index, the tenant-safe read path, and the refresh mechanism.
3. The report queries the summary table instead of scanning `journal_lines`.
4. A correctness test: the summary table and a direct `journal_lines` computation agree.

## Milestones and gates

**M1 — ADR + summary table + refresh.**
Gate: tests 65–66 pass, build and lint pass, the report now meets the threshold in a re-run.

**M2 — reconciliation and perf evidence.**
Gate: reconciliation test passes, new `docs/perf/` output saved, `PROGRESS.md` updated, commit.

## Tests (65–66)

65. The summary table matches a direct `journal_lines` aggregation for the same period (no drift).
66. The previously-slow report now runs under the threshold, shown by `EXPLAIN ANALYZE` hitting the
    summary table.

## Out of scope

* Summary tables for reports that are not measured slow.
* Materialized views for the ledger itself.
* Changing Phase 1's decision to query `journal_lines` directly for the reports that are still fast.

## Deliverables

* New ADR with measured evidence.
* Migration(s), refresh mechanism, tenant-safe read path.
* `tests/report-summary.test.ts` (tests 65–66) and `docs/perf/` output.
* `PROGRESS.md` section with the gate output.
