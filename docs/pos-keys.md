# POS key script

The till at `/pos` is keyboard only. No mouse is needed at any point.

## Scanner

A keyboard-wedge barcode scanner is a keyboard: it types the barcode and sends Enter. The till reads
keystrokes at the **document** level, so a scan works no matter what has focus — the cashier does not
have to click into the scan field first, and a scan still works if the field was left blurred. The
same buffer serves a cashier who types a barcode by hand and presses Enter, so there is one code path
for both.

A camera scanner is offered only over HTTPS (`navigator.isSecureContext`). On a plain-HTTP branch LAN
the browser will not grant camera access, so the affordance is hidden rather than shown and failing.

## Keys

| Key | Action |
|---|---|
| *(scanner)* `barcode` + `Enter` | Add the scanned item to the cart. One action. |
| `F2` | Focus the scan field. |
| `F3` | Hold: park the current cart and start a fresh one. |
| `F4` | Recall the most recently parked cart. |
| `F9` | Pay: open payment with the exact cash amount preselected. `Enter` confirms. |
| `F10` | Pay in ZWG: the exact amount, converted at the rate in force. |
| `↑` / `↓` | Move the highlight when a search returns more than one match. |
| `Enter` (empty scan field) | Confirm the sale and print the receipt. |
| `Enter` (after printing) | Clear the cart for the next customer. |

`F9` replaces the old "exact-cash key": it opens payment with the exact amount preselected rather
than tendering immediately, so a cashier can still adjust the amount before confirming. `Enter`
confirms. The mapping lives in `src/verticals/pos/shortcuts.ts`, so the keys and the actions cannot
drift apart.

## One-item exact cash sale — 3 actions

1. `scan barcode` + `Enter` — the item lands in the cart.
2. `F9` — payment opens with the exact USD cash preselected.
3. `Enter` — confirm and print.

The terminal shows a live `Actions` counter, so the flow is observable on screen and in the
Playwright keyboard test (`e2e/pos-keyboard.e2e.ts`), which performs exactly these three key events
and asserts the counter reads 3 and a receipt with an invoice number appears.

## Split tender

`F9` then `F10` tenders part of the balance in USD and the rest in ZWG. Each tender becomes its own
`pos_payments` row and its own CORE payment; change is recorded in the currency that was given.

## Receipt

The receipt is rendered on screen at **58mm** (`Receipt58mm`), from the same data the ESC/POS byte
generator consumes, so the screen slip and the printed slip cannot disagree. It shows the shop logo
and name, the address and VAT number, the receipt number, date and cashier, the lines, the VAT
breakdown (exclusive and inclusive at each rate), the totals in USD and ZWG, the fiscal QR code when
the device returned one, and the footer.

Printing happens after the sale commits, through one of two transports (per branch, stored in
`printer_settings`):

* **browser** — the till renders the 58mm receipt and calls `window.print()`. `@page { width: 58mm }`
  sizes the paper; `@media print` hides the till chrome. This always works with no configuration.
* **network** — the till generates the ESC/POS bytes and asks the **branch** to relay them to the
  printer on the shop LAN (`host:port`, default 9100). Only the branch opens the socket (decision 16:
  outbound only; the cloud has no printer). The bytes travel to the branch as base64 inside JSON — a
  transport encoding, nothing more — and the branch writes the decoded raw bytes to the socket.

`generateEscPos(receiptData)` is pure: the same receipt always yields the same bytes.

Configure the printer at `/pos/settings`, which also has a test-print button. The settings live in
the database, so every till in the branch prints the same way.

## Checking the receipt by hand

The till talks to the API with a user access token, and there is no sign-in UI in this phase, so a
manual run needs a token in `localStorage`. Seed a tenant (any test fixture does this, or use an org
you already have) and mint a token with the same claims the custom access token hook would add:

```bash
node -e '
  const {createHmac}=require("crypto");
  const b=(x)=>Buffer.from(x).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const secret=process.env.SUPABASE_JWT_SECRET||"super-secret-jwt-token-with-at-least-32-characters-long";
  const h=b(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const p=b(JSON.stringify({sub:"<user id>",role:"authenticated",org_id:"<org id>",branch_ids:["<branch id>"],exp:Math.floor(Date.now()/1000)+3600}));
  console.log(`${h}.${p}.${b(createHmac("sha256",secret).update(`${h}.${p}`).digest())}`);
'
```

Then, in the browser console on `/pos`:

```js
localStorage.setItem('pos_access_token', '<the token>'); location.reload();
```

Scan or type a seeded barcode, press Enter, press F9, press Enter. The receipt appears on the right;
`Ctrl+P` (or the browser's print dialog) shows the 58mm layout. `npm run test:e2e` performs the same
flow headlessly and asserts the printed total.
