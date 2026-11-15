# P2-05 — Pharmacy readiness: lot, batch and expiry hooks in the core inventory model (ADR)

## Scope

This is an **ADR-first** item. The backlog says: *"design lot, batch, and expiry hooks in the core
inventory model as an ADR … before the first vertical module. Retrofitting batch tracking into FIFO
later is costly."*

So the deliverable is a design decision plus the **minimal core hooks** that let a Pharmacy vertical
track lots/batches/expiry later **without editing core tables**. It is not a Pharmacy module.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* Phase 1 FIFO: `stock_ledger` (append-only movements) + `stock_consumptions` (which inbound layer
  each outbound consumed) + `stock_layer_balances` (remaining qty per inbound layer). Layers are
  consumed oldest-first and are never updated.
* The Phase 1 rule still holds: a vertical depends on core **functions**, and never edits core tables
  without an ADR. This item is the ADR that makes that possible for batch tracking.

## The decision to write

The ADR must answer, concretely:

1. **Where does lot identity live?** Options: (a) a nullable `lot_id` on the inbound layer tables
   (`stock_ledger` / `stock_layer_balances`), (b) a separate `inventory_lots` table keyed by
   `(org_id, product_id, lot_code, expiry_date)` with the layer referencing it, or (c) a vertical-owned
   side table joined by `(ledger_id, created_at)`. Recommend one and justify it against FIFO.
2. **How does FIFO interact with expiry?** Pharmacy usually wants **FEFO** (first-expired-first-out),
   which is FIFO with expiry as the sort key. Decide whether the core `consume_fifo` ordering becomes
   pluggable (an order-by strategy) or whether the vertical re-implements consumption. Prefer making
   the ordering pluggable so the core stays the single consumer of layers.
3. **Immutability.** `stock_ledger` and `stock_consumptions` are append-only. Lot attributes attached
   to a movement must therefore be immutable too. If a lot's expiry is corrected, that is a new
   movement, not an update.
4. **Partitioning.** `stock_ledger` is partitioned by `created_at`; any lot FK must respect the
   composite-key pattern Phase 1 already uses.
5. **Migration path.** Exactly which columns/tables a Pharmacy vertical adds, and the fact that it
   adds them rather than the core pre-adding empty columns. Pre-adding unused columns is acceptable
   only if the ADR argues for it.

## Requirements

1. `docs/ADR.md` gets the new ADR (next free number).
2. **Only the hooks the ADR says are needed** are implemented. If the ADR concludes the core needs a
   nullable lot reference and a pluggable FIFO ordering, implement exactly that and nothing more.
3. Whatever is implemented must not break Phase 1 FIFO: all 40 Phase 1 tests still pass.
4. If the ADR decides a change needs no code yet, that is a valid outcome — say so plainly and add a
   "deferred" note to the ADR rather than writing speculative code.

## Milestones and gates

**M1 — the ADR.**
Gate: the ADR is complete, answers the five questions above, and is reviewed. No code required for
this gate.

**M2 — the minimal hooks, if the ADR calls for them.**
Gate: tests 54–55 pass, all 40 Phase 1 tests still pass, build and lint pass, `PROGRESS.md` updated,
commit.

## Tests (54–55)

54. If a lot reference is added: an inbound layer can carry a lot, and an outbound consumption records
    which lot it drew from, with no change to the Phase 1 FIFO result when no lot is set.
55. If pluggable ordering is added: the default ordering reproduces Phase 1 FIFO exactly, and a
    supplied FEFO-style ordering changes which layer is consumed without changing any core table.

If the ADR defers all code, tests 54–55 are recorded as "not applicable — deferred by ADR-<n>" in
`PROGRESS.md`, and the numbering is not reused by another prompt.

## Out of scope

* The Pharmacy module itself, its UI, or its migrations (that is a later vertical prompt).
* Expiry alerting, recalls, or regulatory reporting.
* Any change to how the ledger balances.

## Deliverables

* A new ADR in `docs/ADR.md`.
* Minimal hook migrations/function changes, only if the ADR calls for them.
* `tests/lot-hooks.test.ts` (tests 54–55), or the documented deferral.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm with the product owner whether Pharmacy needs FEFO or plain FIFO. The ADR must state the
  assumption it is designed around.
