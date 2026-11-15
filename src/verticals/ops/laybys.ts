import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';

/** A layby line: a product (optionally a variant) at a unit price. */
export interface LaybyLineInput {
  productId: string;
  variantId?: string | null;
  qty: string | Decimal;
  unitPrice: string | Decimal;
  taxRateCode?: string | null;
}

export interface LaybySummary {
  laybyId: string;
  laybyNo: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  depositPaid: Decimal;
  depositJournalId: string | null;
}

export interface Layby {
  id: string;
  laybyNo: string;
  status: 'open' | 'completed' | 'cancelled';
  dueDate: string;
  currency: string;
  total: Decimal;
  depositPaid: Decimal;
  cancellationFee: Decimal;
  invoiceId: string | null;
  createdAt: string;
}

function jsonLines(lines: readonly LaybyLineInput[]): string {
  return JSON.stringify(
    lines.map((line) => ({
      product_id: line.productId,
      variant_id: line.variantId ?? null,
      qty: new Decimal(line.qty).toFixed(4),
      unit_price: new Decimal(line.unitPrice).toFixed(4),
      tax_rate_code: line.taxRateCode ?? null,
    })),
  );
}

/**
 * Create a layby. app.create_layby reserves the stock (FIFO, so it leaves the available pool) and
 * posts the deposit journal through the balanced-journal hook: Dr Bank, Cr Customer Deposits.
 */
export async function createLayby(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    contactId: string;
    warehouseId: string;
    dueDate: string;
    currency?: string;
    taxCode?: string;
    postingDate?: string | null;
    deposit: string | Decimal;
    lines: readonly LaybyLineInput[];
  },
): Promise<LaybySummary> {
  const result = await client.query<{
    app: {
      layby_id: string;
      layby_no: string;
      subtotal: string;
      tax_total: string;
      total: string;
      deposit_paid: string;
      deposit_journal_id: string | null;
    };
  }>(
    `select app.create_layby($1, $2, $3, $4, $5::date, $6::jsonb, $7, $8, $9, $10::date) as app`,
    [
      input.orgId,
      input.branchId,
      input.contactId,
      input.warehouseId,
      input.dueDate,
      jsonLines(input.lines),
      new Decimal(input.deposit).toFixed(4),
      input.currency ?? 'USD',
      input.taxCode ?? 'VAT15',
      input.postingDate ?? null,
    ],
  );

  const payload = result.rows[0]!.app;
  return {
    laybyId: payload.layby_id,
    laybyNo: payload.layby_no,
    subtotal: money(payload.subtotal),
    taxTotal: money(payload.tax_total),
    total: money(payload.total),
    depositPaid: money(payload.deposit_paid),
    depositJournalId: payload.deposit_journal_id,
  };
}

/** Collect a layby: post the invoice for the reserved goods and clear the deposit against it. */
export async function completeLayby(
  client: PoolClient,
  input: {
    orgId: string;
    laybyId: string;
    completionDate?: string | null;
    payment?: string | Decimal;
  },
): Promise<{ laybyId: string; invoiceId: string; invoiceNo: string; depositApplied: Decimal }> {
  const result = await client.query<{
    app: { layby_id: string; invoice_id: string; invoice_no: string; deposit_applied: string };
  }>(`select app.complete_layby($1, $2, $3::date, $4) as app`, [
    input.orgId,
    input.laybyId,
    input.completionDate ?? null,
    new Decimal(input.payment ?? 0).toFixed(4),
  ]);

  const payload = result.rows[0]!.app;
  return {
    laybyId: payload.layby_id,
    invoiceId: payload.invoice_id,
    invoiceNo: payload.invoice_no,
    depositApplied: money(payload.deposit_applied),
  };
}

/** Cancel a layby: return the reserved stock and refund the deposit less the cancellation fee. */
export async function cancelLayby(
  client: PoolClient,
  input: {
    orgId: string;
    laybyId: string;
    cancellationDate?: string | null;
    fee?: string | Decimal | null;
  },
): Promise<{ depositPaid: Decimal; cancellationFee: Decimal; refund: Decimal; journalId: string }> {
  const result = await client.query<{
    app: {
      deposit_paid: string;
      cancellation_fee: string;
      refund: string;
      journal_id: string;
    };
  }>(`select app.cancel_layby($1, $2, $3::date, $4) as app`, [
    input.orgId,
    input.laybyId,
    input.cancellationDate ?? null,
    input.fee === null || input.fee === undefined ? null : new Decimal(input.fee).toFixed(4),
  ]);

  const payload = result.rows[0]!.app;
  return {
    depositPaid: money(payload.deposit_paid),
    cancellationFee: money(payload.cancellation_fee),
    refund: money(payload.refund),
    journalId: payload.journal_id,
  };
}

/** One keyset page of laybys on (created_at, id). Explicit columns; no SELECT *. */
export async function listLaybys(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    status?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ laybys: Layby[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    layby_no: string;
    status: 'open' | 'completed' | 'cancelled';
    due_date: Date;
    currency: string;
    total: string;
    deposit_paid: string;
    cancellation_fee: string;
    invoice_id: string | null;
    created_at: Date;
  }>(
    `select id, layby_no, status, due_date, currency, total::text, deposit_paid::text,
            cancellation_fee::text, invoice_id, created_at
       from public.laybys
      where org_id = $1
        and branch_id = $2
        and ($3::text is null or status = $3)
        and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
      order by created_at desc, id desc
      limit $6`,
    [
      input.orgId,
      input.branchId,
      input.status ?? null,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      limit,
    ],
  );

  const laybys = result.rows.map((row) => ({
    id: row.id,
    laybyNo: row.layby_no,
    status: row.status,
    dueDate: row.due_date.toISOString().slice(0, 10),
    currency: row.currency,
    total: moneyFromSql(row.total),
    depositPaid: moneyFromSql(row.deposit_paid),
    cancellationFee: moneyFromSql(row.cancellation_fee),
    invoiceId: row.invoice_id,
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { laybys, nextCursor };
}
