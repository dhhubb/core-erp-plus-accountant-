import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asUser, expectError, one, sql } from './support/db';
import { addWarehouse, createTenant, postReceipt, type Tenant } from './support/fixtures';
import { searchProducts } from '../src/verticals/retail/products';
import { normaliseQuantity, QuantityError } from '../src/verticals/retail/quantity';

/** The tables R1 adds. Every one must obey the core tenancy invariants. */
const R1_TABLES = ['categories', 'product_batches'];

interface SeedProductOptions {
  name: string;
  barcode?: string | null;
  unit?: 'each' | 'kg' | 'g' | 'l' | 'ml' | 'pack';
  isWeighable?: boolean;
}

/** Insert a product and one variant. Returns the ids. */
async function addProductWithVariant(
  tenant: Tenant,
  options: SeedProductOptions,
): Promise<{ productId: string; variantId: string }> {
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name, unit, is_weighable)
     values ($1, app.next_number($1, 'SKU'), $2, $3, $4) returning id`,
    [tenant.orgId, options.name, options.unit ?? 'each', options.isWeighable ?? false],
  );
  const productId = product!.id;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), $3, $4) returning id`,
    [tenant.orgId, productId, `${options.name} default`, options.barcode ?? null],
  );
  return { productId, variantId: variant!.id };
}

/** Bulk-seed `count` products (each with one variant) so the trigram index has real work to do. */
async function seedCatalogue(
  tenant: Tenant,
  count: number,
  specialName = 'Blue Widget Deluxe',
): Promise<void> {
  await sql(
    `insert into public.products (org_id, sku, name)
     select $1, 'CAT-' || lpad(g::text, 8, '0'),
            'Catalogue item ' || g || case when g = 1 then ' ' || $3 else '' end
       from generate_series(1, $2) g`,
    [tenant.orgId, count, specialName],
  );
  await sql(
    `insert into public.product_variants (org_id, product_id, sku, name)
     select p.org_id, p.id, 'CATV-' || lpad(p.sku, 12, '0'), 'default'
       from public.products p
      where p.org_id = $1`,
    [tenant.orgId],
  );
  await sql('analyze public.products');
  await sql('analyze public.product_variants');
}

describe('R1 products, barcodes and search', () => {
  it('1. Barcode lookup returns the correct variant in under 100ms on 1,000 products', async () => {
    const tenant = await createTenant('R1 Barcode');
    const barcode = '5901234123457';
    const target = await addProductWithVariant(tenant, {
      name: 'Target Widget',
      barcode,
    });
    await seedCatalogue(tenant, 1000);

    const started = performance.now();
    const rows = await asUser(tenant.claims, (client) =>
      searchProducts(client, { orgId: tenant.orgId, query: barcode }),
    );
    const elapsed = performance.now() - started;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.variantId).toBe(target.variantId);
    expect(rows[0]!.productId).toBe(target.productId);
    expect(rows[0]!.matchType).toBe('barcode');
    expect(elapsed, `barcode lookup took ${elapsed.toFixed(1)}ms`).toBeLessThan(100);
  });

  it('2. Name search returns at most 20 results and EXPLAIN shows the trigram index', async () => {
    const tenant = await createTenant('R1 Search');
    await seedCatalogue(tenant, 20000);

    const rows = await asUser(tenant.claims, (client) =>
      searchProducts(client, { orgId: tenant.orgId, query: 'widget' }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(rows[0]!.matchType).toBe('name');
    expect(rows[0]!.productName).toContain('Widget');

    const plan = await sql<{ 'QUERY PLAN': unknown }>(
      `explain (format json) select * from app.search_products($1, $2, $3)`,
      [tenant.orgId, 'widget', 20],
    );
    const planText = JSON.stringify(plan);
    expect(planText, 'trigram index not used by the name search').toContain(
      'products_name_trgm_idx',
    );
  });

  it('3. Org A cannot read or search Org B rows in every R1 table', async () => {
    const a = await createTenant('R1 Org A');
    const b = await createTenant('R1 Org B');

    const category = await one<{ id: string }>(
      `insert into public.categories (org_id, name, slug) values ($1, 'B Cat', $2) returning id`,
      [b.orgId, `b-cat-${randomUUID().slice(0, 8)}`],
    );
    const variant = await addProductWithVariant(b, { name: 'Secret Widget', barcode: '111222333' });

    await sql(
      `insert into public.product_batches (org_id, variant_id, batch_no, expiry_date)
       values ($1, $2, 'B-BATCH', date '2030-01-01')`,
      [b.orgId, variant.variantId],
    );

    for (const table of R1_TABLES) {
      const rows = await asUser(a.claims, async (client) => {
        const result = await client.query<{ n: string }>(
          `select count(*)::text as n from public.${table} where org_id = $1`,
          [b.orgId],
        );
        return result.rows;
      });
      expect(rows[0]?.n, `${table} leaked Org B rows to Org A`).toBe('0');
    }

    // The categories row exists (seen by its owner) but is invisible to Org A.
    const ownerSees = await asUser(b.claims, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.categories where id = $1',
        [category!.id],
      );
      return result.rows[0]!.n;
    });
    expect(ownerSees).toBe('1');

    // Search must not cross the tenant boundary either: Org A searching Org B's barcode finds nothing.
    const searched = await asUser(a.claims, (client) =>
      searchProducts(client, { orgId: a.orgId, query: '111222333' }),
    );
    expect(searched).toHaveLength(0);

    const nameSearched = await asUser(a.claims, (client) =>
      searchProducts(client, { orgId: a.orgId, query: 'Secret Widget' }),
    );
    expect(nameSearched).toHaveLength(0);

    // An insert claiming another org's org_id is rejected by RLS WITH CHECK.
    const error = await expectError(() =>
      asUser(a.claims, async (client) => {
        await client.query(
          `insert into public.categories (org_id, name, slug) values ($1, 'Sneaky', $2)`,
          [b.orgId, `sneaky-${randomUUID().slice(0, 8)}`],
        );
      }),
    );
    expect(error.message).toMatch(/row-level security|violates/i);
  });

  it('4. A weighable product stores quantity 0.750 kg exactly', async () => {
    const tenant = await createTenant('R1 Weighable');
    const warehouseId = await addWarehouse(tenant, 'WH1');
    const { productId } = await addProductWithVariant(tenant, {
      name: 'Loose Apples',
      unit: 'kg',
      isWeighable: true,
    });

    expect(normaliseQuantity(true, '0.750')).toBe('0.7500');
    expect(normaliseQuantity(true, '0.75')).toBe('0.7500');

    await postReceipt(tenant, warehouseId, productId, '0.750', '2.50');

    const balance = await one<{ qty: string }>(
      `select qty::text as qty from public.stock_balances
        where org_id = $1 and warehouse_id = $2 and product_id = $3`,
      [tenant.orgId, warehouseId, productId],
    );
    expect(balance!.qty).toBe('0.7500');

    const ledger = await one<{ qty: string }>(
      `select qty::text as qty from public.stock_ledger
        where org_id = $1 and product_id = $2 and direction = 'in'`,
      [tenant.orgId, productId],
    );
    expect(ledger!.qty).toBe('0.7500');

    // A non-weighable product refuses a fractional quantity.
    expect(() => normaliseQuantity(false, '0.750')).toThrow(QuantityError);
    expect(normaliseQuantity(false, '3')).toBe('3.0000');
  });
});
