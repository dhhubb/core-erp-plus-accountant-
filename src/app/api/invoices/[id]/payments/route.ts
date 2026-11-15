import { allocatePayment } from '@/core/sales';
import { withAuth } from '../../../_lib';

interface PaymentBody {
  amount: string;
  payment_date: string;
  method?: string;
}

/** POST /api/invoices/:id/payments — apply a payment. Cannot exceed the open balance. */
export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as PaymentBody;
    const paymentId = await allocatePayment(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      invoiceId: context.params.id,
      amount: body.amount,
      paymentDate: body.payment_date,
      ...(body.method !== undefined ? { method: body.method } : {}),
    });
    return { payment_id: paymentId };
  });
}
