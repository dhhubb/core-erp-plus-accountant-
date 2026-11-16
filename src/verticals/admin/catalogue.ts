import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import { isProductUnit, type AdminSearchRow, type BatchPage, type BatchRow, type CategoryNode, type ProductFilters, type ProductPage, type ProductRow, type ProductUnit, type VariantPage, type VariantRow } from './types';

/**
 * The admin catalogue's data access. Every call is one SQL function (app.admin_*), so the route
 * handlers stay thin and RLS scopes the rows (ADR-0050). Money is a decimal, never a number.
 */

/** The admin product search returns at most this many rows (the SQL function enforces it too). */
export const ADMIN_SEARCH_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
}

function cursorOf(rows: Array<{ createdAt: string; id: string }>, limit: number): PageCursor | null {
  const last = rows[rows.length - 1];
  if (!last || rows.length < limit) return null;
  return { createdAt: last.createdAt, id: last.id };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function unit(value: unknown): ProductUnit {
  const text = String(value);
  return isProductUnit(text) ? text : 'each';
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function categoryTree(client: PoolClient, orgId: string): Promise<CategoryNode[]> {
  const result = await client.query<Record<string, unknown>>(
    'select id, parent_id, name, slug, depth, path, created_at, updated_at from app.admin_category_tree($1)',
    [orgId],
  );
  return result.rows.map((row) => ({
    id: String(row['id']),
    parentId: row['parent_id'] === null ? null : String(row['parent_id']),
    name: String(row['name']),
    slug: String(row['slug']),
    depth: Number(row['depth']),
    path: String(row['path']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
}

export async function createCategory(
  client: PoolClient,
  input: { orgId: string; name: string; slug: string; parentId?: string | null },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_category($1, $2, $3, $4) as id',
    [input.orgId, input.name, input.slug, input.parentId ?? null],
  );
  return result.rows[0]!.id;
}

export async function updateCategory(
  client: PoolClient,
  input: { orgId: string; id: string; name: string; slug: string; parentId?: string | null },
): Promise<void> {
  await client.query('select app.update_category($1, $2, $3, $4, $5)', [
    input.orgId,
    input.id,
    input.name,
    input.slug,
    input.parentId ?? null,
  ]);
}

export async function deleteCategory(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_category($1, $2)', [input.orgId, input.id]);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function listProducts(
  client: PoolClient,
  input: {
    orgId: string;
    filters?: ProductFilters;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<ProductPage> {
  const limit = clampLimit(input.limit);
  const filters = input.filters;
  const result = await client.query<Record<string, unknown>>(
    `select id, sku, name, category_id, unit, is_weighable, is_active, variant_count,
            created_at, updated_at
       from app.admin_list_products($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.orgId,
      filters?.categoryId ?? null,
      filters?.isWeighable ?? null,
      filters?.query?.trim() ? filters.query.trim() : null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows: ProductRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    sku: String(row['sku']),
    name: String(row['name']),
    categoryId: row['category_id'] === null ? null : String(row['category_id']),
    unit: unit(row['unit']),
    isWeighable: Boolean(row['is_weighable']),
    isActive: Boolean(row['is_active']),
    variantCount: Number(row['variant_count']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(rows, limit) };
}

export async function searchProducts(
  client: PoolClient,
  input: { orgId: string; query: string; limit?: number },
): Promise<AdminSearchRow[]> {
  const query = input.query.trim();
  if (query === '') return [];
  const limit = Math.min(Math.max(input.limit ?? ADMIN_SEARCH_LIMIT, 1), ADMIN_SEARCH_LIMIT);
  const result = await client.query<Record<string, unknown>>(
    'select * from app.admin_search_products($1, $2, $3)',
    [input.orgId, query, limit],
  );
  return result.rows.map((row) => ({
    productId: String(row['product_id']),
    variantId: String(row['variant_id']),
    productName: String(row['product_name']),
    variantName: String(row['variant_name']),
    sku: String(row['sku']),
    barcode: row['barcode'] === null ? null : String(row['barcode']),
    categoryId: row['category_id'] === null ? null : String(row['category_id']),
    unit: unit(row['unit']),
    isWeighable: Boolean(row['is_weighable']),
    matchType: row['match_type'] === 'barcode' ? 'barcode' : 'name',
    score: Number(row['score']),
  }));
}

export async function createProduct(
  client: PoolClient,
  input: {
    orgId: string;
    name: string;
    categoryId?: string | null;
    unit?: ProductUnit;
    isWeighable?: boolean;
    sku?: string | null;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_product($1, $2, $3, $4, $5, $6) as id',
    [
      input.orgId,
      input.name,
      input.categoryId ?? null,
      input.unit ?? 'each',
      input.isWeighable ?? false,
      input.sku ?? null,
    ],
  );
  return result.rows[0]!.id;
}

export async function updateProduct(
  client: PoolClient,
  input: {
    orgId: string;
    id: string;
    name: string;
    categoryId?: string | null;
    unit?: ProductUnit;
    isWeighable?: boolean;
    isActive?: boolean;
  },
): Promise<void> {
  await client.query('select app.update_product($1, $2, $3, $4, $5, $6, $7)', [
    input.orgId,
    input.id,
    input.name,
    input.categoryId ?? null,
    input.unit ?? 'each',
    input.isWeighable ?? false,
    input.isActive ?? true,
  ]);
}

export async function deleteProduct(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_product($1, $2)', [input.orgId, input.id]);
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export async function listVariants(
  client: PoolClient,
  input: { orgId: string; productId: string; limit?: number; cursor?: PageCursor | null },
): Promise<VariantPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, product_id, sku, name, size, color, barcode, cost, qty_on_hand, created_at, updated_at
       from app.admin_list_variants($1, $2, $3, $4, $5)`,
    [
      input.orgId,
      input.productId,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows: VariantRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    productId: String(row['product_id']),
    sku: String(row['sku']),
    name: String(row['name']),
    size: row['size'] === null ? null : String(row['size']),
    color: row['color'] === null ? null : String(row['color']),
    barcode: row['barcode'] === null ? null : String(row['barcode']),
    cost: row['cost'] === null || row['cost'] === undefined ? null : moneyFromSql(String(row['cost'])),
    qtyOnHand: moneyFromSql(String(row['qty_on_hand'] ?? '0')),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(rows, limit) };
}

export async function createVariant(
  client: PoolClient,
  input: {
    orgId: string;
    productId: string;
    name?: string | null;
    size?: string | null;
    color?: string | null;
    barcode?: string | null;
    cost?: Decimal.Value | null;
    sku?: string | null;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_variant($1, $2, $3, $4, $5, $6, $7, $8) as id',
    [
      input.orgId,
      input.productId,
      input.name ?? null,
      input.size ?? null,
      input.color ?? null,
      input.barcode ?? null,
      input.cost === null || input.cost === undefined ? null : new Decimal(input.cost).toFixed(4),
      input.sku ?? null,
    ],
  );
  return result.rows[0]!.id;
}

export async function updateVariant(
  client: PoolClient,
  input: {
    orgId: string;
    id: string;
    name?: string | null;
    size?: string | null;
    color?: string | null;
    barcode?: string | null;
    cost?: Decimal.Value | null;
  },
): Promise<void> {
  await client.query('select app.update_variant($1, $2, $3, $4, $5, $6, $7)', [
    input.orgId,
    input.id,
    input.name ?? null,
    input.size ?? null,
    input.color ?? null,
    input.barcode ?? null,
    input.cost === null || input.cost === undefined ? null : new Decimal(input.cost).toFixed(4),
  ]);
}

export async function deleteVariant(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_variant($1, $2)', [input.orgId, input.id]);
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function listBatches(
  client: PoolClient,
  input: {
    orgId: string;
    productId?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<BatchPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, variant_id, product_id, product_name, variant_name, sku, batch_no, expiry_date,
            days_to_expiry, created_at
       from app.admin_list_batches($1, $2, $3, $4, $5)`,
    [
      input.orgId,
      input.productId ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows: BatchRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    variantId: String(row['variant_id']),
    productId: String(row['product_id']),
    productName: String(row['product_name']),
    variantName: String(row['variant_name']),
    sku: String(row['sku']),
    batchNo: String(row['batch_no']),
    expiryDate: isoDate(row['expiry_date']),
    daysToExpiry: row['days_to_expiry'] === null ? null : Number(row['days_to_expiry']),
    createdAt: iso(row['created_at']),
  }));
  return { rows, nextCursor: cursorOf(rows, limit) };
}

export async function createBatch(
  client: PoolClient,
  input: { orgId: string; variantId: string; batchNo: string; expiryDate?: string | null },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_batch($1, $2, $3, $4) as id',
    [input.orgId, input.variantId, input.batchNo, input.expiryDate ?? null],
  );
  return result.rows[0]!.id;
}

export async function updateBatch(
  client: PoolClient,
  input: { orgId: string; id: string; batchNo: string; expiryDate?: string | null },
): Promise<void> {
  await client.query('select app.update_batch($1, $2, $3, $4)', [
    input.orgId,
    input.id,
    input.batchNo,
    input.expiryDate ?? null,
  ]);
}

export async function deleteBatch(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_batch($1, $2)', [input.orgId, input.id]);
}

/** On-hand quantity for one variant across the caller's branches (RLS scopes the rows). */
export async function variantStockOnHand(
  client: PoolClient,
  input: { orgId: string; variantId: string },
): Promise<Decimal> {
  const result = await client.query<{ qty: string }>(
    'select app.variant_stock_on_hand($1, $2)::text as qty',
    [input.orgId, input.variantId],
  );
  return moneyFromSql(result.rows[0]?.qty ?? '0');
}
