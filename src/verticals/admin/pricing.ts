import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { Readable } from 'node:stream';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import { createPromotion, updatePromotion, deactivatePromotion, invalidatePromotions, type PromotionInput } from '@/verticals/retail/pricing';
import type {
  CustomerGroupRow,
  GroupMemberRow,
  PriceListRow,
  PricePreview,
  PricePreviewStep,
  PriceListItemRow,
  PriceListKind,
  PromotionRow,
  PromotionType,
} from './types';

/**
 * The admin pricing console's data access (ADR-0054).
 *
 * Every read is one SQL function (`app.admin_*`); every precedence rule is enforced by calling the
 * R2 functions (`app.get_price`, `app.assert_manual_discount`) rather than re-implementing them, so
 * the console and the till cannot drift. Promotion writes go through `src/verticals/retail/pricing`
 * so the `promos:{org_id}` Redis cache is invalidated on every write, exactly as a till write does.
 *
 * Money is a decimal, never a number.
 */

export const ADMIN_PRICE_LIST_ITEM_IMPORT_LIMIT = 100_000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
}

/**
 * The next keyset cursor, taken from the exact `created_at` text the query returned. The value is
 * kept at full microsecond precision (a JS Date would truncate it to milliseconds), so a bulk COPY
 * import that writes thousands of rows in one statement still pages correctly (ADR-0057).
 */
function cursorOf(rows: Record<string, unknown>[], limit: number): PageCursor | null {
  const last = rows[rows.length - 1];
  if (!last || rows.length < limit) return null;
  return { createdAt: String(last['created_at_exact']), id: String(last['id']) };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableMoney(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  return moneyFromSql(String(value));
}

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

export async function listPriceLists(
  client: PoolClient,
  input: { orgId: string; limit?: number; cursor?: PageCursor | null },
): Promise<{ rows: PriceListRow[]; nextCursor: PageCursor | null }> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, name, kind, currency, is_active, item_count, created_at,
            created_at::text as created_at_exact, updated_at
       from app.admin_list_price_lists($1, $2, $3, $4)`,
    [input.orgId, limit, input.cursor?.createdAt ?? null, input.cursor?.id ?? null],
  );
  const rows: PriceListRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    kind: String(row['kind']) as PriceListKind,
    currency: String(row['currency']),
    isActive: Boolean(row['is_active']),
    itemCount: Number(row['item_count']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(result.rows, limit) };
}

export async function createPriceList(
  client: PoolClient,
  input: { orgId: string; name: string; kind: PriceListKind; currency: string },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_price_list($1, $2, $3, $4) as id',
    [input.orgId, input.name, input.kind, input.currency],
  );
  return result.rows[0]!.id;
}

export async function updatePriceList(
  client: PoolClient,
  input: { orgId: string; id: string; name: string; currency: string; isActive: boolean },
): Promise<void> {
  await client.query('select app.update_price_list($1, $2, $3, $4, $5)', [
    input.orgId,
    input.id,
    input.name,
    input.currency,
    input.isActive,
  ]);
}

export async function deletePriceList(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_price_list($1, $2)', [input.orgId, input.id]);
}

// ---------------------------------------------------------------------------
// Price list items
// ---------------------------------------------------------------------------

export async function listPriceListItems(
  client: PoolClient,
  input: {
    orgId: string;
    priceListId: string;
    categoryId?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ rows: PriceListItemRow[]; nextCursor: PageCursor | null }> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, price_list_id, variant_id, product_id, product_name, variant_name, sku, barcode,
            category_id, category_name, price, cost, margin, margin_percent, currency,
            created_at, created_at::text as created_at_exact, updated_at
       from app.admin_list_price_list_items($1, $2, $3, $4, $5, $6)`,
    [
      input.orgId,
      input.priceListId,
      input.categoryId ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows: PriceListItemRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    priceListId: String(row['price_list_id']),
    variantId: String(row['variant_id']),
    productId: String(row['product_id']),
    productName: String(row['product_name']),
    variantName: String(row['variant_name']),
    sku: String(row['sku']),
    barcode: nullableString(row['barcode']),
    categoryId: nullableString(row['category_id']),
    categoryName: nullableString(row['category_name']),
    price: moneyFromSql(String(row['price'])),
    cost: nullableMoney(row['cost']),
    margin: nullableMoney(row['margin']),
    marginPercent: nullableMoney(row['margin_percent']),
    currency: String(row['currency']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(result.rows, limit) };
}

/** Inline edit of one item's price. */
export async function updatePriceListItem(
  client: PoolClient,
  input: { orgId: string; id: string; price: Decimal.Value },
): Promise<void> {
  await client.query('select app.admin_update_price_list_item($1, $2, $3)', [
    input.orgId,
    input.id,
    money(input.price).toFixed(4),
  ]);
}

/** Re-price every item in a category (and its descendants) by a percentage change. */
export async function bulkPriceByCategory(
  client: PoolClient,
  input: { orgId: string; priceListId: string; categoryId: string; percent: Decimal.Value },
): Promise<number> {
  const result = await client.query<{ app: number }>(
    'select app.admin_bulk_price_by_category($1, $2, $3, $4) as app',
    [input.orgId, input.priceListId, input.categoryId, new Decimal(input.percent).toFixed(4)],
  );
  return Number(result.rows[0]!.app);
}

export interface PriceImportLine {
  variantId: string;
  price: string | Decimal;
}

/**
 * Import price list items with COPY FROM STDIN, the same pattern as a stocktake import.
 *
 * The CSV (variant_id, price) is streamed into a per-session staging table, then merged with a
 * single INSERT ... ON CONFLICT, so re-importing a variant updates its price rather than failing on
 * the (price_list_id, variant_id) unique key. One COPY plus one merge for a whole file, never one
 * round trip per row. Returns the number of rows written.
 */
export async function importPriceListItems(
  client: PoolClient,
  input: { orgId: string; priceListId: string; lines: readonly PriceImportLine[] },
): Promise<number> {
  if (input.lines.length === 0) return 0;

  await client.query('drop table if exists _price_import');
  await client.query('create temp table _price_import (variant_id uuid, price numeric(19,4)) on commit drop');

  const copySql = 'copy _price_import (variant_id, price) from stdin with (format csv, null \'\\N\')';
  const stream = client.query(copyFrom(copySql));

  const csv = input.lines
    .map((line) => `${line.variantId},${money(line.price).toFixed(4)}`)
    .join('\n');

  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    Readable.from([`${csv}\n`]).pipe(stream);
  });

  const result = await client.query<{ count: string }>(
    `with merged as (
       insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       select $1, $2, s.variant_id, s.price
         from _price_import s
        where s.variant_id is not null
       on conflict (price_list_id, variant_id) do update set price = excluded.price, updated_at = now()
       returning 1
     )
     select count(*)::text as count from merged`,
    [input.orgId, input.priceListId],
  );

  return Number(result.rows[0]!.count);
}

