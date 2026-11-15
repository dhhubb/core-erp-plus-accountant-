import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';

export const REFUND_METHODS = ['cash', 'store_credit'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export interface ReturnLineInput {
  lineNo: number;
  qty: string | Decimal;
}

export interface ReturnSummary {
  returnId: string;
  returnNo: string;
  creditNoteId: string;
  creditNoteNo: string;
  total: Decimal;
  refundMethod: string;
  refundJournalId: string;
}

export interface CustomerReturn {
  id: string;
  returnNo: string;
  originalInvoiceId: string;
  refundMethod: string;
  total: Decimal;
  createdAt: string;
}

/**
 * Create a return against an invoice. app.create_return locks the original invoice lines in order,
 * checks the unreturned quantity, calls the CORE credit note for stock and revenue, and posts the
 * refund through the balanced-journal hook (Cr Bank or Cr Store Credit).
 */
export async function createReturn(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    originalInvoiceId: string;
    returnDate?: string | null;
    refundMethod?: RefundMethod | null;
    reason?: string | null;
    lines: readonly ReturnLineInput[];
  },
): Promise<ReturnSummary> {
  const lines = JSON.stringify(
    input.lines.map((line) => ({ line_no: line.lineNo, qty: new Decimal(line.qty).toFixed(4) })),
  );

  const result = await client.query<{
    app: {
      return_id: string;
      return_no: string;
      credit_note_id: string;
      credit_note_no: string;
      total: string;
      refund_method: string;
      refund_journal_id: string;
    };
  }>(`select app.create_return($1, $2, $3, $4::jsonb, $5::date, $6, $7) as app`, [
    input.orgId,
    input.branchId,
    input.originalInvoiceId,
    lines,
    input.returnDate ?? null,
    input.refundMethod ?? null,
    input.reason ?? null,
  ]);

  const payload = result.rows[0]!.app;
  return {
    returnId: payload.return_id,
    returnNo: payload.return_no,
    creditNoteId: payload.credit_note_id,
    creditNoteNo: payload.credit_note_no,
    total: money(payload.total),
    refundMethod: payload.refund_method,
    refundJournalId: payload.refund_journal_id,
  };
}

/** One keyset page of returns on (created_at, id). */
export async function listReturns(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ returns: CustomerReturn[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    return_no: string;
    original_invoice_id: string;
    refund_method: string;
    total: string;
    created_at: Date;
  }>(
    `select id, return_no, original_invoice_id, refund_method, total::text, created_at
       from public.returns
      where org_id = $1
        and branch_id = $2
        and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
      order by created_at desc, id desc
      limit $5`,
    [
      input.orgId,
      input.branchId,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      limit,
    ],
  );

  const returns = result.rows.map((row) => ({
    id: row.id,
    returnNo: row.return_no,
    originalInvoiceId: row.original_invoice_id,
    refundMethod: row.refund_method,
    total: moneyFromSql(row.total),
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { returns, nextCursor };
}
