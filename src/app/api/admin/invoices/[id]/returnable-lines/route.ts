import { requireOrg, withWriteErrors } from '../../../_shared';
import { withAuth } from '../../../../_lib';
import { invoiceReturnableLines } from '@/verticals/admin';

/**
 * GET /api/admin/invoices/:id/returnable-lines — the returnable lines of an invoice: qty sold, qty
 * already returned and the remainder. The returns page shows this before a return is created.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const lines = await withWriteErrors(() =>
      invoiceReturnableLines(client, { orgId, invoiceId: params.id }),
    );
    return {
      invoice_id: params.id,
      lines: lines.map((line) => ({
        invoice_line_id: line.invoiceLineId,
        line_no: line.lineNo,
        product_id: line.productId,
        variant_id: line.variantId,
        description: line.description,
        qty_sold: line.qtySold.toFixed(4),
        qty_returned: line.qtyReturned.toFixed(4),
        qty_returnable: line.qtyReturnable.toFixed(4),
        unit_price: line.unitPrice.toFixed(4),
        unit_cost: line.unitCost.toFixed(4),
      })),
    };
  });
}
