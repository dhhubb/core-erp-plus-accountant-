import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { asUser, expectError, one, sql, tx } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { closeRedis, getRedis } from '../src/core/redis';
import {
  PROMO_CACHE_TTL_SECONDS,
  applyManualDiscount,
  convertForDisplay,
  createPromotion,
  invalidatePromotions,
  promoCacheKey,
  resolveCart,
  resolvePrice,
  type PromoCache,
  type QueryRunner,
} from '../src/verticals/retail/pricing';

/**
 * These tests use the real local Redis (started outside the test process). Nothing is mocked:
 * the cache assertions read the real key back, and the "3 minutes old" test writes a real Redis
 * key with a real TTL, so the expiry rule is genuinely exercised.
 */
const cache: PromoCache = {
  get: (key) => getRedis().get(key),
  set: (key, value, mode, ttl) => getRedis().set(key, value, mode, ttl),
  del: (key) => getRedis().del(key),
};

afterAll(async () => {
  await closeRedis();
});

interface SeedLine {
  variantId: string;
  productId: string;
}

/** A product + variant, and a price on the given list. */
async function addPricedVariant(
  tenant: Tenant,
  listId: string,
  price: string,
  name = 'Priced Item',
): Promise<SeedLine> {
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), $2) returning id`,
    [tenant.orgId, name],
  );
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name)
     values ($1, $2, app.next_number($1, 'SKU'), 'default') returning id`,
    [tenant.orgId, product!.id],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, $4)`,
    [tenant.orgId, listId, variant!.id, price],
  );
  return { variantId: variant!.id, productId: product!.id };
}

async function addPriceList(tenant: Tenant, kind: 'retail' | 'wholesale'): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, $2, $3) returning id`,
    [tenant.orgId, kind === 'retail' ? 'Retail' : 'Wholesale', kind],
  );
  return row!.id;
}

