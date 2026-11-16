import { requireOrg, withWriteErrors } from '../../_shared';
import { withAuth } from '../../../_lib';
import { laybyDetail } from '@/verticals/admin';

/** GET /api/admin/laybys/:id — one layby with its customer and its reservations. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const detail = await withWriteErrors(() => laybyDetail(client, { orgId, laybyId: params.id }));
    return {
      id: detail.id,
      layby_no: detail.laybyNo,
      status: detail.status,
      due_date: detail.dueDate,
      currency: detail.currency,
      subtotal: detail.subtotal.toFixed(4),
      tax_total: detail.taxTotal.toFixed(4),
      total: detail.total.toFixed(4),
      deposit_paid: detail.depositPaid.toFixed(4),
      cancellation_fee: detail.cancellationFee.toFixed(4),
      invoice_id: detail.invoiceId,
      is_overdue: detail.isOverdue,
      created_at: detail.createdAt,
      customer: detail.customer,
      reservations: detail.reservations.map((row) => ({
        id: row.id,
        product_id: row.productId,
        variant_id: row.variantId,
        qty: row.qty.toFixed(4),
        unit_price: row.unitPrice.toFixed(4),
        unit_cost: row.unitCost.toFixed(4),
        status: row.status,
      })),
    };
  });
}
