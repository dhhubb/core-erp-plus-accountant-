import { withAuth } from '@/app/api/_lib';
import { retryFiscalInvoice } from '@/fiscal';

/**
 * POST /api/fiscal/invoices/:id/retry — admin: retry a FAILED fiscal invoice.
 * Clears the attempt counter and re-arms it as pending, so the worker submits it again.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    await retryFiscalInvoice(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      fiscalInvoiceId: context.params.id,
    });
    return { fiscal_invoice_id: context.params.id, status: 'pending' };
  });
}
