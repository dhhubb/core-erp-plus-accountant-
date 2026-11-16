import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import {
  importStockCountLines,
  listStockCounts,
  stockCountSnapshot,
  type StockCountLineInput,
} from '@/verticals/admin';
import { closeStockCount, createStockCount } from '@/verticals/ops/stockCounts';

interface CreateCountBody {
  org_id?: string;
  warehouse_id: string;
  counted_at?: string | null;
}

interface ImportLinesBody {
  org_id?: string;
  action: 'lines';
  count_id: string;
  count_created_at: string;
  lines: Array<{
    product_id: string;
    variant_id?: string | null;
    counted_qty: string;
    system_qty: string;
    unit_cost: string;
  }>;
}

interface CloseCountBody {
  org_id?: string;
  action: 'close';
  count_id: string;
  count_created_at: string;
  posting_date?: string | null;
  memo?: string | null;
}

/** GET /api/admin/stocktake — keyset page of stock counts, or the snapshot for ?warehouse_id=. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);

    const warehouseId = url.searchParams.get('warehouse_id');
    if (warehouseId !== null && url.searchParams.get('snapshot') === '1') {
      const rows = await stockCountSnapshot(client, { orgId, warehouseId });
      return {
        warehouse_id: warehouseId,
        items: rows.map((row) => ({
          product_id: row.productId,
          variant_id: row.variantId,
          system_qty: row.systemQty.toFixed(4),
          unit_cost: row.unitCost.toFixed(4),
        })),
      };
    }

    const page = await listStockCounts(client, {
      orgId,
      branchId: claims.branchIds[0]!,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });

    return {
      stock_counts: page.counts.map((count) => ({
        id: count.id,
        count_no: count.countNo,
        status: count.status,
        warehouse_id: count.warehouseId,
        counted_at: count.countedAt,
        line_count: count.lineCount,
        closed_at: count.closedAt,
        journal_id: count.journalId,
        created_at: count.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/admin/stocktake — open a count, import its lines, or close it (posting one CORE stock
 * adjustment, one journal), selected by `action`. The rule lives in the R5 functions.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CreateCountBody | ImportLinesBody | CloseCountBody;
    assertSameOrg(claims, body.org_id);
    const action = (body as { action?: string }).action;

    if (action === 'lines') {
      const input = body as ImportLinesBody;
      const lines: StockCountLineInput[] = input.lines.map((line) => ({
        productId: line.product_id,
        variantId: line.variant_id ?? null,
        countedQty: line.counted_qty,
        systemQty: line.system_qty,
        unitCost: line.unit_cost,
      }));
      const imported = await withWriteErrors(() =>
        importStockCountLines(client, {
          orgId,
          branchId: claims.branchIds[0]!,
          countId: input.count_id,
          countCreatedAt: input.count_created_at,
          lines,
        }),
      );
      return { count_id: input.count_id, imported };
    }

    if (action === 'close') {
      const input = body as CloseCountBody;
      const result = await withWriteErrors(() =>
        closeStockCount(client, {
          orgId,
          countId: input.count_id,
          countCreatedAt: input.count_created_at,
          postingDate: input.posting_date ?? null,
          memo: input.memo ?? null,
        }),
      );
      return {
        count_id: input.count_id,
        adjusted_lines: result.adjustedLines,
        inventory_increase: result.inventoryIncrease.toFixed(4),
        inventory_decrease: result.inventoryDecrease.toFixed(4),
        journal_id: result.journalId,
      };
    }

    if (action !== undefined) {
      throw new ApiError(422, `unknown stock count action: ${action}`);
    }

    const create = body as CreateCountBody;
    if (!create.warehouse_id) {
      throw new ApiError(422, 'warehouse_id is required');
    }
    const count = await withWriteErrors(() =>
      createStockCount(client, {
        orgId,
        branchId: claims.branchIds[0]!,
        warehouseId: create.warehouse_id,
        countedAt: create.counted_at ?? null,
      }),
    );
    return { count_id: count.countId, count_no: count.countNo, created_at: count.createdAt };
  });
}
