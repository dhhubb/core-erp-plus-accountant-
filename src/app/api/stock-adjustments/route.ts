import { postStockAdjustment } from '@/core/inventory';
import { withAuth } from '../_lib';

interface AdjustmentBody {
  warehouse_id: string;
  product_id: string;
  variant_id?: string | null;
  qty: string;
  unit_cost: string;
  posting_date: string;
  memo?: string;
}

/** POST /api/stock-adjustments — ledger rows and a balanced journal in one transaction. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as AdjustmentBody;
    const ledgerId = await postStockAdjustment(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      variantId: body.variant_id ?? null,
      qty: body.qty,
      unitCost: body.unit_cost,
      postingDate: body.posting_date,
      ...(body.memo !== undefined ? { memo: body.memo } : {}),
    });
    return { stock_ledger_id: ledgerId };
  });
}