describe('R2 pricing and promotions', () => {
  it('5. Matching promotion applies automatically from cache', async () => {
    const tenant = await createTenant('R2 Promo');
    const listId = await addPriceList(tenant, 'retail');
    const { variantId } = await addPricedVariant(tenant, listId, '100.0000');

    await sql('delete from public.promotions where org_id = $1', [tenant.orgId]);
    await invalidatePromotions(tenant.orgId, cache);

    const promotionId = await tx(async (client) =>
      createPromotion(
        client as unknown as QueryRunner,
        tenant.orgId,
        {
          name: '10 percent off',
          type: 'percent',
          validFrom: new Date(Date.now() - 60_000),
          validTo: new Date(Date.now() + 3_600_000),
          priority: 10,
          conditions: { value: 10 },
        },
        cache,
      ),
    );

    // First read populates the cache from the database.
    const first = await asUser(tenant.claims, (client) =>
      resolvePrice(
        { client, orgId: tenant.orgId, groupId: null, variantId, atTime: new Date() },
        cache,
      ),
    );
    expect(first!.listPrice.toFixed(4)).toBe('100.0000');
    expect(first!.unitPrice.toFixed(4)).toBe('90.0000');
    expect(first!.discount.toFixed(4)).toBe('10.0000');
    expect(first!.source.promotionId).not.toBeNull();

    // The cache now holds the candidate (never a resolved price), so the second read comes from
    // Redis. The candidate carries the promotion id, type and validity window, not the name.
    const cached = await getRedis().get(promoCacheKey(tenant.orgId));
    expect(cached).not.toBeNull();
    expect(cached).toContain(promotionId);
    expect(cached).toContain('"type":"percent"');

    const second = await asUser(tenant.claims, (client) =>
      resolvePrice(
        { client, orgId: tenant.orgId, groupId: null, variantId, atTime: new Date() },
        cache,
      ),
    );
    expect(second!.unitPrice.toFixed(4)).toBe('90.0000');
  });

  it('6. Promotion past valid_to not applied, even when the cache entry is 3 minutes old', async () => {
    const tenant = await createTenant('R2 Expiry');
    const listId = await addPriceList(tenant, 'retail');
    const { variantId } = await addPricedVariant(tenant, listId, '50.0000');

    await sql('delete from public.promotions where org_id = $1', [tenant.orgId]);
    await invalidatePromotions(tenant.orgId, cache);

    // A promotion that is already expired.
    await sql(
      `insert into public.promotions
         (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
       values ($1, 'Expired promo', 'percent', now() - interval '2 hours', now() - interval '1 hour',
               10, false, true, '{"value": 25}'::jsonb)`,
      [tenant.orgId],
    );

    // Write a real cache entry with a real 300s TTL, as if it had been populated 3 minutes ago.
    // It deliberately still contains the (now expired) candidate.
    const staleCandidates = JSON.stringify([
      {
        id: randomUUID(),
        type: 'percent',
        priority: 10,
        stackable: false,
        valid_from: new Date(Date.now() - 7_200_000).toISOString(),
        valid_to: new Date(Date.now() - 3_600_000).toISOString(),
        is_active: true,
        conditions: { value: 25 },
      },
    ]);
    await cache.set(promoCacheKey(tenant.orgId), staleCandidates, 'EX', PROMO_CACHE_TTL_SECONDS);

    const ttl = await getRedis().ttl(promoCacheKey(tenant.orgId));
    expect(ttl, 'the stale cache entry should still be alive').toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PROMO_CACHE_TTL_SECONDS);

    // The cache still holds the expired candidate, yet the price is the full list price: the
    // validity window is re-checked at evaluation time.
    const resolved = await asUser(tenant.claims, (client) =>
      resolvePrice(
        { client, orgId: tenant.orgId, groupId: null, variantId, atTime: new Date() },
        cache,
      ),
    );
    expect(resolved!.listPrice.toFixed(4)).toBe('50.0000');
    expect(resolved!.unitPrice.toFixed(4)).toBe('50.0000');
    expect(resolved!.discount.toFixed(4)).toBe('0.0000');
    expect(resolved!.source.promotionId).toBeNull();
  });

  it('7. Precedence holds, and a manual discount above the role limit is rejected', async () => {
    const tenant = await createTenant('R2 Precedence');
    const retailId = await addPriceList(tenant, 'retail');
    const wholesaleId = await addPriceList(tenant, 'wholesale');

    const onBoth = await addPricedVariant(tenant, retailId, '100.0000', 'Both Lists');
    await sql(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       values ($1, $2, $3, 80.0000)`,
      [tenant.orgId, wholesaleId, onBoth.variantId],
    );
    const retailOnly = await addPricedVariant(tenant, retailId, '40.0000', 'Retail Only');

    const group = await one<{ id: string }>(
      `insert into public.customer_groups (org_id, name, price_list_id)
       values ($1, 'VIP', $2) returning id`,
      [tenant.orgId, wholesaleId],
    );

    await sql('delete from public.promotions where org_id = $1', [tenant.orgId]);
    await invalidatePromotions(tenant.orgId, cache);

    // A non-stackable 10% promotion.
    await sql(
      `insert into public.promotions
         (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
       values ($1, 'Ten percent', 'percent', now() - interval '1 hour', now() + interval '1 hour',
               10, false, true, '{"value": 10}'::jsonb)`,
      [tenant.orgId],
    );

    const lines = await asUser(tenant.claims, (client) =>
      resolveCart(
        {
          client,
          orgId: tenant.orgId,
          groupId: group!.id,
          atTime: new Date(),
          items: [
            { variantId: onBoth.variantId, qty: 1 },
            { variantId: retailOnly.variantId, qty: 1 },
          ],
        },
        cache,
      ),
    );

    // Step 1: the group's (wholesale) list wins where the variant is on it; the retail list is the
    // per-item fallback where it is not.
    expect(lines[0]!.listPrice.toFixed(4)).toBe('80.0000');
    expect(lines[0]!.unitPrice.toFixed(4)).toBe('72.0000');
    expect(lines[1]!.listPrice.toFixed(4)).toBe('40.0000');
    expect(lines[1]!.unitPrice.toFixed(4)).toBe('36.0000');

    // Step 3: a manual discount is capped per role, and always needs a reason.
    await sql(
      `insert into public.discount_limits (org_id, role, max_percent) values ($1, 'member', 5.0000)
       on conflict (org_id, role) do update set max_percent = excluded.max_percent`,
      [tenant.orgId],
    );

    const invoice = await one<{ id: string }>(
      `insert into public.invoices
         (org_id, branch_id, invoice_no, invoice_date, subtotal, tax_total, total)
       values ($1, $2, $3, current_date, 100, 0, 100) returning id`,
      [tenant.orgId, tenant.branchId, `R2-INV-${randomUUID().slice(0, 8)}`],
    );

    // 5% of 100 = 5.00 is allowed.
    const okId = await asUser(tenant.claims, (client) =>
      applyManualDiscount(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        invoiceId: invoice!.id,
        lineNo: 1,
        role: 'member',
        subtotal: '100.0000',
        discount: '5.0000',
        reason: 'Damaged packaging',
      }),
    );
    expect(okId).toBeTruthy();

    const stored = await one<{ amount: string; reason: string }>(
      'select amount::text as amount, reason from public.manual_discounts where id = $1',
      [okId],
    );
    expect(stored!.amount).toBe('5.0000');
    expect(stored!.reason).toBe('Damaged packaging');

    // 6% of 100 = 6.00 exceeds the 5% limit.
    const overLimit = await expectError(() =>
      asUser(tenant.claims, (client) =>
        applyManualDiscount(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          invoiceId: invoice!.id,
          lineNo: 1,
          role: 'member',
          subtotal: '100.0000',
          discount: '6.0000',
          reason: 'Too generous',
        }),
      ),
    );
    expect(overLimit.message).toMatch(/exceeds the limit/i);

    // A discount with no reason is rejected.
    const noReason = await expectError(() =>
      asUser(tenant.claims, (client) =>
        applyManualDiscount(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          invoiceId: invoice!.id,
          lineNo: 1,
          role: 'member',
          subtotal: '100.0000',
          discount: '1.0000',
          reason: '   ',
        }),
      ),
    );
    expect(noReason.message).toMatch(/requires a reason/i);

    // USD is the base currency, so a display conversion is the identity.
    const same = await asUser(tenant.claims, (client) =>
      convertForDisplay(client, {
        orgId: tenant.orgId,
        amount: '100.0000',
        from: 'USD',
        to: 'USD',
        date: '2026-06-15',
      }),
    );
    expect(same!.toFixed(4)).toBe('100.0000');
  });

  it('8. A 30-item cart resolves prices in at most two database queries, and get_price uses an index', async () => {
    const tenant = await createTenant('R2 Cart');
    const retailId = await addPriceList(tenant, 'retail');

    const items: Array<{ variantId: string; qty: number }> = [];
    for (let i = 0; i < 30; i += 1) {
      const line = await addPricedVariant(tenant, retailId, `${(10 + i).toFixed(4)}`, `Cart ${i}`);
      items.push({ variantId: line.variantId, qty: 1 });
    }

    // Bulk-seed the price table so the planner has a real choice, then analyse it. Without this the
    // table is tiny and a sequential scan would be a legitimate (if uninformative) plan. Only
    // price_list_items is analysed: re-analysing the shared products table would perturb the
    // planner for other test files.
    await sql(
      `insert into public.products (org_id, sku, name)
       select $1, 'R2B-' || lpad(g::text, 8, '0'), 'R2 bulk ' || g
         from generate_series(1, 2000) g`,
      [tenant.orgId],
    );
    await sql(
      `insert into public.product_variants (org_id, product_id, sku, name)
       select p.org_id, p.id, 'R2BV-' || lpad(p.sku, 12, '0'), 'default'
         from public.products p
        where p.org_id = $1 and p.sku like 'R2B-%'`,
      [tenant.orgId],
    );
    await sql(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       select v.org_id, $2, v.id, 10.0000
         from public.product_variants v
        where v.org_id = $1 and v.sku like 'R2BV-%'`,
      [tenant.orgId, retailId],
    );
    await sql('analyze public.price_list_items');

    await sql('delete from public.promotions where org_id = $1', [tenant.orgId]);
    await invalidatePromotions(tenant.orgId, cache);
    await sql(
      `insert into public.promotions
         (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
       values ($1, 'Five percent', 'percent', now() - interval '1 hour', now() + interval '1 hour',
               10, false, true, '{"value": 5}'::jsonb)`,
      [tenant.orgId],
    );

    // Count the real round trips the resolver makes, by wrapping the real user-scoped client in a
    // thin counting proxy. Nothing is mocked: the queries still hit Postgres as the user.
    function countingClient(client: Parameters<Parameters<typeof asUser>[1]>[0]): {
      runner: QueryRunner;
      count: () => number;
    } {
      let n = 0;
      const runner: QueryRunner = {
        query: async <T>(text: string, params?: unknown[]) => {
          n += 1;
          const result = await client.query(text, params);
          return { rows: result.rows as T[] };
        },
      };
      return { runner, count: () => n };
    }

    await invalidatePromotions(tenant.orgId, cache);
    const cold = await asUser(tenant.claims, async (client) => {
      const counter = countingClient(client);
      const start = performance.now();
      const resolved = await resolveCart(
        {
          client: counter.runner,
          orgId: tenant.orgId,
          groupId: null,
          atTime: new Date(),
          items,
        },
        cache,
      );
      return { resolved, queries: counter.count(), elapsed: performance.now() - start };
    });

    expect(cold.resolved).toHaveLength(30);
    for (const line of cold.resolved) {
      // 5% off the list price.
      expect(line.unitPrice.toFixed(4)).toBe(line.listPrice.times(0.95).toFixed(4));
    }
    expect(cold.queries, 'a 30-item cart must not run one query per item').toBeLessThanOrEqual(2);
    expect(cold.elapsed, `cart resolution took ${cold.elapsed.toFixed(1)}ms`).toBeLessThan(1000);

    // Warm cache: the candidate read is skipped, so the cart costs a single batched query.
    const warm = await asUser(tenant.claims, async (client) => {
      const counter = countingClient(client);
      await resolveCart(
        {
          client: counter.runner,
          orgId: tenant.orgId,
          groupId: null,
          atTime: new Date(),
          items,
        },
        cache,
      );
      return counter.count();
    });
    expect(warm, 'a warm cart should be one batched query').toBe(1);

    // EXPLAIN must choose the price_list_items index, i.e. no per-item scan of the price table.
    // In JSON format a sequential scan shows as {"Node Type":"Seq Scan","Relation Name":"..."},
    // so assert on the index name (positive) and the node/relation pair (negative).
    const plan = await sql<{ 'QUERY PLAN': unknown }>(
      `explain (format json)
       select * from app.get_price($1, $2, $3, $4::timestamptz, $5)`,
      [tenant.orgId, items[0]!.variantId, null, new Date().toISOString(), 1],
    );
    const planText = JSON.stringify(plan);
    expect(planText, 'get_price should use the price_list_items variant index').toContain(
      'price_list_items_list_variant_key',
    );
    const nodes = JSON.stringify(plan).match(/\{[^{}]*\}/g) ?? [];
    const seqScanOnPrices = nodes.some(
      (node) => node.includes('"Seq Scan"') && node.includes('price_list_items'),
    );
    expect(seqScanOnPrices, 'get_price must not sequential-scan price_list_items').toBe(false);
  });
});
