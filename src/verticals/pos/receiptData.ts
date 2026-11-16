import Decimal from 'decimal.js';
import type { PosReceipt } from './cart';

/**
 * The receipt's data model (H4).
 *
 * A receipt is built once, from the sale the server returned, into a plain structure that both the
 * on-screen 58mm receipt and the ESC/POS byte generator consume. Keeping one model means the printed
 * slip and the ESC/POS bytes can never disagree about the VAT breakdown or the totals.
 *
 * Money stays a Decimal end to end (never a JS number), exactly like the rest of the till.
 */

export const RECEIPT_FOOTER = 'Powered by AfritecX';

export interface ReceiptShop {
  /** The shop name printed at the top, in bold. */
  name: string;
  /** Address lines, printed under the name. */
  addressLines: string[];
  /** The VAT registration number (the ZIMRA VAT number), printed under the address. */
  vatNumber: string;
  /** A short text logo for ESC/POS (no image is sent over the wire). */
  logoText: string;
  /** An optional logo image URL for the on-screen receipt. */
  logoUrl: string | null;
}

export interface ReceiptLine {
  description: string;
  qty: Decimal;
  unitPrice: Decimal;
  /** Net of tax (the exclusive amount). */
  net: Decimal;
  tax: Decimal;
  /** Net plus tax (the inclusive amount). */
  total: Decimal;
  taxRate: Decimal;
}

export interface VatBand {
  rate: Decimal;
  /** The net (tax-exclusive) amount taxed at this rate. */
  exclusive: Decimal;
  tax: Decimal;
  /** The tax-inclusive amount at this rate. */
  inclusive: Decimal;
}

export interface ReceiptPayment {
  method: string;
  currency: string;
  amountTendered: Decimal;
  changeGiven: Decimal;
}

export interface ReceiptFiscal {
  status: 'sent' | 'pending' | 'none';
  signature: string | null;
  /** The fiscal QR payload, when the device returned one. */
  qrCode: string | null;
  receiptNo: string | null;
}

export interface ReceiptTotals {
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  /** ZWG per 1 USD, used for the secondary total. */
  zwgRate: Decimal;
  totalZwg: Decimal;
}

export interface ReceiptData {
  shop: ReceiptShop;
  /** The fiscal receipt number when the device issued one, else the invoice number. */
  receiptNumber: string;
  invoiceNo: string;
  date: Date;
  cashier: string;
  lines: ReceiptLine[];
  vatBands: VatBand[];
  totals: ReceiptTotals;
  payments: ReceiptPayment[];
  fiscal: ReceiptFiscal;
  footer: string;
}

export interface BuildReceiptContext {
  shop: ReceiptShop;
  cashier: string;
  zwgRate: Decimal;
  date?: Date;
}

/** The default shop header, used when no shop details are configured. */
export function defaultShop(): ReceiptShop {
  return {
    name: 'ERP Core',
    addressLines: ['Shop 1, Main Street', 'Harare, Zimbabwe'],
    vatNumber: 'VAT 000000000',
    logoText: 'ERP CORE',
    logoUrl: null,
  };
}

/** Group the lines by VAT rate and total each band, exclusive and inclusive. */
export function vatBands(lines: readonly ReceiptLine[]): VatBand[] {
  const bands = new Map<string, VatBand>();
  for (const line of lines) {
    const key = line.taxRate.toFixed(4);
    const band = bands.get(key) ?? {
      rate: line.taxRate,
      exclusive: new Decimal(0),
      tax: new Decimal(0),
      inclusive: new Decimal(0),
    };
    band.exclusive = band.exclusive.plus(line.net);
    band.tax = band.tax.plus(line.tax);
    band.inclusive = band.inclusive.plus(line.total);
    bands.set(key, band);
  }
  return [...bands.values()].sort((a, b) => a.rate.comparedTo(b.rate));
}

/** Build the receipt model from the sale the server returned. */
export function buildReceiptData(
  receipt: PosReceipt,
  context: BuildReceiptContext,
): ReceiptData {
  const lines: ReceiptLine[] = receipt.lines.map((line) => ({
    description: line.description ?? 'Item',
    qty: line.qty,
    unitPrice: line.unitPrice,
    net: line.lineSubtotal,
    tax: line.lineTax,
    total: line.lineTotal,
    taxRate: line.taxRate,
  }));

  const bands = vatBands(lines);

  const total = receipt.total;
  const totalZwg = total
    .times(context.zwgRate)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    shop: context.shop,
    receiptNumber: receipt.fiscal.receiptNo ?? receipt.invoiceNo,
    invoiceNo: receipt.invoiceNo,
    date: context.date ?? new Date(),
    cashier: context.cashier,
    lines,
    vatBands: bands,
    totals: {
      subtotal: receipt.subtotal,
      taxTotal: receipt.taxTotal,
      total,
      zwgRate: context.zwgRate,
      totalZwg,
    },
    payments: receipt.payments.map((payment) => ({
      method: payment.method,
      currency: payment.currency,
      amountTendered: payment.amountTendered,
      changeGiven: payment.changeGiven,
    })),
    fiscal: {
      status: receipt.fiscal.status,
      signature: receipt.fiscal.signature,
      qrCode: receipt.fiscal.qrCode,
      receiptNo: receipt.fiscal.receiptNo,
    },
    footer: RECEIPT_FOOTER,
  };
}

/** Format an amount for a receipt: two decimals, no thousands separators (thermal paper is narrow). */
export function formatMoney(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Format a VAT rate (0.15) as a percentage label (15%). */
export function formatRate(rate: Decimal): string {
  return `${rate.times(100).toDecimalPlaces(2).toString()}%`;
}

/** Format the receipt date as an ISO-ish local timestamp. */
export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
