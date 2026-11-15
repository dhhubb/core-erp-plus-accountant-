import type { PoolClient } from 'pg';

/** Maximum rows the till search returns. The SQL function enforces the same ceiling. */
export const SEARCH_LIMIT = 20;

/** How the row matched: an exact barcode hit, or a trigram match on the product name. */
export type SearchMatchType = 'barcode' | 'name';

export interface ProductSearchRow {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  categoryId: string | null;
  unit: string;
  isWeighable: boolean;
  matchType: SearchMatchType;
  score: number;
}

interface RawSearchRow {
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  barcode: string | null;
  category_id: string | null;
  unit: string;
  is_weighable: boolean;
  match_type: string;
  score: number;
}

function toSearchRow(row: RawSearchRow): ProductSearchRow {
  return {
    productId: row.product_id,
    variantId: row.variant_id,
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    barcode: row.barcode,
    categoryId: row.category_id,
    unit: row.unit,
    isWeighable: row.is_weighable,
    matchType: row.match_type === 'barcode' ? 'barcode' : 'name',
    score: row.score,
  };
}

/**
 * Till search. Exact barcode first, then a trigram match on the product name, scoped to the
 * caller's org through RLS. At most SEARCH_LIMIT rows.
 *
 * An empty query returns nothing rather than the whole catalogue: the till must not load the
 * product list at startup.
 */
export async function searchProducts(
  client: PoolClient,
  input: { orgId: string; query: string; limit?: number },
): Promise<ProductSearchRow[]> {
  const query = input.query.trim();
  if (query === '') return [];

  const result = await client.query<RawSearchRow>(
    'select * from app.search_products($1, $2, $3)',
    [input.orgId, query, input.limit ?? SEARCH_LIMIT],
  );
  return result.rows.map(toSearchRow);
}
