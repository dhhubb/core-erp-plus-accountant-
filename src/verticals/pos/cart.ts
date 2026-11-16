import Decimal from 'decimal.js';
import { create } from 'zustand';

/**
 * Cart state for the till. Zustand only — no server call holds the cart, so a scan is instant and
 * the terminal keeps working while a sale posts.
 *
 * Money stays a decimal string end to end: the till never turns a price into a JS number.
 */

export interface CartLine {
  key: string;
  variantId: string;
  barcode: string | null;
  name: string;
  qty: Decimal;
  unitPrice: Decimal;
  taxRate: Decimal;
  lineSubtotal: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
}

export interface CartTender {
  method: 'cash' | 'card' | 'mobile' | 'voucher';
  currency: 'USD' | 'ZWG';
  amountTendered: Decimal;
}

export interface PosReceiptLine {
  lineNo: number;
  description: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  lineSubtotal: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
  taxRate: Decimal;
}

export interface PosReceiptPayment {
  method: string;
  currency: string;
  amountTendered: Decimal;
  amountApplied: Decimal;
  rate: Decimal;
  baseAmount: Decimal;
  changeGiven: Decimal;
}

export interface PosReceiptFiscal {
  status: 'sent' | 'pending' | 'none';
  signature: string | null;
  qrCode: string | null;
  receiptNo: string | null;
  sentAt: string | null;
  message: string | null;
}

export interface PosReceipt {
  saleId: string;
  invoiceNo: string;
  currency: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  changeTotal: Decimal;
  lines: PosReceiptLine[];
  payments: PosReceiptPayment[];
  fiscal: PosReceiptFiscal;
}

export type PosStatus = 'idle' | 'posting' | 'paid' | 'queued' | 'error';

/** A parked cart: the lines and tenders set aside by F3, recalled later. */
export interface HeldCart {
  id: string;
  lines: CartLine[];
  tenders: CartTender[];
  total: Decimal;
}

interface CartState {
  lines: CartLine[];
  tenders: CartTender[];
  /** Parked carts (F3 hold), most recent first. */
  held: HeldCart[];
  /** Operator key actions taken since the cart was last cleared. A one-item exact-cash sale is 3. */
  actions: number;
  status: PosStatus;
  error: string | null;
  receipt: PosReceipt | null;
  /** ZWG per 1 USD, read once at load, so the till can show an exact ZWG tender. */
  zwgRate: Decimal;

  addLine: (line: Omit<CartLine, 'key'>) => void;
  addTender: (tender: CartTender) => void;
  bumpActions: () => void;
  setZwgRate: (rate: Decimal) => void;
  setStatus: (status: PosStatus) => void;
  setError: (message: string | null) => void;
  setReceipt: (receipt: PosReceipt | null) => void;
  /** F3: park the current cart and start a fresh one. */
  hold: () => void;
  /** Recall the most recently parked cart. */
  recall: () => void;
  clear: () => void;
}

function lineKey(variantId: string, unitPrice: Decimal): string {
  return `${variantId}@${unitPrice.toFixed(4)}`;
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  tenders: [],
  held: [],
  actions: 0,
  status: 'idle',
  error: null,
  receipt: null,
  zwgRate: new Decimal(1),

  addLine: (line) =>
    set((state) => {
      const key = lineKey(line.variantId, line.unitPrice);
      const existing = state.lines.find((candidate) => candidate.key === key);
      if (existing) {
        const qty = existing.qty.plus(line.qty);
        return {
          lines: state.lines.map((candidate) =>
            candidate.key === key ? recompute({ ...candidate, qty }) : candidate,
          ),
        };
      }
      return { lines: [...state.lines, recompute({ ...line, key })] };
    }),

  addTender: (tender) => set((state) => ({ tenders: [...state.tenders, tender] })),

  bumpActions: () => set((state) => ({ actions: state.actions + 1 })),

  setZwgRate: (rate) => set({ zwgRate: rate }),

  setStatus: (status) => set({ status }),

  setError: (message) => set({ error: message }),

  setReceipt: (receipt) => set({ receipt }),

  // F3 hold: park the current cart (keeping its total for the recall list) and clear the till for
  // the next customer. An empty cart is not worth parking.
  hold: () =>
    set((state) => {
      if (state.lines.length === 0) return state;
      const total = cartTotals(state.lines).total;
      const held: HeldCart = {
        id: `${Date.now()}-${state.held.length}`,
        lines: state.lines,
        tenders: state.tenders,
        total,
      };
      return {
        lines: [],
        tenders: [],
        held: [held, ...state.held].slice(0, 20),
        status: 'idle',
        error: null,
        receipt: null,
      };
    }),

  // Recall the most recently parked cart, restoring its lines and tenders. Any cart already on the
  // till is parked first, so a recall never discards work.
  recall: () =>
    set((state) => {
      const [next, ...rest] = state.held;
      if (!next) return state;
      const held = [...rest];
      if (state.lines.length > 0) {
        held.unshift({
          id: `${Date.now()}-recall`,
          lines: state.lines,
          tenders: state.tenders,
          total: cartTotals(state.lines).total,
        });
      }
      return {
        lines: next.lines,
        tenders: next.tenders,
        held,
        status: 'idle',
        error: null,
        receipt: null,
      };
    }),

  clear: () => set({ lines: [], tenders: [], actions: 0, status: 'idle', error: null, receipt: null }),
}));

function recompute(line: CartLine): CartLine {
  const lineSubtotal = line.qty.times(line.unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const lineTax = lineSubtotal.times(line.taxRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  return { ...line, lineSubtotal, lineTax, lineTotal: lineSubtotal.plus(lineTax) };
}

/** Cart subtotal, tax and total as decimals. */
export function cartTotals(lines: readonly CartLine[]): {
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
} {
  return lines.reduce(
    (acc, line) => ({
      subtotal: acc.subtotal.plus(line.lineSubtotal),
      taxTotal: acc.taxTotal.plus(line.lineTax),
      total: acc.total.plus(line.lineTotal),
    }),
    { subtotal: new Decimal(0), taxTotal: new Decimal(0), total: new Decimal(0) },
  );
}

/** Base-currency amount already tendered. */
export function tenderedBase(
  tenders: readonly CartTender[],
  zwgRate: Decimal,
): Decimal {
  return tenders.reduce(
    (sum, tender) =>
      sum.plus(tender.currency === 'USD' ? tender.amountTendered : tender.amountTendered.div(zwgRate)),
    new Decimal(0),
  );
}

/** What is still owed, in base currency (USD). */
export function remainingBase(lines: readonly CartLine[], tenders: readonly CartTender[], zwgRate: Decimal): Decimal {
  const total = cartTotals(lines).total;
  const remaining = total.minus(tenderedBase(tenders, zwgRate));
  return remaining.isNegative() ? new Decimal(0) : remaining;
}
