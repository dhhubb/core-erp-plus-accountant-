import Decimal from 'decimal.js';
import type { PosReceipt } from './cart';
import {
  buildReceiptData,
  defaultShop,
  type ReceiptData,
  type ReceiptShop,
} from './receiptData';
import {
  printerTransport,
  printReceipt,
  type PrintResult,
  type PrinterSettings,
  type PrinterTransport,
} from './printing';

/**
 * The till's checkout path (H4): ring the sale, then print, as one orchestrated step.
 *
 * The sale POST commits first; only once it has committed is the receipt built and the print
 * issued. The two timings the brief cares about are recorded here, on the till's own clock:
 *   * `printIssuedMs` — from the sale commit to the moment the print call is issued (must be under
 *     1 second; the sale path never waits on the printer), and
 *   * `totalMs` — from the start of the sale to the print being issued (the whole keyboard sale,
 *     scan included, must finish under 3 seconds on a branch).
 *
 * `now` and the transport are injectable, so the timings are observable in a test without a real
 * printer, and the same code path runs in the browser.
 */

export interface CheckoutTimings {
  /** The moment the sale committed (the POST resolved). */
  committedAt: number;
  /** The moment the print call was issued. */
  printIssuedAt: number;
  /** The print was issued this many milliseconds after the sale committed. */
  printIssuedMs: number;
  /** The whole checkout (sale start to print issued), in milliseconds. */
  totalMs: number;
}

export interface CheckoutResult {
  receipt: PosReceipt;
  receiptData: ReceiptData;
  print: PrintResult;
  timings: CheckoutTimings;
}

export interface CheckoutDeps {
  /** Ring the sale; resolves once the server has committed it. */
  postSale: () => Promise<PosReceipt>;
  /** The branch's printer settings (browser dialog or network printer). */
  settings: PrinterSettings;
  /** An explicit transport, for a test or a caller that already chose one. Defaults from settings. */
  transport?: PrinterTransport;
  cashier: string;
  /** ZWG per 1 USD, for the receipt's secondary total. */
  zwgRate: Decimal;
  shop?: ReceiptShop;
  /** The receipt's date. Injected so a test is reproducible. */
  date?: Date;
  /** The clock, injectable for timing assertions. Defaults to `Date.now`. */
  now?: () => number;
}

/** Ring the sale, build the receipt and print it. The sale always commits before any printing. */
export async function checkoutAndPrint(deps: CheckoutDeps): Promise<CheckoutResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  // The sale posts and commits. Nothing about printing happens until this resolves.
  const receipt = await deps.postSale();
  const committedAt = now();

  const receiptData = buildReceiptData(receipt, {
    shop: deps.shop ?? defaultShop(),
    cashier: deps.cashier,
    zwgRate: deps.zwgRate,
    date: deps.date ?? new Date(),
  });

  // Issue the print. `printIssuedAt` is taken before the transport runs, so it measures the delay
  // from commit to the print being issued, not how long the printer took.
  const printIssuedAt = now();
  const transport = deps.transport ?? printerTransport(deps.settings);
  const print = await printReceipt(receiptData, transport);

  return {
    receipt,
    receiptData,
    print,
    timings: {
      committedAt,
      printIssuedAt,
      printIssuedMs: printIssuedAt - committedAt,
      totalMs: now() - startedAt,
    },
  };
}
