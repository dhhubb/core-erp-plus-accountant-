import { ApiError, parseCursor, parseLimit, withAuth } from '../_lib';
import { closeShift, listZReports } from '@/verticals/ops/zReports';

interface CloseShiftBody {
  shift_id: string;
}

/** GET /api/z-reports — keyset page on (created_at, id) of immutable Z-reports. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listZReports(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      limit,
      cursor,
    });

    return {
      z_reports: page.reports.map((report) => ({
        id: report.id,
        z_no: report.zNo,
        shift_id: report.shiftId,
        opened_at: report.openedAt,
        closed_at: report.closedAt,
        opening_float: report.openingFloat.toFixed(4),
        sale_count: report.saleCount,
        void_count: report.voidCount,
        gross_sales: report.grossSales.toFixed(4),
        tax_total: report.taxTotal.toFixed(4),
        by_method: report.byMethod,
        by_currency: report.byCurrency,
        vat_by_rate: report.vatByRate,
        created_at: report.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/z-reports — close a shift; writes one immutable Z-report and closes the shift. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CloseShiftBody;
    if (!body.shift_id) {
      throw new ApiError(422, 'shift_id is required');
    }

    const zReportId = await closeShift(client, {
      orgId: claims.orgId!,
      shiftId: body.shift_id,
      closedBy: claims.sub,
    });

    return { z_report_id: zReportId };
  });
}
