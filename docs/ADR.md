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

**Decision.** Recorded by the perf run in `docs/perf/`. See that output; if the one-month trial
balance exceeds 500 ms a follow-up ADR proposing a summary table will be written. The one-month
query is required to prune to a single partition and use an index; the full-range query may
sequentially scan.
