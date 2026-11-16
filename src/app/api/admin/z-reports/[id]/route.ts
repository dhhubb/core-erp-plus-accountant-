import { requireOrg, withWriteErrors } from '../../_shared';
import { withAuth } from '../../../_lib';
import { zReport } from '@/verticals/admin';

/** GET /api/admin/z-reports/:id — one immutable Z-report, for the read-only view and print. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const report = await withWriteErrors(() => zReport(client, { orgId, zReportId: params.id }));
    const money = (value: Record<string, { toFixed: (n: number) => string }>) =>
      Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, amount.toFixed(4)]));
    return {
      id: report.id,
      z_no: report.zNo,
      branch_id: report.branchId,
      shift_id: report.shiftId,
      opened_at: report.openedAt,
      closed_at: report.closedAt,
      opening_float: report.openingFloat.toFixed(4),
      sale_count: report.saleCount,
      void_count: report.voidCount,
      gross_sales: report.grossSales.toFixed(4),
      tax_total: report.taxTotal.toFixed(4),
      by_method: money(report.byMethod),
      by_currency: money(report.byCurrency),
      vat_by_rate: money(report.vatByRate),
      created_at: report.createdAt,
    };
  });
}
