import { withAuth } from '../../_lib';
import { parseLimit } from '../../_lib';
import { productRanking } from '@/verticals/reports';
import { parsePeriod, resolveBranchId } from '../_shared';

/**
 * GET /api/reports/slow-movers — the products that barely moved for a period, ascending by
 * quantity. Keyset on (qty, product_id): pass `after_qty` and `after_product_id`.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const period = parsePeriod(url.searchParams);
    const branchId = resolveBranchId(url.searchParams, claims);

    const page = await productRanking(client, {
      orgId: claims.orgId!,
      branchId,
      period,
      ascending: true,
      limit,
      afterQty: url.searchParams.get('after_qty'),
      afterProductId: url.searchParams.get('after_product_id'),
    });

    return {
      period,
      rows: page.rows.map((row) => ({
        product_id: row.productId,
        qty: row.qty.toFixed(4),
        revenue: row.revenue.toFixed(4),
        tax: row.tax.toFixed(4),
        cogs: row.cogs.toFixed(4),
        profit: row.profit.toFixed(4),
      })),
      next_cursor: page.nextCursor
        ? {
            after_qty: page.nextCursor.afterQty.toFixed(4),
            after_product_id: page.nextCursor.afterProductId,
          }
        : null,
    };
  });
}
