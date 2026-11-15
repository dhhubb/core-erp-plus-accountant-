import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '../core/money';

/** Keyset page over (created_at, id). Default 50, maximum 100. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface PageCursor {
  createdAt: string;
  id: string;
}

export interface InvoiceLineInput {
  productId: string;
  variantId?: string | null;
  warehouseId: string;
  qty: string | Decimal;
  unitPrice: string | Decimal;
  discount?: string | Decimal;
  taxRateCode?: string | null;
  description?: string | null;
}

export interface InvoiceLine extends InvoiceLineInput {
  lineNo: number;
  unitCost: Decimal;
  taxRate: Decimal;
  lineSubtotal: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
}

export interface Invoice {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  amountPaid: Decimal;
  createdAt: string;
}

export interface InvoiceSummary {
  invoiceId: string;
  invoiceNo: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
}

function jsonLines(lines: readonly InvoiceLineInput[]): string {
  return JSON.stringify(
    lines.map((line) => ({
      product_id: line.productId,
      variant_id: line.variantId ?? null,
      warehouse_id: line.warehouseId,
      qty: new Decimal(line.qty).toFixed(4),
      unit_price: new Decimal(line.unitPrice).toFixed(4),
      discount: line.discount === undefined ? '0.0000' : new Decimal(line.discount).toFixed(4),
      tax_rate_code: line.taxRateCode ?? null,
      description: line.description ?? null,
    })),
  );
}

/**
 * Create an invoice. All business logic lives in app.create_invoice: it takes a gapless number,
 * locks stock in sorted order, checks availability, consumes FIFO layers, inserts the invoice and
 * its lines, and posts the journal. All or nothing.
 */
export async function createInvoice(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    contactId?: string | null;
    invoiceDate: string;
    currency?: string;
    lines: readonly InvoiceLineInput[];
  },
): Promise<InvoiceSummary> {
  const result = await client.query<{
    app: { invoice_id: string; invoice_no: string; subtotal: string; tax_total: string; total: string };
  }>(
    `select app.create_invoice($1, $2, $3, $4::date, $5::jsonb, $6, $7) as app`,
    [
      input.orgId,
      input.branchId,
      input.contactId ?? null,
      input.invoiceDate,
      jsonLines(input.lines),
      input.currency ?? 'USD',
      null,
    ],
  );

  const payload = result.rows[0]!.app;
  return {
    invoiceId: payload.invoice_id,
    invoiceNo: payload.invoice_no,
    subtotal: money(payload.subtotal),
    taxTotal: money(payload.tax_total),
    total: money(payload.total),
  };
}

/** Apply a payment to an invoice. Cannot exceed the open balance. */
export async function allocatePayment(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    invoiceId: string;
    amount: string | Decimal;
    paymentDate: string;
    method?: string;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.allocate_payment($1, $2, $3, $4, $5::date, $6) as app`,
    [
      input.orgId,
      input.branchId,
      input.invoiceId,
      new Decimal(input.amount).toFixed(4),
      input.paymentDate,
      input.method ?? 'bank',
    ],
  );
  return result.rows[0]!.app;
}

/** Create a credit note: reverses revenue, VAT and AR, returns stock at the original FIFO cost. */
export async function createCreditNote(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    invoiceId: string;
    creditDate: string;
    reason?: string | null;
    lines: ReadonlyArray<{ lineNo: number; qty: string | Decimal }>;
  },
): Promise<{ creditNoteId: string; creditNo: string; total: Decimal }> {
  const payload = JSON.stringify(
    input.lines.map((line) => ({ line_no: line.lineNo, qty: new Decimal(line.qty).toFixed(4) })),
  );
  const result = await client.query<{
    app: { credit_note_id: string; credit_no: string; total: string };
  }>(`select app.create_credit_note($1, $2, $3, $4::jsonb, $5::date, $6) as app`, [
    input.orgId,
    input.branchId,
    input.invoiceId,
    payload,
    input.creditDate,
    input.reason ?? null,
  ]);
  const row = result.rows[0]!.app;
  return {
    creditNoteId: row.credit_note_id,
    creditNo: row.credit_no,
    total: money(row.total),
  };
}

/**
 * One page of invoices, keyset-paginated on (created_at, id). The limit is validated in SQL so a
 * request above the maximum is rejected rather than silently clamped.
 */
export async function listInvoices(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ invoices: Invoice[]; nextCursor: PageCursor | null }> {
  const result = await client.query<{
    id: string;
    invoice_no: string;
    invoice_date: Date;
    currency: string;
    subtotal: string;
    tax_total: string;
    total: string;
    amount_paid: string;
    created_at: Date;
  }>(
    `select id, invoice_no, invoice_date, currency, subtotal::text, tax_total::text, total::text,
            amount_paid::text, created_at
       from app.list_invoices($1, $2, $3, $4::timestamptz, $5)`,
    [
      input.orgId,
      input.branchId,
      input.limit ?? DEFAULT_PAGE_LIMIT,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const invoices = result.rows.map((row) => ({
    id: row.id,
    invoiceNo: row.invoice_no,
    invoiceDate: row.invoice_date.toISOString().slice(0, 10),
    currency: row.currency,
    subtotal: moneyFromSql(row.subtotal),
    taxTotal: moneyFromSql(row.tax_total),
    total: moneyFromSql(row.total),
    amountPaid: moneyFromSql(row.amount_paid),
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { invoices, nextCursor };
}
