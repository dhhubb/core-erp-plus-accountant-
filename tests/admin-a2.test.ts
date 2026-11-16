import { afterAll, describe, expect, it } from 'vitest';
import { asUser, expectError, one, sql, tx } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { closeRedis, getRedis } from '../src/core/redis';
import { invalidatePromotions, promoCacheKey, resolvePrice, type PromoCache } from '../src/verticals/retail/pricing';
import { createPriceList, importPriceListItems, listPriceLists, listPriceListItems, pricePreview } from '../src/verticals/admin/pricing';
import { GET as priceListsRoute, POST as priceListsPostRoute } from '../src/app/api/admin/price-lists/route';
import { GET as itemsRoute } from '../src/app/api/admin/price-lists/[id]/items/route';
import { POST as previewRoute } from '../src/app/api/admin/pricing-preview/route';
import { POST as promotionsPostRoute } from '../src/app/api/admin/promotions/route';

/**
 * A2 — the admin pricing UI's server side. Tests 105–107, continuing from A1's 104 (ADR-0054).
 *
 * The brief called these 29–31, but Phase 1 already owns 29–31 (inventory), and ADR-0010 forbids
 * renumbering: a new run continues from the highest number actually present. See ADR-0054.
 *
 * Everything runs against the real local Postgres and the real local Redis, and the route handlers
 * are called with a real access token so RLS is genuinely exercised. Nothing is mocked.
 */
const cache: PromoCache = {
  get: (key) => getRedis().get(key),
  set: (key, value, mode, ttl) => getRedis().set(key, value, mode, ttl),
  del: (key) => getRedis().del(key),
};

afterAll(async () => {
  await closeRedis();
});

