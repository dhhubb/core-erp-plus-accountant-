# Phase 2 backlog — prompts, milestones and gates

This directory holds one prompt per Phase 2 work item. Each prompt is self-contained: hand it to a
fresh run on its own, and that run should be able to complete the item without reading the others.

## Precondition — Phase 1 gates

Every prompt below assumes **all Phase 1 gates pass on the current commit**. Before starting any
Phase 2 prompt, re-verify on a clean database and paste the output into `PROGRESS.md`:

```
supabase db reset
npm test                 # expect: Tests 40 passed (40)
npm run build            # expect: Compiled successfully
npm run lint             # expect: No ESLint warnings or errors
psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql     # expect: 0 rows
psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql  # expect: 0 rows
```

If any of these fail, stop. Phase 2 does not start on a red Phase 1.

## Test numbering

Phase 1 owns tests 1–40. Phase 2 numbers continue from **41**. Each prompt states its own range and
must not renumber or reuse Phase 1 tests. A Phase 2 prompt may add a `test:perf`-style command; those
runs are recorded, not counted.

## Ordering and dependencies

```
P2-01 rate limiting ─────────────┐
P2-02 low-stock alerts ──────────┤
P2-03 audit log viewer ──────────┤
P2-04 settings cache ────────────┼──> P2-11 first vertical module (Retail)
P2-05 pharmacy ADR ──────────────┤        (depends on P2-05 as an ADR, not as code)
P2-06 dashboard_stats (matview) ─┤
P2-07 realtime ──────────────────┤
P2-08 invite UI + switcher ──────┘
P2-09 report summary tables  ── conditional, currently gated OFF
P2-10 hash sub-partitioning  ── conditional, currently gated OFF
P2-12 frontend vertical slices ── after P2-08 (needs the switcher)
```

Hard ordering rules, taken from the backlog text:

1. **P2-05 (pharmacy readiness ADR) comes before P2-11 (the first vertical module).** Retrofitting
   lot/batch/expiry tracking into FIFO after the fact is costly, so the design is fixed first.
2. **P2-09 (report summary tables) runs only if the Phase 1 perf ADR was triggered.** It was not:
   ADR-0005 records that the 1M-line trial balance came in under 500 ms. P2-09 stays closed until a
   future perf run trips the threshold.
3. **P2-10 (hash sub-partitioning of `stock_ledger`) runs only if a measured need appears.** No
   measurement currently justifies it.
4. **P2-11 (Retail) depends only on core functions** and must not edit core tables without an ADR.

## Items

| # | Item | Type | Tests | Depends on |
|---|------|------|-------|------------|
| P2-01 | Rate limiting (Upstash Redis) | feature | 41–44 | Phase 1 |
| P2-02 | Low-stock alerts (indexed view) | feature | 45–47 | Phase 1 |
| P2-03 | Audit log viewer (read-only, paginated) | feature | 48–50 | Phase 1 |
| P2-04 | Settings cache (`unstable_cache`, invalidated on write) | feature | 51–53 | Phase 1 |
| P2-05 | Pharmacy readiness: lot/batch/expiry hooks (ADR) | ADR + design | 54–55 | Phase 1 |
| P2-06 | Dashboard (`dashboard_stats` matview, pg_cron every 2 min) | feature + perf | 56–58 | Phase 1 |
| P2-07 | Realtime (branch-scoped subscriptions) | feature | 59–61 | Phase 1 |
| P2-08 | Invite UI + org/branch switcher | feature | 62–64 | Phase 1 |
| P2-09 | Report summary tables | **conditional** | 65–66 | perf ADR triggered |
| P2-10 | Hash sub-partitioning (`stock_ledger` by org) | **conditional** | 67–68 | measured need |
| P2-11 | First vertical module: Retail | feature | 69–75 | P2-05 |
| P2-12 | Frontend vertical slices | feature | 76–80 | P2-08 |

Test ranges are indicative; each prompt fixes its exact list. Do not pad a range to hit a count, and
do not drop a listed test.

## Rules carried over from Phase 1

These still bind every Phase 2 prompt:

* Money is `NUMERIC(19,4)` and `decimal.js`. No floats anywhere in the schema.
* Ledger tables stay immutable. A correction is a reversing row.
* No `any` in `src/accounting/**` (ESLint error).
* Tests run against real Postgres. Nothing is mocked.
* List endpoints use keyset pagination on `(created_at, id)`; never `OFFSET`.
* Settings and tax/rounding values must not sit in a 10-minute stale cache — see P2-04.
* Route handlers stay thin; business logic lives in SQL functions.
* Commit at the end of every milestone, and keep `PROGRESS.md` current.
