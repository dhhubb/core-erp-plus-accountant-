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
three actions headlessly and asserts the printed total.

