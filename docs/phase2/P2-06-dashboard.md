# P2-06 — Dashboard (`dashboard_stats` materialized view, refreshed every 2 minutes by pg_cron)

## Scope

Build the dashboard data surface: a `dashboard_stats` materialized view, refreshed every 2 minutes by
`pg_cron`. Target: **under 100 ms with 1M ledger rows, verified with `EXPLAIN ANALYZE`**.

This is the item that Phase 1 deliberately deferred. Phase 1 forbade materialized views and said a
summary table needs an ADR; this prompt is that work, done now that it is in scope.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* `pg_cron` is available and preloaded in the local stack (verified: `pg_cron 1.6.4`). If a hosted
  environment does not have it, the refresh must degrade to a documented manual/SQL-callable
  function rather than silently never refreshing.
* The Phase 1 perf harness (`scripts/perf.ts`, `npm run test:perf`) can seed 1M journal lines. Reuse
  it; do not write a second seeder.

## Decisions

* `dashboard_stats` is a **materialized view**, and it is the one place materialization is allowed,
  because the dashboard is explicitly a read-mostly, 2-minute-fresh surface.
* Refresh is `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which needs a unique index on the matview. A
  plain `REFRESH` takes an exclusive lock and would block dashboard reads; do not use it.
* The scheduler is `pg_cron`, running every 2 minutes. The schedule is created in a migration and is
  idempotent (`cron.schedule` with a stable job name).
* The matview is org-scoped and must not leak across tenants. Materialized views cannot have RLS, so
  the matview is **not** exposed directly to `authenticated`. Reads go through a `security_invoker`
  wrapper view or a function that filters by the caller's `org_id`/`branch_ids`. State this clearly
  and test it.
* Freshness is bounded by the 2-minute refresh. The dashboard endpoint must report the
  `last_refresh` timestamp so a client can see how stale the numbers are.

## Requirements

1. Migration creating `dashboard_stats` (matview), its unique index, the tenant-safe read wrapper,
   and the `pg_cron` schedule.
2. `GET /api/dashboard` (thin) returning the caller's org/branch slice plus `last_refresh`.
3. A `test:perf` extension that seeds 1M journal lines and runs `EXPLAIN ANALYZE` on the dashboard
   read, saving output to `docs/perf/`. The run **records** the timing; it fails only if the plan is
   wrong (no matview hit, or a seq scan of `journal_lines`).
4. The refresh function is callable directly (`select app.refresh_dashboard_stats()`), so tests and
   a future environment without pg_cron can trigger it.

## Milestones and gates

**M1 — matview, index, tenant-safe read.**
Gate: tests 56–57 pass, build and lint pass.

**M2 — pg_cron schedule and perf run.**
Gate: test 58 passes, the perf run saves `docs/perf/dashboard-<timestamp>.md` showing the read under
100 ms with 1M rows, build and lint pass, `PROGRESS.md` updated, commit.

## Tests (56–58)

56. The dashboard read returns only the caller's org/branch rows (tenant isolation through the
    wrapper; the raw matview is not reachable by `authenticated`).
57. The refresh function updates the numbers: after posting a journal, calling refresh changes the
    dashboard totals accordingly.
58. With 1M seeded journal lines, the dashboard read completes under 100 ms and the `EXPLAIN ANALYZE`
    shows it hitting `dashboard_stats`, not scanning `journal_lines`.

## Out of scope

* Dashboard UI (a placeholder is fine; the visual dashboard is P2-12 / a later slice).
* Charts, exports, or drill-down endpoints.
* Anything that makes the ledger depend on the matview — the ledger stays the source of truth and
  the matview is rebuildable at any time.

## Deliverables

* Migration(s) for the matview, index, wrapper, and cron schedule.
* `app.refresh_dashboard_stats()` and `GET /api/dashboard`.
* `tests/dashboard.test.ts` (tests 56–58).
* `docs/perf/dashboard-<timestamp>.md`.
* An ADR entry recording the matview, the CONCURRENTLY refresh, the 2-minute schedule, and the
  tenant-isolation approach.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm the exact metric set the dashboard needs (revenue, margin, stock value, receivables…). This
  prompt assumes the minimum: period revenue, period COGS, receivables, and stock value.
