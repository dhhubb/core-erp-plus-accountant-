# POS key script

The till at `/pos` is keyboard only. No mouse is needed at any point, and the terminal keeps focus
on the scan field so a barcode scanner (which types the code and sends Enter) works with no setup.

## Keys

| Key | Action |
|---|---|
| *(scanner)* `barcode` + `Enter` | Add the scanned item to the cart. One action. |
| `↑` / `↓` | Move the highlight when a search returns more than one match. |
| `F9` | Tender exact cash in USD for the remaining balance. |
| `F10` | Tender exact cash in ZWG for the remaining balance, converted at the rate in force. |
| `Enter` (empty scan field) | Confirm the sale and print the receipt. |
| `Enter` (after printing) | Clear the cart for the next customer. |

## One-item exact cash sale — 3 actions

1. `scan barcode` + `Enter` — the item lands in the cart.
2. `F9` — exact USD cash for the total.
3. `Enter` — confirm and print.

The terminal shows a live `Actions` counter, so the flow is observable on screen and in the
Playwright keyboard test (`tests/pos-r3-keyboard.test.ts`), which performs exactly these three key
events and asserts the counter reads 3 and a receipt with an invoice number appears.

## Split tender

`F9` then `F10` tenders part of the balance in USD and the rest in ZWG. Each tender becomes its own
`pos_payments` row and its own CORE payment; change is recorded in the currency that was given.

## Receipt

The receipt is rendered in the browser (no server call) at 58mm. `@page { width: 58mm }` sizes the
paper, and `@media print` hides the till chrome so only the receipt prints. It shows the lines, the
VAT breakdown by rate, the tenders with change, and the CORE invoice number.
