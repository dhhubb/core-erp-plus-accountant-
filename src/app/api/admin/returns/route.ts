import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import { listReturns } from '@/verticals/admin';
import { createReturn, type ReturnLineInput } from '@/verticals/ops/returns';
import { isRefundMethod } from '@/verticals/admin/opsTypes';

interface CreateReturnBody {
  org_id?: string;
  original_invoice_id: string;
  return_date?: string | null;
  refund_method?: string | null;
  reason?: string | null;
  lines: Array<{ line_no: number; qty: string }>;
}

/** GET /api/admin/returns — keyset page of returns. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listReturns(client, {
      orgId,
      branchId: claims.branchIds[0]!,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });

    return {
      returns: page.returns.map((row) => ({
        id: row.id,
        return_no: row.returnNo,
        status: row.status,
        original_invoice_id: row.originalInvoiceId,
        refund_method: row.refundMethod,
        total: row.total.toFixed(4),
        credit_note_id: row.creditNoteId,
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/admin/returns — create a return against an invoice. app.create_return locks the invoice
 * lines FOR UPDATE, checks the unreturned quantity, returns stock at the original FIFO cost and
 * posts the refund. The refund method defaults from settings when the body omits it.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CreateReturnBody;
    assertSameOrg(claims, body.org_id);

    if (!body.original_invoice_id) {
      throw new ApiError(422, 'original_invoice_id is required');
    }
    if (!body.lines || body.lines.length === 0) {
      throw new ApiError(422, 'lines are required');
    }
    if (body.refund_method != null && !isRefundMethod(body.refund_method)) {
      throw new ApiError(422, 'refund_method must be one of cash, store_credit');
    }

    const lines: ReturnLineInput[] = body.lines.map((line) => ({
      lineNo: line.line_no,
      qty: line.qty,
    }));

    const summary = await withWriteErrors(() =>
      createReturn(client, {
        orgId,
        branchId: claims.branchIds[0]!,
        originalInvoiceId: body.original_invoice_id,
        returnDate: body.return_date ?? null,
        refundMethod: isRefundMethod(body.refund_method) ? body.refund_method : null,
        reason: body.reason ?? null,
        lines,
      }),
    );

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
