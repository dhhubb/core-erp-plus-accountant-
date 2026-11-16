import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../_shared';
import { createVariant, listVariants } from '@/verticals/admin';

interface VariantBody {
  org_id?: string;
  product_id?: string;
  name?: string | null;
  size?: string | null;
  color?: string | null;
  barcode?: string | null;
  cost?: string | number | null;
  sku?: string | null;
}

/**
 * GET /api/admin/variants?product_id= — keyset page of a product's variants (created_at, id),
 * with each variant's stock on hand read from the CORE balance cache.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const productId = url.searchParams.get('product_id');
    if (!productId) throw new ApiError(422, 'product_id is required');
    const page = await listVariants(client, {
      orgId,
      productId,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      variants: page.rows.map((row) => ({
        id: row.id,
        product_id: row.productId,
        sku: row.sku,
        name: row.name,
        size: row.size,
        color: row.color,
        barcode: row.barcode,
        cost: row.cost === null ? null : row.cost.toFixed(4),
        qty_on_hand: row.qtyOnHand.toFixed(4),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/admin/variants — create a variant (barcode validated as EAN-13 when 13 digits). */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as VariantBody;
    assertSameOrg(claims, body.org_id);
    if (!body.product_id) throw new ApiError(422, 'product_id is required');
    const productId = body.product_id;
    const id = await withWriteErrors(() =>
      createVariant(client, {
        orgId,
        productId,
        name: body.name ?? null,
        size: body.size ?? null,
        color: body.color ?? null,
        barcode: body.barcode ?? null,
        cost: body.cost ?? null,
        sku: body.sku ?? null,
      }),
    );
    return { id };
  });
}
