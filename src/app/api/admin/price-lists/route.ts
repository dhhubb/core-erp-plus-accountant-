import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import {
  createPriceList,
  importPriceListItems,
  isPriceListCurrency,
  isPriceListKind,
  listPriceLists,
  type PriceListKind,
} from '@/verticals/admin';

interface PriceListBody {
  org_id?: string;
  name?: string;
  kind?: string;
  currency?: string;
}

interface ImportBody {
  org_id?: string;
  action: 'import';
  price_list_id?: string;
  lines?: Array<{ variant_id: string; price: string }>;
}

function parseKind(value: string | undefined): PriceListKind {
  if (value === undefined || !isPriceListKind(value)) {
    throw new ApiError(422, 'kind must be one of retail, wholesale');
  }
  return value;
}

function parseCurrency(value: string | undefined): string {
  if (value === undefined) return 'USD';
  if (!isPriceListCurrency(value)) {
    throw new ApiError(422, 'currency must be one of USD, ZAR, ZWG');
  }
  return value;
}

/**
 * GET /api/admin/price-lists — keyset page of price lists (created_at, id), default 50, max 100.
 * Each row carries its item count.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listPriceLists(client, {
      orgId,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      price_lists: page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        currency: row.currency,
        is_active: row.isActive,
        item_count: row.itemCount,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/admin/price-lists — create a list, or import its items with COPY (action=import).
 * The COPY import is the same pattern as the stocktake import: one streamed COPY plus one merge.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as PriceListBody | ImportBody;
    assertSameOrg(claims, body.org_id);

    if ((body as ImportBody).action === 'import') {
      const input = body as ImportBody;
      if (!input.price_list_id) throw new ApiError(422, 'price_list_id is required');
      const priceListId = input.price_list_id;
      const lines = (input.lines ?? []).map((line) => ({
        variantId: line.variant_id,
        price: line.price,
      }));
      const imported = await withWriteErrors(() =>
        importPriceListItems(client, { orgId, priceListId, lines }),
      );
      return { price_list_id: priceListId, imported };
    }

    const create = body as PriceListBody;
    const id = await withWriteErrors(() =>
      createPriceList(client, {
        orgId,
        name: create.name ?? '',
        kind: parseKind(create.kind),
        currency: parseCurrency(create.currency),
      }),
    );
    return { id };
  });
}
