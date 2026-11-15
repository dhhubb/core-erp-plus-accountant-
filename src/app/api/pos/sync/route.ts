import { ApiError, withAuth } from '@/app/api/_lib';
import { syncPosSales, type SyncSaleInput } from '@/verticals/pos/syncServer';

/**
 * POST /api/pos/sync — deliver a backlog of offline sales.
 *
 * Accepts up to 50 sales. Each runs in its own transaction, so one bad sale cannot block the batch.
 * The endpoint is exempt from the live-sale rate limit: it carries completed sales that must reach
 * the ledger, and throttling a backlog would strand them.
 */

const MAX_SYNC_BATCH = 50;

interface SyncBody {
  sales: Array<{
    client_sale_id: string;
    shift_id?: string | null;
    warehouse_id: string;
    sold_at?: string | null;
    tax_code?: string | null;
    lines: Array<{
      barcode?: string | null;
      variant_id?: string | null;
      qty: string | number;
      unit_price?: string | number | null;
    }>;
    tenders: Array<{ method: string; currency: string; amount_tendered: string | number }>;
  }>;
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as SyncBody;

    if (!Array.isArray(body.sales) || body.sales.length === 0) {
      throw new ApiError(422, 'sales must be a non-empty array');
    }
    if (body.sales.length > MAX_SYNC_BATCH) {
      throw new ApiError(422, `a sync batch may carry at most ${MAX_SYNC_BATCH} sales`);
    }

    const sales: SyncSaleInput[] = body.sales.map((sale) => {
      if (!sale.client_sale_id) {
        throw new ApiError(422, 'every sale needs a client_sale_id');
      }
      if (!Array.isArray(sale.lines) || sale.lines.length === 0) {
        throw new ApiError(422, 'every sale needs at least one line');
      }
      if (!Array.isArray(sale.tenders) || sale.tenders.length === 0) {
        throw new ApiError(422, 'every sale needs at least one tender');
      }
      return {
        clientSaleId: sale.client_sale_id,
        shiftId: sale.shift_id ?? null,
        warehouseId: sale.warehouse_id,
        soldAt: sale.sold_at ?? null,
        taxCode: sale.tax_code ?? null,
        lines: sale.lines.map((line) => ({
          barcode: line.barcode ?? null,
          variantId: line.variant_id ?? null,
          qty: line.qty,
          unitPrice: line.unit_price ?? null,
        })),
        tenders: sale.tenders.map((tender) => ({
          method: tender.method,
          currency: tender.currency,
          amountTendered: tender.amount_tendered,
        })),
      };
    });

    // Each sale is delivered on its own connection/transaction, so a failure in one is isolated.
    const results = await syncPosSales(
      { orgId: claims.orgId!, branchId: claims.branchIds[0]!, userId: claims.sub },
      sales,
    );

    return { results };
  });
}