// ---------------------------------------------------------------------------
// Customer groups
// ---------------------------------------------------------------------------

export async function listCustomerGroups(
  client: PoolClient,
  input: { orgId: string; limit?: number; cursor?: PageCursor | null },
): Promise<{ rows: CustomerGroupRow[]; nextCursor: PageCursor | null }> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, name, price_list_id, price_list_name, member_count, created_at,
            created_at::text as created_at_exact, updated_at
       from app.admin_list_customer_groups($1, $2, $3, $4)`,
    [input.orgId, limit, input.cursor?.createdAt ?? null, input.cursor?.id ?? null],
  );
  const rows: CustomerGroupRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    priceListId: nullableString(row['price_list_id']),
    priceListName: nullableString(row['price_list_name']),
    memberCount: Number(row['member_count']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(result.rows, limit) };
}

export async function createCustomerGroup(
  client: PoolClient,
  input: { orgId: string; name: string; priceListId?: string | null },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    'select app.create_customer_group($1, $2, $3) as id',
    [input.orgId, input.name, input.priceListId ?? null],
  );
  return result.rows[0]!.id;
}

export async function updateCustomerGroup(
  client: PoolClient,
  input: { orgId: string; id: string; name: string; priceListId?: string | null },
): Promise<void> {
  await client.query('select app.update_customer_group($1, $2, $3, $4)', [
    input.orgId,
    input.id,
    input.name,
    input.priceListId ?? null,
  ]);
}

export async function deleteCustomerGroup(
  client: PoolClient,
  input: { orgId: string; id: string },
): Promise<void> {
  await client.query('select app.delete_customer_group($1, $2)', [input.orgId, input.id]);
}

export async function listGroupMembers(
  client: PoolClient,
  input: { orgId: string; groupId: string; limit?: number; cursor?: PageCursor | null },
): Promise<{ rows: GroupMemberRow[]; nextCursor: PageCursor | null }> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, name, email, phone, created_at, created_at::text as created_at_exact
       from app.admin_list_group_members($1, $2, $3, $4, $5)`,
    [input.orgId, input.groupId, limit, input.cursor?.createdAt ?? null, input.cursor?.id ?? null],
  );
  const rows: GroupMemberRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    email: nullableString(row['email']),
    phone: nullableString(row['phone']),
    createdAt: iso(row['created_at']),
  }));
  return { rows, nextCursor: cursorOf(result.rows, limit) };
}

export async function assignGroupMembers(
  client: PoolClient,
  input: { orgId: string; groupId: string; contactIds: string[]; assign?: boolean },
): Promise<number> {
  const result = await client.query<{ app: number }>(
    'select app.admin_assign_group_members($1, $2, $3::uuid[], $4) as app',
    [input.orgId, input.groupId, input.contactIds, input.assign ?? true],
  );
  return Number(result.rows[0]!.app);
}

