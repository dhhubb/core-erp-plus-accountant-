import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { requireOrg, withWriteErrors } from '../_shared';
import { listShifts } from '@/verticals/admin';
import { closeShift } from '@/verticals/ops/zReports';

interface CloseShiftBody {
  shift_id: string;
}

/** GET /api/admin/shifts — keyset page of shifts with an optional ?status= filter. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status !== null && !['open', 'closed'].includes(status)) {
      throw new ApiError(422, 'status must be one of open, closed');
    }

    const page = await listShifts(client, {
      orgId,
      branchId: claims.branchIds[0]!,
      status: status as 'open' | 'closed' | null,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });

    return {
      shifts: page.shifts.map((shift) => ({
        id: shift.id,
        till_id: shift.tillId,
        status: shift.status,
        opening_float: shift.openingFloat.toFixed(4),
        opened_at: shift.openedAt,
        closed_at: shift.closedAt,
        z_report_id: shift.zReportId,
        z_no: shift.zNo,
        created_at: shift.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/admin/shifts — close a shift; writes one immutable Z-report and closes the shift. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CloseShiftBody;
    if (!body.shift_id) {
      throw new ApiError(422, 'shift_id is required');
    }

    const zReportId = await withWriteErrors(() =>
      closeShift(client, { orgId, shiftId: body.shift_id, closedBy: claims.sub }),
    );

    return { shift_id: body.shift_id, z_report_id: zReportId };
  });
}
