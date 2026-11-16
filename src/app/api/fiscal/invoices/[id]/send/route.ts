import { withAuth } from '@/app/api/_lib';
import { manualSendFiscalInvoice } from '@/fiscal';

/**
 * POST /api/fiscal/invoices/:id/send — admin: manually submit a pending or failed fiscal invoice.
 * Re-arms the row as due now; the worker picks it up on the next tick.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    await manualSendFiscalInvoice(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      fiscalInvoiceId: context.params.id,
    });
    return { fiscal_invoice_id: context.params.id, status: 'pending' };
  });
}
