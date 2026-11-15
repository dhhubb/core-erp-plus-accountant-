import Decimal from 'decimal.js';
import { money, moneyFromSql } from '../../core/money';
import { getRedis } from '../../core/redis';

/**
 * The promotion candidate cache. Redis holds candidates only (never a resolved price), the key is
 * prefixed with the org id, and the TTL is 300 seconds. Every evaluation re-checks the validity
 * window in SQL, so an entry that has gone stale cannot apply a promotion that has since expired.
 */
export const PROMO_CACHE_TTL_SECONDS = 300;

export function promoCacheKey(orgId: string): string {
  return `promos:${orgId}`;
}

/** The subset of a Redis client this module needs. */
export interface PromoCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Adapt the shared ioredis client to the PromoCache shape this module depends on. */
export function defaultPromoCache(): PromoCache {
  const redis = getRedis();
  return {
    get: (key) => redis.get(key),
    set: (key, value, mode, ttl) => redis.set(key, value, mode, ttl),
    del: (key) => redis.del(key),
  };
}

/** The subset of a pg client this module needs. A PoolClient satisfies it. */
export interface QueryRunner {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PriceSource {
  priceListId: string;
  promotionId: string | null;
}

export interface ResolvedPrice {
  variantId: string;
  unitPrice: Decimal;
  listPrice: Decimal;
  discount: Decimal;
  source: PriceSource;
  currency: string;
}

export interface CartLine extends ResolvedPrice {
  qty: Decimal;
  lineTotal: Decimal;
}

export class PricingError extends Error {}

interface RawCandidate {
  id: string;
  type: string;
  priority: number;
  stackable: boolean;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  conditions: Record<string, unknown>;
}

interface RawPriceRow {
  variant_id: string;
  unit_price: string;
  list_price: string;
  discount: string;
  source_price_list_id: string | null;
  source_promotion_id: string | null;
  currency: string;
}

function toResolved(row: RawPriceRow): ResolvedPrice {
  return {
    variantId: row.variant_id,
    unitPrice: moneyFromSql(row.unit_price),
    listPrice: moneyFromSql(row.list_price),
    discount: moneyFromSql(row.discount),
    source: {
      priceListId: row.source_price_list_id ?? '',
      promotionId: row.source_promotion_id,
    },
    currency: row.currency,
  };
}

/**
 * Candidate promotions for an org: from Redis when present, otherwise from the database (then
 * cached). Candidates only, never a price. The validity window is checked again in SQL at
 * evaluation time.
 */
export async function loadPromotionCandidates(
  client: QueryRunner,
  orgId: string,
  cache?: PromoCache,
): Promise<RawCandidate[]> {
  const store = cache ?? defaultPromoCache();
  const key = promoCacheKey(orgId);
  const cached = await store.get(key);
  if (cached !== null) {
    return JSON.parse(cached) as RawCandidate[];
  }

  const result = await client.query<{ candidates: RawCandidate[] }>(
    'select app.promotion_candidates($1) as candidates',
    [orgId],
  );
  const candidates = result.rows[0]?.candidates ?? [];
  await store.set(key, JSON.stringify(candidates), 'EX', PROMO_CACHE_TTL_SECONDS);
  return candidates;
}

/** Invalidate the org's promotion cache. Called on every promotion write. */
export async function invalidatePromotions(
  orgId: string,
  cache?: PromoCache,
): Promise<void> {
  await (cache ?? defaultPromoCache()).del(promoCacheKey(orgId));
}

export interface PromotionInput {
  name: string;
  type: 'bogo' | 'percent' | 'fixed';
  validFrom: Date;
  validTo: Date;
  priority?: number;
  stackable?: boolean;
  isActive?: boolean;
  conditions?: Record<string, unknown>;
}

/**
 * Create a promotion and invalidate the cache. A promotion write always invalidates, so the next
 * read repopulates from the database.
 */
export async function createPromotion(
  client: QueryRunner,
  orgId: string,
  input: PromotionInput,
  cache?: PromoCache,
): Promise<string> {
  if (input.validTo <= input.validFrom) {
    throw new PricingError('promotion valid_to must be after valid_from');
  }
  const result = await client.query<{ id: string }>(
    `insert into public.promotions
       (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning id`,
    [
      orgId,
      input.name,
      input.type,
      input.validFrom.toISOString(),
      input.validTo.toISOString(),
      input.priority ?? 100,
      input.stackable ?? false,
      input.isActive ?? true,
      JSON.stringify(input.conditions ?? {}),
    ],
  );
  await invalidatePromotions(orgId, cache);
  return result.rows[0]!.id;
}

/** Update a promotion and invalidate the cache. */
export async function updatePromotion(
  client: QueryRunner,
  orgId: string,
  promotionId: string,
  input: Partial<PromotionInput>,
  cache?: PromoCache,
): Promise<void> {
  await client.query(
    `update public.promotions
        set name       = coalesce($3, name),
            type       = coalesce($4, type),
            valid_from = coalesce($5::timestamptz, valid_from),
            valid_to   = coalesce($6::timestamptz, valid_to),
            priority   = coalesce($7, priority),
            stackable  = coalesce($8, stackable),
            is_active  = coalesce($9, is_active),
            conditions = coalesce($10::jsonb, conditions)
      where org_id = $1 and id = $2`,
    [
      orgId,
      promotionId,
      input.name ?? null,
      input.type ?? null,
      input.validFrom ? input.validFrom.toISOString() : null,
      input.validTo ? input.validTo.toISOString() : null,
      input.priority ?? null,
      input.stackable ?? null,
      input.isActive ?? null,
      input.conditions ? JSON.stringify(input.conditions) : null,
    ],
  );
  await invalidatePromotions(orgId, cache);
}

/** Deactivate a promotion and invalidate the cache. */
export async function deactivatePromotion(
  client: QueryRunner,
  orgId: string,
  promotionId: string,
  cache?: PromoCache,
): Promise<void> {
  await client.query(
    'update public.promotions set is_active = false where org_id = $1 and id = $2',
    [orgId, promotionId],
  );
  await invalidatePromotions(orgId, cache);
}

/**
 * Resolve the price of a whole cart in at most two database round trips: one for the candidate
 * promotions (only on a cache miss) and one for the batched price resolution. Never one query per
 * item.
 *
 * Precedence is enforced inside app.get_prices: the customer group's price list (falling back to
 * the retail list per item), then active promotions by priority, stacking only when stackable.
 */
export async function resolveCart(
  input: {
    client: QueryRunner;
    orgId: string;
    groupId: string | null;
    atTime: Date;
    items: ReadonlyArray<{ variantId: string; qty: Decimal.Value }>;
  },
  cache?: PromoCache,
): Promise<CartLine[]> {
  if (input.items.length === 0) return [];

  const candidates = await loadPromotionCandidates(input.client, input.orgId, cache);

  const variantIds = input.items.map((item) => item.variantId);
  const qtys = input.items.map((item) => new Decimal(item.qty).toFixed(4));

  const result = await input.client.query<RawPriceRow>(
    'select * from app.get_prices($1, $2, $3::uuid[], $4::numeric[], $5::timestamptz, $6::jsonb)',
    [input.orgId, input.groupId, variantIds, qtys, input.atTime.toISOString(), JSON.stringify(candidates)],
  );

  const qtyByVariant = new Map(input.items.map((item) => [item.variantId, new Decimal(item.qty)]));

  return result.rows.map((row) => {
    const resolved = toResolved(row);
    const qty = qtyByVariant.get(row.variant_id) ?? new Decimal(1);
    return {
      ...resolved,
      qty,
      lineTotal: money(resolved.unitPrice.times(qty)),
    };
  });
}

/** Resolve a single variant. Same precedence, same source information. */
export async function resolvePrice(
  input: {
    client: QueryRunner;
    orgId: string;
    groupId: string | null;
    variantId: string;
    qty?: Decimal.Value;
    atTime: Date;
  },
  cache?: PromoCache,
): Promise<ResolvedPrice | null> {
  const [line] = await resolveCart(
    {
      client: input.client,
      orgId: input.orgId,
      groupId: input.groupId,
      atTime: input.atTime,
      items: [{ variantId: input.variantId, qty: input.qty ?? 1 }],
    },
    cache,
  );
  return line ?? null;
}

/**
 * Manual discount (precedence step 3). The guard runs in SQL: a role with no discount_limits row
 * has a limit of zero, a discount above the limit is rejected, and a reason is required. The
 * recorded discount carries its reason.
 */
export async function applyManualDiscount(
  client: QueryRunner,
  input: {
    orgId: string;
    branchId: string;
    invoiceId: string;
    lineNo: number;
    role: string;
    subtotal: Decimal.Value;
    discount: Decimal.Value;
    reason: string;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.record_manual_discount($1, $2, $3, $4, $5, $6, $7, $8) as app',
    [
      input.orgId,
      input.branchId,
      input.invoiceId,
      input.lineNo,
      input.role,
      new Decimal(input.subtotal).toFixed(4),
      new Decimal(input.discount).toFixed(4),
      input.reason,
    ],
  );
  return result.rows[0]!.app;
}

/** Display-only conversion. Never feeds posting: the sale stores the rate it used. */
export async function convertForDisplay(
  client: QueryRunner,
  input: { orgId: string; amount: Decimal.Value; from: string; to: string; date: string },
): Promise<Decimal | null> {
  const result = await client.query<{ app: string | null }>(
    'select app.convert_for_display($1, $2, $3, $4, $5::date) as app',
    [input.orgId, new Decimal(input.amount).toFixed(4), input.from, input.to, input.date],
  );
  const value = result.rows[0]?.app;
  return value === null || value === undefined ? null : moneyFromSql(value);
}
