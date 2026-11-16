import { withAuth } from '../../_lib';
import { parseCursor, parseLimit } from '../../_lib';
import { zReports } from '@/verticals/reports';
import { resolveBranchId } from '../_shared';

/**
 * GET /api/reports/z-reports — a keyset page of Z-reports, each with its fiscal totals.
 *
 * The fiscal totals (sent / pending / failed, and their amounts) are computed at read time, because
 * a fiscal status can change after a shift closes (ADR-0047).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);
    const branchId = resolveBranchId(url.searchParams, claims);

    const page = await zReports(client, {
      orgId: claims.orgId!,
      branchId,
      limit,
      cursor,
    });

    return {
      rows: page.rows.map((row) => ({
        id: row.id,
        z_no: row.zNo,
        shift_id: row.shiftId,
        opened_at: row.openedAt,
        closed_at: row.closedAt,
        opening_float: row.openingFloat.toFixed(4),
        sale_count: row.saleCount,
        void_count: row.voidCount,
        gross_sales: row.grossSales.toFixed(4),
        tax_total: row.taxTotal.toFixed(4),
        by_method: Object.fromEntries(
          Object.entries(row.byMethod).map(([key, value]) => [key, value.toFixed(4)]),
        ),
        by_currency: Object.fromEntries(
          Object.entries(row.byCurrency).map(([key, value]) => [key, value.toFixed(4)]),
        ),
        vat_by_rate: Object.fromEntries(
          Object.entries(row.vatByRate).map(([key, value]) => [key, value.toFixed(4)]),
        ),
        fiscal: {
          sent: { count: row.fiscal.sent.count, amount: row.fiscal.sent.amount.toFixed(4) },
          pending: { count: row.fiscal.pending.count, amount: row.fiscal.pending.amount.toFixed(4) },
          failed: { count: row.fiscal.failed.count, amount: row.fiscal.failed.amount.toFixed(4) },
        },
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
