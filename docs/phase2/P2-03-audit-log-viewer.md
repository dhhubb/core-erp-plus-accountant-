# P2-03 — Audit log viewer (read-only, paginated)

## Scope

Expose `audit_logs` for reading. Phase 1 writes audit rows through a generic trigger and nothing on
a request path reads them; this prompt adds the read path. It is **read-only**.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* `audit_logs` is RANGE-partitioned monthly on `created_at`, has `org_id`/`branch_id`, and Phase 1
  revoked `insert, update, delete` from `authenticated`. That revoke stays.

## Decisions

* **Read-only means read-only.** The endpoint has no `POST`, `PATCH`, or `DELETE`. Do not "un-revoke"
  anything to make it work; if a query needs elevated access, fix the query, not the grants.
* Pagination is keyset on `(created_at, id)`, matching Phase 1. Default limit 50, maximum 100.
* Because the table is partitioned, a query with a date range must prune. The viewer always sends a
  bounded range (default: last 30 days) and the plan must show pruning.
* Filters: `table_name`, `action`, `record_id`, and `actor_id`. Each is optional; none may turn into
  an unbounded scan. Any filter the planner cannot use an index for must be applied after the
  indexed range/keyset predicate, not instead of it.
* `diff` is `jsonb`. Return it as-is but cap its size per row (for example truncate the serialized
  diff at a documented byte limit) so one large row cannot blow up a page.

## Requirements

1. `GET /api/audit-logs` with the Phase 1 pagination and error contract, thin handler.
2. An index that supports the viewer's access pattern. `audit_logs` already has the branch-scoped
   `(org_id, branch_id, created_at desc, id desc)` index from Phase 1; add only what is missing and
   prove the plan.
3. RLS still applies: the viewer returns only rows the caller's JWT allows. Do not bypass RLS.
4. An `EXPLAIN` test asserting partition pruning for a bounded range.

## Milestones and gates

**M1 — endpoint and pagination.**
Gate: tests 48–49 pass, build and lint pass.

**M2 — plan verification and size caps.**
Gate: test 50 passes, build and lint pass, EXPLAIN evidence saved, `PROGRESS.md` updated, commit.

## Tests (48–50)

48. The viewer returns only the caller's org rows; an Org A user never sees Org B audit rows.
49. Keyset pagination returns every matching row exactly once across pages, with a stable order on
    `(created_at, id)`.
50. A bounded-range query prunes to the expected partitions and uses an index (assert on the
    `EXPLAIN` output).

## Out of scope

* Any write path, redaction, or retention policy for audit rows.
* Full-text search over `diff`.
* An export/download endpoint.

## Deliverables

* `GET /api/audit-logs` route handler (thin).
* Any index migration, with justification.
* `tests/audit-viewer.test.ts` (tests 48–50).
* `docs/perf/audit-viewer-explain-<timestamp>.md`.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm the retention window shown by default and whether the viewer must hide rows older than a
  retention cutoff. Not built here.
