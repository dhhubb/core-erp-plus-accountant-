import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../_shared';
import { ADMIN_SEARCH_LIMIT, createProduct, isProductUnit, listProducts, searchProducts, type ProductUnit } from '@/verticals/admin';

interface ProductBody {
  org_id?: string;
  name?: string;
  category_id?: string | null;
  unit?: string;
  is_weighable?: boolean;
  sku?: string | null;
}

function parseUnit(value: string | undefined): ProductUnit {
  if (value === undefined) return 'each';
  if (!isProductUnit(value)) {
    throw new ApiError(422, `unit must be one of each, kg, g, l, ml, pack`);
  }
  return value;
}

/**
 * GET /api/admin/products — keyset page of products (created_at, id), default 50, max 100.
 * Filters: category_id (includes descendants), is_weighable, q (trigram name match).
 * `q` with `search=1` returns the till-style search hits (barcode first), capped at 50.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';

    if (url.searchParams.get('search') === '1') {
      const results = await searchProducts(client, { orgId, query, limit: ADMIN_SEARCH_LIMIT });
      return { query, limit: ADMIN_SEARCH_LIMIT, results };
    }

    const weighableRaw = url.searchParams.get('is_weighable');
    const isWeighable = weighableRaw === null ? null : weighableRaw === 'true';
    const page = await listProducts(client, {
      orgId,
      filters: {
        categoryId: url.searchParams.get('category_id'),
        isWeighable,
        query,
      },
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      products: page.rows.map((row) => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        category_id: row.categoryId,
        unit: row.unit,
        is_weighable: row.isWeighable,
        is_active: row.isActive,
        variant_count: row.variantCount,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/admin/products — create a product. The SKU comes from the number series in SQL. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as ProductBody;
    assertSameOrg(claims, body.org_id);
    const isWeighable = body.is_weighable ?? false;
    const unit = parseUnit(body.unit);
    if (isWeighable && unit === 'each') {
      throw new ApiError(422, 'a weighable product must use a measure unit (kg, g, l or ml)');
    }
    const id = await withWriteErrors(() =>
      createProduct(client, {
        orgId,
        name: body.name ?? '',
        categoryId: body.category_id ?? null,
        unit,
        isWeighable,
        sku: body.sku ?? null,
      }),
    );
    return { id };
  });
}
