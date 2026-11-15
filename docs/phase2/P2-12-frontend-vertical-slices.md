# P2-12 — Frontend, as vertical slices (one complete feature per run)

## Scope

Deliver the frontend as **vertical slices**: one complete feature per run, from database to screen,
tested end to end. Not a horizontal "build all the components" pass.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* **P2-08 is done** — the org/branch switcher is the frame every slice renders inside.
* Whichever backend items a slice needs (for example P2-06's dashboard) have landed.

## The slicing rule

> One complete feature per run, from database to screen, tested end to end.

Each run delivers **one** slice and stops. A slice is only done when a user can do the whole thing:
see the data, act on it, and see the result — with tests covering the path.

Do **not** deliver "all the list pages" or "all the forms" in one run. That is horizontal, and it is
explicitly the wrong shape.

## Candidate slices (one per run)

Pick one per run, in roughly this order:

1. **Create a sale** — pick products, see the price, submit, see the invoice and its journal.
2. **View trial balance** — pick a period, see the balances, drill into an account.
3. **Receive stock** — pick a product and warehouse, receive a quantity, see the new layer and journal.
4. **View the dashboard** — the P2-06 surface, rendered.
5. **Stock adjustments** — adjust stock with a reason, see the ledger and journal.

Each slice, when run, is its own prompt instance; the run must state which slice it is doing.

## Requirements per slice

1. **End to end.** Route → server action or API call → core SQL function → rendered result. No
   stubbed data, no TODO placeholders.
2. **Real data.** The slice reads and writes the real database through the Phase 1 core. Nothing is
   mocked.
3. **Money is formatted from `decimal.js` strings**, never from a JS `number`. No float ever reaches
   the screen.
4. **Errors are visible.** If a core function rejects (negative stock, closed period, over-payment),
   the user sees why. Do not swallow errors into a generic toast.
5. **Tests cover the path.** At minimum: the happy path, one rejection path, and the tenant boundary
   (a user in org A cannot see org B's data through the slice).
6. **Accessible.** Labels, focus order, keyboard operable. Reuse the P2-08 components.

## Milestones and gates

Each slice is its own milestone with its own gate. For slice *n*:

**M — slice *n* end to end.**
Gate: the slice's tests pass, all 40 Phase 1 tests still pass, `npm run build` passes,
`npm run lint` passes, `PROGRESS.md` updated with the slice name and gate output, commit.

## Tests (76–80 — one per slice)

76. Create-a-sale slice: the happy path renders the new invoice; a negative-stock rejection shows a
    clear message; an org A user cannot see org B's invoice.
77. Trial-balance slice: the rendered balances match a direct query; the period filter works.
78. Receive-stock slice: the new layer and journal appear; an invalid quantity is rejected visibly.
79. Dashboard slice: the rendered numbers match P2-06's endpoint; `last_refresh` is shown.
80. Stock-adjustment slice: the adjustment posts ledger + journal; a closed-period rejection is
    visible.

Each test must exercise the real path. If a slice is delivered, its test ships with it.

## Out of scope

* A design system or component library beyond what P2-08 established.
* Any backend change that belongs in P2-01…P2-11.
* Horizontal passes ("all forms", "all tables").
* Mobile apps.

## Deliverables

Per slice: the pages/components, the wiring, the slice's test, and a `PROGRESS.md` entry naming the
slice. `README.md` gains a short "frontend slices" note pointing at the switcher frame.

## Open items

* Confirm the slice order with the product owner. This prompt's order is a suggestion, not a
  requirement.
