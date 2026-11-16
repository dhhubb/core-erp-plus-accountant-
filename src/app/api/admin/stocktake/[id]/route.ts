import { ApiError, withAuth } from '../../../_lib';
import { requireOrg, withWriteErrors } from '../../_shared';
import { stockCountDetail } from '@/verticals/admin';

/**
 * GET /api/admin/stocktake/:id?created_at= — one stock count with its variance summary. The
 * created_at is required: stock_counts is partitioned, so the primary key is (id, created_at).
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const countCreatedAt = new URL(request.url).searchParams.get('created_at');
    if (!countCreatedAt) {
      throw new ApiError(422, 'created_at is required (the count is partitioned)');
    }

    const detail = await withWriteErrors(() =>
      stockCountDetail(client, { orgId, countId: params.id, countCreatedAt }),
    );

    return {
      id: detail.id,
      count_no: detail.countNo,
      status: detail.status,
      warehouse_id: detail.warehouseId,
      counted_at: detail.countedAt,
      closed_at: detail.closedAt,
      journal_id: detail.journalId,
      created_at: detail.createdAt,
      line_count: detail.lineCount,
      variance_lines: detail.varianceLines,
      inventory_increase: detail.inventoryIncrease.toFixed(4),
      inventory_decrease: detail.inventoryDecrease.toFixed(4),
    };
  });
}
