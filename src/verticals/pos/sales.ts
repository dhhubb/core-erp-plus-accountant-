import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';

/** Tender methods a till may take. Mirrors the pos_payments check constraint. */
export const TENDER_METHODS = ['cash', 'card', 'mobile', 'voucher'] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];

/** POS tenders are cash-in-hand currencies: USD and ZWG. */
export const TENDER_CURRENCIES = ['USD', 'ZWG'] as const;
export type TenderCurrency = (typeof TENDER_CURRENCIES)[number];

export interface PosSaleLineInput {
  /** Either a barcode (the scanner path) or an explicit variant id. */
  barcode?: string | null;
  variantId?: string | null;
  qty: string | Decimal;
  /** Optional override; when omitted the price comes from the R2 pricing functions. */
  unitPrice?: string | Decimal | null;
}

export interface PosTenderInput {
  method: TenderMethod;
  currency: TenderCurrency;
  amountTendered: string | Decimal;
}

export interface PosSaleReceiptLine {
  lineNo: number;
  description: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  lineSubtotal: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
  taxRate: Decimal;
}

export interface PosSaleReceiptPayment {
  method: string;
  currency: string;
  amountTendered: Decimal;
  amountApplied: Decimal;
  rate: Decimal;
  baseAmount: Decimal;
  changeGiven: Decimal;
}

export interface PosSaleReceipt {
  saleId: string;
  invoiceId: string;
  invoiceNo: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  changeTotal: Decimal;
  currency: string;
  lines: PosSaleReceiptLine[];
  payments: PosSaleReceiptPayment[];
}

interface RawReceipt {
  sale_id: string;
  invoice_id: string;
  invoice_no: string;
  subtotal: string;
  tax_total: string;
  total: string;
  change_total: string;
  currency: string;
  lines: Array<{
    line_no: number;
    description: string | null;
    qty: string;
    unit_price: string;
    line_subtotal: string;
    line_tax: string;
    line_total: string;
    tax_rate: string;
  }>;
  payments: Array<{
    method: string;
    currency: string;
    amount_tendered: string;
    amount_applied: string;
    rate: string;
    base_amount: string;
    change_given: string;
  }>;
}

function toReceipt(raw: RawReceipt): PosSaleReceipt {
  return {
    saleId: raw.sale_id,
    invoiceId: raw.invoice_id,
    invoiceNo: raw.invoice_no,
    subtotal: moneyFromSql(raw.subtotal),
    taxTotal: moneyFromSql(raw.tax_total),
    total: moneyFromSql(raw.total),
    changeTotal: moneyFromSql(raw.change_total),
    currency: raw.currency,
    lines: raw.lines.map((line) => ({
      lineNo: line.line_no,
      description: line.description,
      qty: moneyFromSql(line.qty),
      unitPrice: moneyFromSql(line.unit_price),
      lineSubtotal: moneyFromSql(line.line_subtotal),
      lineTax: moneyFromSql(line.line_tax),
      lineTotal: moneyFromSql(line.line_total),
      taxRate: moneyFromSql(line.tax_rate),
    })),
    payments: raw.payments.map((payment) => ({
      method: payment.method,
      currency: payment.currency,
      amountTendered: moneyFromSql(payment.amount_tendered),
      amountApplied: moneyFromSql(payment.amount_applied),
      rate: new Decimal(payment.rate),
      baseAmount: moneyFromSql(payment.base_amount),
      changeGiven: moneyFromSql(payment.change_given),
    })),
  };
}

function jsonLines(lines: readonly PosSaleLineInput[]): string {
  return JSON.stringify(
    lines.map((line) => ({
      barcode: line.barcode ?? null,
      variant_id: line.variantId ?? null,
      qty: new Decimal(line.qty).toFixed(4),
      unit_price:
        line.unitPrice === undefined || line.unitPrice === null
          ? null
          : new Decimal(line.unitPrice).toFixed(4),
    })),
  );
}

function jsonTenders(tenders: readonly PosTenderInput[]): string {
  return JSON.stringify(
    tenders.map((tender) => ({
      method: tender.method,
      currency: tender.currency,
      amount_tendered: new Decimal(tender.amountTendered).toFixed(4),
    })),
  );
}

