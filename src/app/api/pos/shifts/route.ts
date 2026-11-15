import Decimal from 'decimal.js';
import { ApiError, withAuth } from '@/app/api/_lib';
import { openShift, posContext } from '@/verticals/pos/sales';

interface OpenShiftBody {
  till_id: string;
  opening_float?: string | number;
}

/**
 * GET /api/pos/shifts?till_id= — the terminal's context: the open shift for the till and the
 * branch's default warehouse. Org/branch scoped through RLS.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const tillId = url.searchParams.get('till_id') ?? 'TILL-1';

    const context = await posContext(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      tillId,
    });

    return {
      shift_id: context.shiftId,
      till_id: context.tillId,
      warehouse_id: context.warehouseId,
      tax_code: context.taxCode,
      tax_rate: context.taxRate,
    };
  });
}

/** POST /api/pos/shifts — open a till shift with an opening float. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as OpenShiftBody;
    if (!body.till_id) {
      throw new ApiError(422, 'till_id is required');
    }

    const shiftId = await openShift(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      tillId: body.till_id,
      openingFloat: new Decimal(body.opening_float ?? 0),
    });

    return { shift_id: shiftId };
  });
}