// ---------------------------------------------------------------------------
// Promotions. Writes go through the R2 module so the promos:{org_id} cache is invalidated.
// ---------------------------------------------------------------------------

export async function listPromotions(
  client: PoolClient,
  input: {
    orgId: string;
    isActive?: boolean | null;
    type?: PromotionType | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ rows: PromotionRow[]; nextCursor: PageCursor | null }> {
  const limit = clampLimit(input.limit);
  const result = await client.query<Record<string, unknown>>(
    `select id, name, type, valid_from, valid_to, is_active, priority, stackable, conditions,
            created_at, created_at::text as created_at_exact, updated_at
       from app.admin_list_promotions($1, $2, $3, $4, $5, $6)`,
    [
      input.orgId,
      input.isActive ?? null,
      input.type ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows: PromotionRow[] = result.rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    type: String(row['type']) as PromotionType,
    validFrom: iso(row['valid_from']),
    validTo: iso(row['valid_to']),
    isActive: Boolean(row['is_active']),
    priority: Number(row['priority']),
    stackable: Boolean(row['stackable']),
    conditions: (row['conditions'] ?? {}) as Record<string, unknown>,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  }));
  return { rows, nextCursor: cursorOf(result.rows, limit) };
}

/** Create a promotion (invalidates the cache) — delegates to the R2 writer. */
export async function createAdminPromotion(
  client: PoolClient,
  orgId: string,
  input: PromotionInput,
): Promise<string> {
  return createPromotion(client, orgId, input);
}

/** Update a promotion (invalidates the cache). */
export async function updateAdminPromotion(
  client: PoolClient,
  orgId: string,
  promotionId: string,
  input: Partial<PromotionInput>,
): Promise<void> {
  return updatePromotion(client, orgId, promotionId, input);
}

/** Deactivate a promotion (invalidates the cache). */
export async function deactivateAdminPromotion(
  client: PoolClient,
  orgId: string,
  promotionId: string,
): Promise<void> {
  return deactivatePromotion(client, orgId, promotionId);
}

/** Drag-to-reorder: assign priority by array position, then invalidate the cache. */
export async function reorderPromotions(
  client: PoolClient,
  orgId: string,
  orderedIds: string[],
): Promise<number> {
  const result = await client.query<{ app: number }>(
    'select app.admin_reorder_promotions($1, $2::uuid[]) as app',
    [orgId, orderedIds],
  );
  await invalidatePromotions(orgId);
  return Number(result.rows[0]!.app);
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

function toPreviewStep(value: unknown): PricePreviewStep {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    step: Number(row['step']),
    name: String(row['name']),
    detail: String(row['detail']),
    amount: moneyFromSql(String(row['amount'] ?? '0')),
    sourceId: nullableString(row['source_id']),
    limit: row['limit'] === undefined || row['limit'] === null ? null : moneyFromSql(String(row['limit'])),
  };
}

export async function pricePreview(
  client: PoolClient,
  input: {
    orgId: string;
    variantId: string;
    groupId?: string | null;
    atTime: Date;
    role?: string | null;
    qty?: Decimal.Value;
    manualDiscount?: Decimal.Value | null;
    reason?: string | null;
  },
): Promise<PricePreview | null> {
  const result = await client.query<Record<string, unknown>>(
    `select variant_id, currency, list_price, unit_price, discount, source_price_list_id,
            source_price_list_name, source_price_list_kind, source_promotion_id,
            source_promotion_name, manual_discount, manual_max_amount, effective_price, steps
       from app.admin_price_preview($1, $2, $3, $4::timestamptz, $5, $6, $7, $8)`,
    [
      input.orgId,
      input.variantId,
      input.groupId ?? null,
      input.atTime.toISOString(),
      input.role ?? null,
      input.qty === undefined ? 1 : new Decimal(input.qty).toFixed(4),
      input.manualDiscount === null || input.manualDiscount === undefined
        ? null
        : money(input.manualDiscount).toFixed(4),
      input.reason ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  const steps = Array.isArray(row['steps']) ? (row['steps'] as unknown[]).map(toPreviewStep) : [];
  return {
    variantId: String(row['variant_id']),
    currency: String(row['currency']),
    listPrice: moneyFromSql(String(row['list_price'])),
    unitPrice: moneyFromSql(String(row['unit_price'])),
    discount: moneyFromSql(String(row['discount'])),
    sourcePriceListId: nullableString(row['source_price_list_id']),
    sourcePriceListName: nullableString(row['source_price_list_name']),
    sourcePriceListKind: nullableString(row['source_price_list_kind']),
    sourcePromotionId: nullableString(row['source_promotion_id']),
    sourcePromotionName: nullableString(row['source_promotion_name']),
    manualDiscount: moneyFromSql(String(row['manual_discount'])),
    manualMaxAmount: moneyFromSql(String(row['manual_max_amount'])),
    effectivePrice: moneyFromSql(String(row['effective_price'])),
    steps,
  };
}
