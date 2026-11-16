import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../_shared';
import { createBatch, listBatches } from '@/verticals/admin';

interface BatchBody {
  org_id?: string;
  variant_id?: string;
  batch_no?: string;
  expiry_date?: string | null;
}

/**
 * GET /api/admin/batches — keyset page of product batches (created_at, id), optional product_id
 * filter, each row carrying its days to expiry so the client can colour it.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listBatches(client, {
      orgId,
      productId: url.searchParams.get('product_id'),
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      batches: page.rows.map((row) => ({
        id: row.id,
        variant_id: row.variantId,
        product_id: row.productId,
        product_name: row.productName,
        variant_name: row.variantName,
        sku: row.sku,
        batch_no: row.batchNo,
        expiry_date: row.expiryDate,
        days_to_expiry: row.daysToExpiry,
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/admin/batches — create a batch for a variant. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as BatchBody;
    assertSameOrg(claims, body.org_id);
    if (!body.variant_id) throw new ApiError(422, 'variant_id is required');
    const variantId = body.variant_id;
    const id = await withWriteErrors(() =>
      createBatch(client, {
        orgId,
        variantId,
        batchNo: body.batch_no ?? '',
        expiryDate: body.expiry_date ?? null,
      }),
    );
    return { id };
  });
}
