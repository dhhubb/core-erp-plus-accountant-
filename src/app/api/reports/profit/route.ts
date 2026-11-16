import { withAuth } from '../../_lib';
import { parseLimit } from '../../_lib';
import { profitByProduct } from '@/verticals/reports';
import { parsePeriod, resolveBranchId } from '../_shared';

/**
 * GET /api/reports/profit — profit by product for a period, keyset on product_id.
 *
 * Closed days come from the immutable daily facts; today comes live. The route is the same on the
 * branch and in the cloud, so the owner console shows the branch's synced data (ADR-0049).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const period = parsePeriod(url.searchParams);
    const branchId = resolveBranchId(url.searchParams, claims);
    const afterProductId = url.searchParams.get('after_product_id');

    const page = await profitByProduct(client, {
      orgId: claims.orgId!,
      branchId,
      period,
      limit,
      afterProductId,
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
      next_cursor: page.nextCursor,
    };
  });
}
