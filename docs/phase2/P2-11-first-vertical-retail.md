# P2-11 — First vertical module: Retail

## Scope

Build the first vertical module, **Retail**, on top of the Phase 1 core. This is the proof that the
core is generic: the vertical lives in **its own folder and its own migrations**, depends only on core
**functions**, and does not edit core tables.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* **P2-05 (pharmacy readiness ADR) is done**, because it fixes how verticals attach to the inventory
  model (lot hooks, pluggable FIFO ordering). Retail is simpler than Pharmacy, but it must use the
  same attachment pattern so Pharmacy can follow.
* The Phase 1 README section "how to add a vertical module" is the contract. Follow it; if it is
  wrong, fix the README **and** say so in the ADR, rather than diverging silently.

## The core rule

> A vertical depends only on core functions. It never edits core tables without an ADR.

So Retail:

* Owns its own tables (for example `retail_promotions`, `retail_price_overrides`,
  `retail_loyalty_accounts` — whatever the scope needs).
* Calls core functions such as `app.create_invoice`, `app.allocate_payment`, `app.post_receipt`,
  `app.post_stock_adjustment` rather than writing to `journals`, `stock_ledger`, `invoices`, etc.
* Adds its migrations under a vertical-specific path so a deployment can include or exclude them.

## Suggested scope (confirm before building)

Keep the first vertical small but end-to-end. A reasonable Retail slice:

1. **Retail price lists / overrides** — a per-branch price for a product that overrides the base
   price, applied when a sale is created.
2. **A promotion** — for example "buy N get M free" or a percentage discount on a category —
   applied at invoice creation.
3. **Loyalty accrual** — points earned on a completed sale, stored in a Retail table.

Anything beyond this is a second vertical prompt. Resist scope creep; the point is to prove the
pattern, not to ship a full POS.

## Requirements

1. `src/verticals/retail/` (or the path the README specifies) for domain code, and a
   `supabase/migrations/` sub-path for Retail migrations.
2. Retail reads core data through core functions/views. If a core function is missing a hook Retail
   needs, **add a narrowly-scoped core function in a core migration** and record the addition in the
   ADR — do not reach into core tables.
3. If any core table must change, that is an ADR-first change, not a silent edit.
4. Retail has its own tests and they run against real Postgres like everything else.
5. All 40 Phase 1 tests still pass unchanged.

## Milestones and gates

**M1 — Retail schema + core-function integration.**
Gate: tests 69–71 pass, all 40 Phase 1 tests still pass, build and lint pass.

**M2 — Retail behaviour (pricing, promotion, loyalty).**
Gate: tests 72–74 pass, build and lint pass.

**M3 — isolation proof and docs.**
Gate: test 75 passes (the vertical does not touch core tables directly), `README.md` vertical section
confirmed or corrected, `PROGRESS.md` updated, commit.

## Tests (69–75)

69. A Retail price override changes the invoice line price for that branch, and the core still posts a
    balanced journal.
70. The override does not affect other branches or other orgs.
71. A promotion applies the expected discount and the journal still balances (VAT and rounding
    included).
72. Loyalty points accrue on a completed sale and are stored in a Retail table, not a core table.
73. A rolled-back Retail sale leaves no partial Retail rows (mirrors Phase 1 test 36).
74. Retail works through the core's gapless numbering: two concurrent Retail sales get two distinct
    invoice numbers.
75. **Isolation:** Retail's migrations create/modify no core table (assert by diffing the core schema
    before and after Retail migrations, or by asserting the Retail migration set touches only
    `retail_*` objects). This is the test that protects the core.

## Out of scope

* POS hardware, receipts printing, cash drawer, offline mode.
* Other verticals (Pharmacy, Hardware, School) — each is its own prompt.
* Editing core tables. If Retail seems to need it, write the ADR first and stop for review.

## Deliverables

* `src/verticals/retail/**` and Retail migrations.
* Any narrowly-scoped core function added, with its ADR entry.
* `tests/retail.test.ts` (tests 69–75).
* `README.md` vertical section confirmed/corrected.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm the Retail scope (pricing, promotions, loyalty) with the product owner before M1.
* Confirm whether Retail prices are per branch or per org. This prompt assumes per branch.
