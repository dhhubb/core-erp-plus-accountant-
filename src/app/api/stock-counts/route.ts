import { ApiError, parseCursor, parseLimit, withAuth } from '../_lib';
import {
  closeStockCount,
  createStockCount,
  importStockCountLines,
  listStockCounts,
  type StockCountLineInput,
} from '@/verticals/ops/stockCounts';

interface CreateCountBody {
  warehouse_id: string;
  counted_at?: string | null;
}

interface CloseCountBody {
  action: 'close';
  count_id: string;
  count_created_at: string;
  posting_date?: string | null;
  memo?: string | null;
}

interface ImportLinesBody {
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

/** GET /api/stock-counts — keyset page on (created_at, id). */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listStockCounts(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      limit,
      cursor,
    });

    return {
      stock_counts: page.counts.map((count) => ({
        id: count.id,
        count_no: count.countNo,
        status: count.status,
        counted_at: count.countedAt,
        created_at: count.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/stock-counts — open a count, import its lines, or close it (posting one CORE stock
 * adjustment), selected by `action`.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as
      | CreateCountBody
      | CloseCountBody
      | ImportLinesBody;
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

      const imported = await importStockCountLines(client, {
        orgId: claims.orgId!,
        branchId: claims.branchIds[0]!,
        countId: input.count_id,
        countCreatedAt: input.count_created_at,
        lines,
      });
      return { count_id: input.count_id, imported };
    }

    if (action === 'close') {
      const input = body as CloseCountBody;
      const result = await closeStockCount(client, {
        orgId: claims.orgId!,
        countId: input.count_id,
        countCreatedAt: input.count_created_at,
        postingDate: input.posting_date ?? null,
        memo: input.memo ?? null,
      });
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

    const count = await createStockCount(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      warehouseId: create.warehouse_id,
      countedAt: create.counted_at ?? null,
    });

    return { count_id: count.countId, count_no: count.countNo, created_at: count.createdAt };
  });
}
