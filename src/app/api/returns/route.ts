import { ApiError, parseCursor, parseLimit, withAuth } from '../_lib';
import { createReturn, listReturns, type RefundMethod, type ReturnLineInput } from '@/verticals/ops/returns';

interface CreateReturnBody {
  original_invoice_id: string;
  return_date?: string | null;
  refund_method?: RefundMethod | null;
  reason?: string | null;
  lines: Array<{ line_no: number; qty: string }>;
}

/** GET /api/returns — keyset page on (created_at, id). */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listReturns(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      limit,
      cursor,
    });

    return {
      returns: page.returns.map((row) => ({
        id: row.id,
        return_no: row.returnNo,
        original_invoice_id: row.originalInvoiceId,
        refund_method: row.refundMethod,
        total: row.total.toFixed(4),
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/returns — return goods against an invoice; stock, revenue and the refund all post. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CreateReturnBody;
    if (!body.lines || body.lines.length === 0) {
      throw new ApiError(422, 'lines are required');
    }

    const lines: ReturnLineInput[] = body.lines.map((line) => ({
      lineNo: line.line_no,
      qty: line.qty,
    }));

    const summary = await createReturn(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      originalInvoiceId: body.original_invoice_id,
      returnDate: body.return_date ?? null,
      refundMethod: body.refund_method ?? null,
      reason: body.reason ?? null,
      lines,
    });

    return {
      return_id: summary.returnId,
      return_no: summary.returnNo,
      credit_note_id: summary.creditNoteId,
      credit_note_no: summary.creditNoteNo,
      total: summary.total.toFixed(4),
      refund_method: summary.refundMethod,
      refund_journal_id: summary.refundJournalId,
    };
  });
}