/**
 * Ring a POS sale. One call: the SQL function creates the CORE invoice (gapless number, sorted
 * stock locks, FIFO consumption, balanced journal), allocates one CORE payment per tender, and
 * writes the POS rows. All or nothing, in the caller's transaction.
 *
 * clientSaleId makes the call idempotent: a retry returns the original receipt.
 */
export async function createPosSale(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    warehouseId: string;
    shiftId: string | null;
    clientSaleId: string;
    lines: readonly PosSaleLineInput[];
    tenders: readonly PosTenderInput[];
    contactId?: string | null;
    saleDate?: string | null;
    taxCode?: string | null;
  },
): Promise<PosSaleReceipt> {
  const result = await client.query<{ app: RawReceipt }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::date, $10, $11) as app`,
    [
      input.orgId,
      input.branchId,
      input.warehouseId,
      input.shiftId,
      input.clientSaleId,
      jsonLines(input.lines),
      jsonTenders(input.tenders),
      input.contactId ?? null,
      input.saleDate ?? null,
      null,
      input.taxCode ?? 'VAT15',
    ],
  );
  return toReceipt(result.rows[0]!.app);
}

export interface PosSaleRow {
  id: string;
  shiftId: string | null;
  invoiceId: string;
  clientSaleId: string;
  status: string;
  cashierId: string | null;
  createdAt: string;
}

/** One keyset page of a shift's sales, on (created_at, id). Never OFFSET. */
export async function listPosSales(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    shiftId?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ sales: PosSaleRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    shift_id: string | null;
    invoice_id: string;
    client_sale_id: string;
    status: string;
    cashier_id: string | null;
    created_at: Date;
  }>(
    `select id, shift_id, invoice_id, client_sale_id, status, cashier_id, created_at
       from app.list_pos_sales($1, $2, $3, $4, $5::timestamptz, $6)`,
    [
      input.orgId,
      input.branchId,
      input.shiftId ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const sales = result.rows.map((row) => ({
    id: row.id,
    shiftId: row.shift_id,
    invoiceId: row.invoice_id,
    clientSaleId: row.client_sale_id,
    status: row.status,
    cashierId: row.cashier_id,
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { sales, nextCursor };
}

export interface PosContext {
  shiftId: string | null;
  tillId: string;
  warehouseId: string | null;
  /** Default VAT code and the rate in force today, so the till's total matches the invoice. */
  taxCode: string;
  taxRate: string;
}

/**
 * What the terminal needs on load: the open shift for a till (if any), the branch's default
 * warehouse, and the VAT rate in force. All read through RLS.
 */
export async function posContext(
  client: PoolClient,
  input: { orgId: string; branchId: string; tillId: string },
): Promise<PosContext> {
  const shift = await client.query<{ id: string }>(
    `select id from public.shifts
      where org_id = $1 and branch_id = $2 and till_id = $3 and status = 'open'
      order by opened_at desc
      limit 1`,
    [input.orgId, input.branchId, input.tillId],
  );
  const warehouse = await client.query<{ id: string }>(
    `select id from public.warehouses
      where org_id = $1 and branch_id = $2 and is_active
      order by created_at
      limit 1`,
    [input.orgId, input.branchId],
  );
  const tax = await client.query<{ code: string; rate: string }>(
    `select code, rate::text as rate
       from public.tax_rates
      where org_id = $1
        and is_active
        and effective_from <= current_date
        and (effective_to is null or effective_to >= current_date)
      order by effective_from desc
      limit 1`,
    [input.orgId],
  );

  return {
    shiftId: shift.rows[0]?.id ?? null,
    tillId: input.tillId,
    warehouseId: warehouse.rows[0]?.id ?? null,
    taxCode: tax.rows[0]?.code ?? 'VAT15',
    taxRate: tax.rows[0]?.rate ?? '0',
  };
}

/** Open a till shift. Returns the new shift id. */
export async function openShift(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    tillId: string;
    openingFloat?: string | Decimal;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.open_shift($1, $2, $3, $4) as app`,
    [input.orgId, input.branchId, input.tillId, money(input.openingFloat ?? 0).toFixed(4)],
  );
  return result.rows[0]!.app;
}
