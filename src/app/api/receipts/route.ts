import { postReceipt } from '@/core/inventory';
import { withAuth } from '../_lib';

interface ReceiptBody {
  warehouse_id: string;
  product_id: string;
  variant_id?: string | null;
  qty: string;
  unit_cost: string;
  posting_date: string;
}

/** POST /api/receipts — inbound stock layer plus journal (Dr Inventory, Cr Accounts Payable). */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as ReceiptBody;
    const ledgerId = await postReceipt(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      variantId: body.variant_id ?? null,
      qty: body.qty,
      unitCost: body.unit_cost,
      postingDate: body.posting_date,
    });
    return { stock_ledger_id: ledgerId };
  });
}
