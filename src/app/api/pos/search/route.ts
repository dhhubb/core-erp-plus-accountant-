import { withAuth } from '@/app/api/_lib';
import { searchProducts, SEARCH_LIMIT } from '@/verticals/retail/products';

/**
 * GET /api/pos/search?q= — till search. Exact barcode first, then a trigram name match.
 * Org-scoped through RLS. Thin handler: one call into the retail module.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';

    const rows = await searchProducts(client, { orgId: claims.orgId!, query });

    return {
      query,
      limit: SEARCH_LIMIT,
      results: rows.map((row) => ({
        product_id: row.productId,
        variant_id: row.variantId,
        product_name: row.productName,
        variant_name: row.variantName,
        sku: row.sku,
        barcode: row.barcode,
        category_id: row.categoryId,
        unit: row.unit,
        is_weighable: row.isWeighable,
        match_type: row.matchType,
        score: row.score,
      })),
    };
  });
}
