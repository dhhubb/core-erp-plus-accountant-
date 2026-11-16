import { ApiError, parseCursor, parseLimit, withAuth } from '../../../../_lib';
import { requireOrg, withWriteErrors } from '../../../_shared';
import {
  bulkPriceByCategory,
  listPriceListItems,
  updatePriceListItem,
} from '@/verticals/admin';

function moneyString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * GET /api/admin/price-lists/:id/items — keyset page of the list's items (created_at, id) with
 * margin vs cost. Optional category_id filter (includes descendants).
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listPriceListItems(client, {
      orgId,
      priceListId: params.id,
      categoryId: url.searchParams.get('category_id'),
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      items: page.rows.map((row) => ({
        id: row.id,
        price_list_id: row.priceListId,
        variant_id: row.variantId,
        product_id: row.productId,
        product_name: row.productName,
        variant_name: row.variantName,
        sku: row.sku,
        barcode: row.barcode,
        category_id: row.categoryId,
        category_name: row.categoryName,
        price: row.price.toFixed(4),
        cost: row.cost === null ? null : row.cost.toFixed(4),
        margin: row.margin === null ? null : row.margin.toFixed(4),
        margin_percent: row.marginPercent === null ? null : row.marginPercent.toFixed(4),
        currency: row.currency,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

interface ItemWriteBody {
  action?: 'update' | 'bulk_category';
  org_id?: string;
  item_id?: string;
  price?: string;
  category_id?: string;
  percent?: string;
}

/**
 * PATCH /api/admin/price-lists/:id/items — inline edit of one item's price, or a bulk re-price of
 * every item in a category (and its descendants) by a percentage.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as ItemWriteBody;

    if (body.action === 'bulk_category') {
      if (!body.category_id) throw new ApiError(422, 'category_id is required');
      if (body.percent === undefined) throw new ApiError(422, 'percent is required');
      const categoryId = body.category_id;
      const percent = body.percent;
      const changed = await withWriteErrors(() =>
        bulkPriceByCategory(client, {
          orgId,
          priceListId: params.id,
          categoryId,
          percent,
        }),
      );
      return { price_list_id: params.id, category_id: categoryId, changed };
    }

    if (!body.item_id) throw new ApiError(422, 'item_id is required');
    if (body.price === undefined) throw new ApiError(422, 'price is required');
    const itemId = body.item_id;
    const price = body.price;
    await withWriteErrors(() =>
      updatePriceListItem(client, { orgId, id: itemId, price }),
    );
    return { id: itemId, price: moneyString(price) };
  });
}