async function addVariant(tenant: Tenant, name = 'Priced Item'): Promise<{ variantId: string; productId: string }> {
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
  return { variantId: variant!.id, productId: product!.id };
}

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('A2 admin pricing UI (server side)', () => {
  it('105. A retail USD list is created, an item imported, and a 10% promotion then discounts through the cache', async () => {
    const tenant = await createTenant('A2 test 105');
    const token = tenantToken(tenant);

    // Create a retail USD price list through the route (RLS-scoped by the token).
    const created = await priceListsPostRoute(
      request('/api/admin/price-lists', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Retail', kind: 'retail', currency: 'USD' }),
      }),
    );
    expect(created.status).toBe(200);
    const listId = ((await created.json()) as { id: string }).id;

    const { variantId } = await addVariant(tenant, 'A2 priced');

    // Import the item with COPY (variant_id, price), the stocktake pattern.
    const imported = await tx((client) =>
      importPriceListItems(client, {
        orgId: tenant.orgId,
        priceListId: listId,
        lines: [{ variantId, price: '100.0000' }],
      }),
    );
    expect(imported).toBe(1);

    await invalidatePromotions(tenant.orgId, cache);

    // get_price returns the list price when no promotion is active.
    const plain = await asUser(tenant.claims, (client) =>
      resolvePrice({ client, orgId: tenant.orgId, groupId: null, variantId, atTime: new Date() }, cache),
    );
    expect(plain!.listPrice.toFixed(4)).toBe('100.0000');
    expect(plain!.unitPrice.toFixed(4)).toBe('100.0000');

    // Create a 10% promotion through the route; the write invalidates promos:{org_id}.
    const promo = await promotionsPostRoute(
      request('/api/admin/promotions', token, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Ten percent',
          type: 'percent',
          valid_from: new Date(Date.now() - 60_000).toISOString(),
          valid_to: new Date(Date.now() + 3_600_000).toISOString(),
          priority: 10,
          conditions: { value: 10 },
        }),
      }),
    );
    expect(promo.status).toBe(200);
    const promotionId = ((await promo.json()) as { id: string }).id;

    // The cache was invalidated by the write, so the next read repopulates and returns the promo.
    expect(await getRedis().get(promoCacheKey(tenant.orgId))).toBeNull();

    const discounted = await asUser(tenant.claims, (client) =>
      resolvePrice({ client, orgId: tenant.orgId, groupId: null, variantId, atTime: new Date() }, cache),
    );
    expect(discounted!.listPrice.toFixed(4)).toBe('100.0000');
    expect(discounted!.unitPrice.toFixed(4)).toBe('90.0000');
    expect(discounted!.discount.toFixed(4)).toBe('10.0000');
    expect(discounted!.source.promotionId).toBe(promotionId);

    // And the cache now holds the candidate again.
    expect(await getRedis().get(promoCacheKey(tenant.orgId))).not.toBeNull();

    // The route lists the price list with its item count.
    const listResponse = await priceListsRoute(request('/api/admin/price-lists', token));
    const listBody = (await listResponse.json()) as {
      price_lists: Array<{ id: string; item_count: number; currency: string }>;
    };
    const row = listBody.price_lists.find((entry) => entry.id === listId);
    expect(row?.item_count).toBe(1);
    expect(row?.currency).toBe('USD');

    // Part A rules: a limit above 100 is refused, and a body naming another org is refused.
    const tooBig = await itemsRoute(
      request(`/api/admin/price-lists/${listId}/items?limit=101`, token),
      { params: { id: listId } },
    );
    expect(tooBig.status).toBe(422);

    const otherTenant = await createTenant('A2 test 105 other');
    const crossOrg = await priceListsPostRoute(
      request('/api/admin/price-lists', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Sneaky', kind: 'retail', org_id: otherTenant.orgId }),
      }),
    );
    expect(crossOrg.status).toBe(403);
  });

  it('106. Precedence holds in the preview and a manual discount above the role limit is rejected with a reason required', async () => {
    const tenant = await createTenant('A2 test 106');
    const token = tenantToken(tenant);

    const retail = await tx((client) =>
      createPriceList(client, { orgId: tenant.orgId, name: 'Retail', kind: 'retail', currency: 'USD' }),
    );
    const wholesale = await tx((client) =>
      createPriceList(client, { orgId: tenant.orgId, name: 'Wholesale', kind: 'wholesale', currency: 'USD' }),
    );

    const { variantId } = await addVariant(tenant, 'A2 precedence');
    await sql(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       values ($1, $2, $3, 100.0000), ($1, $4, $3, 80.0000)`,
      [tenant.orgId, retail, variantId, wholesale],
    );

    const group = await one<{ id: string }>(
      `insert into public.customer_groups (org_id, name, price_list_id)
       values ($1, 'VIP', $2) returning id`,
      [tenant.orgId, wholesale],
    );

    // A 10% promotion, and a 5% manual limit for the member role.
    await tx((client) =>
      client.query(
        `insert into public.promotions
           (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
         values ($1, 'Ten percent', 'percent', now() - interval '1 hour', now() + interval '1 hour',
                 10, false, true, '{"value": 10}'::jsonb)`,
        [tenant.orgId],
      ),
    );
    await sql(
      `insert into public.discount_limits (org_id, role, max_percent) values ($1, 'member', 5.0000)
       on conflict (org_id, role) do update set max_percent = excluded.max_percent`,
      [tenant.orgId],
    );

    // Precedence in the preview: step 1 the group's wholesale list (80), step 2 the 10% promo (72).
    const preview = await asUser(tenant.claims, (client) =>
      pricePreview(client, {
        orgId: tenant.orgId,
        variantId,
        groupId: group!.id,
        atTime: new Date(),
        role: 'member',
      }),
    );
    expect(preview!.listPrice.toFixed(4)).toBe('80.0000');
    expect(preview!.unitPrice.toFixed(4)).toBe('72.0000');
    expect(preview!.sourcePriceListKind).toBe('wholesale');
    expect(preview!.sourcePromotionName).toBe('Ten percent');
    // The manual-discount ceiling for the member role is 5% of 80 = 4.00.
    expect(preview!.manualMaxAmount.toFixed(4)).toBe('4.0000');
    expect(preview!.steps.map((step) => step.step)).toEqual([1, 2, 3]);

    // A 5% manual discount (4.00) is allowed and yields 68.00.
    const allowed = await asUser(tenant.claims, (client) =>
      pricePreview(client, {
        orgId: tenant.orgId,
        variantId,
        groupId: group!.id,
        atTime: new Date(),
        role: 'member',
        manualDiscount: '4.0000',
        reason: 'Damaged packaging',
      }),
    );
    expect(allowed!.manualDiscount.toFixed(4)).toBe('4.0000');
    expect(allowed!.effectivePrice.toFixed(4)).toBe('68.0000');

    // 6% of 80 = 4.80 exceeds the 5% limit -> rejected.
    const overLimit = await expectError(() =>
      asUser(tenant.claims, (client) =>
        pricePreview(client, {
          orgId: tenant.orgId,
          variantId,
          groupId: group!.id,
          atTime: new Date(),
          role: 'member',
          manualDiscount: '4.8000',
          reason: 'Too generous',
        }),
      ),
    );
    expect(overLimit.message).toMatch(/exceeds the limit/i);

    // A discount with no reason is rejected.
    const noReason = await expectError(() =>
      asUser(tenant.claims, (client) =>
        pricePreview(client, {
          orgId: tenant.orgId,
          variantId,
          groupId: group!.id,
          atTime: new Date(),
          role: 'member',
          manualDiscount: '1.0000',
          reason: '   ',
        }),
      ),
    );
    expect(noReason.message).toMatch(/requires a reason/i);

    // The route surfaces the over-limit discount as a 422.
    const routeRejected = await previewRoute(
      request('/api/admin/pricing-preview', token, {
        method: 'POST',
        body: JSON.stringify({
          variant_id: variantId,
          group_id: group!.id,
          role: 'member',
          manual_discount: '4.8000',
          reason: 'Nope',
        }),
      }),
    );
    expect(routeRejected.status).toBe(422);
  });

  it('107. Importing 1000 price list items with COPY completes in under 3 seconds, and get_price uses an index', async () => {
    const tenant = await createTenant('A2 test 107');
    const retail = await tx((client) =>
      createPriceList(client, { orgId: tenant.orgId, name: 'Retail', kind: 'retail', currency: 'USD' }),
    );

    // Seed 1000 variants, then build the (variant_id, price) import lines.
    await sql(
      `insert into public.products (org_id, sku, name)
       select $1, 'A2B-' || lpad(g::text, 8, '0'), 'A2 bulk ' || g
         from generate_series(1, 1000) g`,
      [tenant.orgId],
    );
    await sql(
      `insert into public.product_variants (org_id, product_id, sku, name)
       select p.org_id, p.id, 'A2BV-' || lpad(p.sku, 12, '0'), 'default'
         from public.products p
        where p.org_id = $1 and p.sku like 'A2B-%'`,
      [tenant.orgId],
    );
    const variants = await sql<{ id: string }>(
      `select v.id from public.product_variants v
        where v.org_id = $1 and v.sku like 'A2BV-%' order by v.sku`,
      [tenant.orgId],
    );
    expect(variants).toHaveLength(1000);

    const lines = variants.map((variant, index) => ({
      variantId: variant.id,
      price: `${(10 + index * 0.01).toFixed(4)}`,
    }));

    const started = performance.now();
    const imported = await tx((client) =>
      importPriceListItems(client, { orgId: tenant.orgId, priceListId: retail, lines }),
    );
    const elapsed = performance.now() - started;

    expect(imported).toBe(1000);
    const stored = await one<{ count: string }>(
      'select count(*)::text as count from public.price_list_items where price_list_id = $1',
      [retail],
    );
    expect(stored!.count).toBe('1000');
    expect(elapsed, `COPY import of 1000 items took ${elapsed.toFixed(1)}ms`).toBeLessThan(3000);

    // The item page walks every row exactly once by keyset.
    const seen = new Set<string>();
    let cursor: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 40; page += 1) {
      const result = await tx((client) =>
        listPriceListItems(client, { orgId: tenant.orgId, priceListId: retail, limit: 100, cursor }),
      );
      for (const row of result.rows) {
        expect(seen.has(row.id), 'a keyset page must not repeat a row').toBe(false);
        seen.add(row.id);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen.size).toBe(1000);

    // The list is a keyset page too.
    const listPage = await tx((client) => listPriceLists(client, { orgId: tenant.orgId, limit: 50 }));
    expect(listPage.rows.map((row) => row.id)).toContain(retail);

    // The gate: EXPLAIN on get_price must reach price_list_items through an index, never a
    // sequential scan. Which index the planner picks may vary with the data (the variant key or the
    // org/list index), so the assertion is on the access method, not a specific index name.
    await sql('analyze public.price_list_items');
    const plan = await sql<{ 'QUERY PLAN': unknown }>(
      `explain (format json) select * from app.get_price($1, $2, $3, $4::timestamptz, $5)`,
      [tenant.orgId, variants[0]!.id, null, new Date().toISOString(), 1],
    );
    const nodes = JSON.stringify(plan).match(/\{[^{}]*\}/g) ?? [];
    const scansOfItems = nodes.filter((node) => node.includes('price_list_items'));
    expect(scansOfItems.length, 'get_price should touch price_list_items').toBeGreaterThan(0);
    for (const node of scansOfItems) {
      expect(node, 'get_price must not sequential-scan price_list_items').not.toContain('"Seq Scan"');
    }
    expect(
      scansOfItems.some((node) => node.includes('"Index Scan"') || node.includes('"Index Only Scan"')),
      'get_price should reach price_list_items through an index',
    ).toBe(true);
  });
});
