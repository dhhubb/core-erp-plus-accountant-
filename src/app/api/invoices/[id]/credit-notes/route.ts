import { createCreditNote } from '@/core/sales';
import { withAuth } from '../../../_lib';

interface CreditNoteBody {
  credit_date: string;
  reason?: string | null;
  lines: Array<{ line_no: number; qty: string }>;
}

/** POST /api/invoices/:id/credit-notes — reverse revenue, VAT and AR, return stock at FIFO cost. */
export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CreditNoteBody;
    const note = await createCreditNote(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      invoiceId: context.params.id,
      creditDate: body.credit_date,
      reason: body.reason ?? null,
      lines: body.lines.map((line) => ({ lineNo: line.line_no, qty: line.qty })),
    });
    return {
      credit_note_id: note.creditNoteId,
      credit_no: note.creditNo,
      total: note.total.toFixed(4),
    };
  });
}
