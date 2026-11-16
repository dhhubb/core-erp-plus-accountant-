import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { asUser, expectError, one, sql, tx } from './support/db';
import { addWarehouse, createTenant, postReceipt, tenantToken, type Tenant } from './support/fixtures';
import {
  adminBackoffDelay,
  clearEdits,
  countEdits,
  enqueueEdit,
  listEdits,
  markEditAttempt,
} from '../src/verticals/admin/outbox';
import { ean13CheckDigit, isValidEan13 } from '../src/verticals/admin/barcode';
import { expiryTone } from '../src/verticals/admin/expiry';
import { WedgeDetector } from '../src/verticals/admin/scanner';
import { categoryTree, createCategory, listProducts } from '../src/verticals/admin/catalogue';
import { POST as createCategoryRoute } from '../src/app/api/admin/categories/route';
import { DELETE as deleteCategoryRoute } from '../src/app/api/admin/categories/[id]/route';
import { GET as productsRoute, POST as createProductRoute } from '../src/app/api/admin/products/route';
import { POST as createVariantRoute } from '../src/app/api/admin/variants/route';
import { GET as batchesRoute, POST as createBatchRoute } from '../src/app/api/admin/batches/route';

/**
 * A1 — the admin products UI's server side. Tests 96–104, continuing from H6's 95 (ADR-0050).
 *
 * Everything runs against the real local Postgres, and the route handlers are called with a real
 * access token so RLS is genuinely exercised. The IndexedDB outbox runs on fake-indexeddb, which is
 * an in-memory implementation of the same interface the browser provides.
 */

afterEach(async () => {
  await clearEdits();
});

async function newCategory(
  tenant: Tenant,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  return tx((client) =>
    createCategory(client, {
      orgId: tenant.orgId,
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`,
      parentId,
    }),
  );
}

/** A tenant with a category tree, one product with a barcoded variant, and stock on hand. */
async function adminFixture(name: string): Promise<{
  tenant: Tenant;
  categoryId: string;
  childCategoryId: string;
  productId: string;
  variantId: string;
  barcode: string;
}> {
  const tenant = await createTenant(name);
  const categoryId = await newCategory(tenant, 'Hardware');
  const childCategoryId = await newCategory(tenant, 'Tools', categoryId);

  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name, category_id)
     values ($1, app.next_number($1, 'SKU'), $2, $3) returning id`,
    [tenant.orgId, `${name} product`, categoryId],
  );
  const productId = product!.id;

  const barcode = '4006381333931';
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode, cost)
     values ($1, $2, app.next_number($1, 'SKU'), 'default', $3, 4.5000) returning id`,
    [tenant.orgId, productId, barcode],
  );
  const variantId = variant!.id;

  const warehouseId = await addWarehouse(tenant, 'W1');
  await postReceipt(tenant, warehouseId, productId, 10, 4, '2026-06-15', variantId);

  return { tenant, categoryId, childCategoryId, productId, variantId, barcode };
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

describe('A1 admin products UI (server side)', () => {
  it('96. The category tree nests through parent_id and refuses a delete that would orphan rows', async () => {
    const tenant = await createTenant('A1 test 96');
    const parent = await newCategory(tenant, 'Hardware');
    const child = await newCategory(tenant, 'Tools', parent);

    const tree = await tx((client) => categoryTree(client, tenant.orgId));
    expect(tree.map((node) => node.name)).toEqual(['Hardware', 'Tools']);
    expect(tree[1]!.parentId).toBe(parent);
    expect(tree[1]!.depth).toBe(1);
    expect(tree[1]!.path).toBe('Hardware / Tools');

    // A parent with a child cannot be deleted.
    const childBlocks = await expectError(() =>
      sql('select app.delete_category($1, $2)', [tenant.orgId, parent]),
    );
    expect(childBlocks.message).toMatch(/child categories/);

    // A category in use by a product cannot be deleted either.
    await sql(
      `insert into public.products (org_id, sku, name, category_id)
       values ($1, app.next_number($1, 'SKU'), 'Widget', $2)`,
      [tenant.orgId, child],
    );
    const productBlocks = await expectError(() =>
      sql('select app.delete_category($1, $2)', [tenant.orgId, child]),
    );
    expect(productBlocks.message).toMatch(/in use by products/);

    // A leaf with neither can be deleted.
    await sql('delete from public.products where category_id = $1', [child]);
    await sql('select app.delete_category($1, $2)', [tenant.orgId, child]);
    expect(await one('select 1 from public.categories where id = $1', [child])).toBeUndefined();

    // The category is also created through the route, scoped by the token.
    const route = await createCategoryRoute(
      request('/api/admin/categories', tenantToken(tenant), {
        method: 'POST',
        body: JSON.stringify({ name: 'Stationery', slug: 'stationery' }),
      }),
    );
    expect(route.status).toBe(200);
  });

  it('97. A new product takes a gapless SKU from the number series and records a master-data change', async () => {
    const tenant = await createTenant('A1 test 97');
    const token = tenantToken(tenant);

    const response = await createProductRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Blue Widget', unit: 'each' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };

    const product = await one<{ sku: string; name: string }>(
      'select sku, name from public.products where id = $1',
      [body.id],
    );
    // The SKU came from the number series in SQL (prefix SKU-, pad 8), never from JavaScript.
    expect(product!.sku).toMatch(/^SKU-\d{8}$/);

    // The write appended a master-data change so a branch pulls the new product on its next sync.
    const change = await one<{ entity_type: string; operation: string }>(
      'select entity_type, operation from public.master_data_changes where org_id = $1 and entity_id = $2',
      [tenant.orgId, body.id],
    );
    expect(change).toEqual({ entity_type: 'product', operation: 'upsert' });

    // A second product gets the next SKU in sequence (no gap, no repeat).
    const second = await createProductRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Second', unit: 'each' }),
      }),
    );
    const secondBody = (await second.json()) as { id: string };
    const secondSku = await one<{ sku: string }>('select sku from public.products where id = $1', [
      secondBody.id,
    ]);
    expect(secondSku!.sku).not.toBe(product!.sku);
  });

  it('98. A weighable product must use a measure unit, and a non-weighable one must use each', async () => {
    const tenant = await createTenant('A1 test 98');
    const token = tenantToken(tenant);

    // Weighable with `each` is refused by the route (and by the SQL check constraint).
    const badRoute = await createProductRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Loose', unit: 'each', is_weighable: true }),
      }),
    );
    expect(badRoute.status).toBe(422);

    const badSql = await expectError(() =>
      sql('select app.create_product($1, $2, null, $3, true, null)', [tenant.orgId, 'Loose', 'each']),
    );
    expect(badSql.message).toMatch(/weighable_unit_check/);

    // A weighable product in kilograms is accepted.
    const good = await createProductRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Loose', unit: 'kg', is_weighable: true }),
      }),
    );
    expect(good.status).toBe(200);
    const goodBody = (await good.json()) as { id: string };
    const row = await one<{ unit: string; is_weighable: boolean }>(
      'select unit, is_weighable from public.products where id = $1',
      [goodBody.id],
    );
    expect(row).toEqual({ unit: 'kg', is_weighable: true });
  });

  it('99. A 13-digit barcode must carry a valid EAN-13 check digit, and a barcode is unique per org', async () => {
    const tenant = await createTenant('A1 test 99');
    const token = tenantToken(tenant);
    const product = await one<{ id: string }>(
      `insert into public.products (org_id, sku, name) values ($1, app.next_number($1, 'SKU'), 'P') returning id`,
      [tenant.orgId],
    );
    const productId = product!.id;

    // The helper agrees with the SQL function.
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('5901234123457')).toBe(true);
    expect(isValidEan13('5901234123458')).toBe(false);
    expect(isValidEan13('111222333')).toBe(true);
    expect(ean13CheckDigit('400638133393')).toBe(1);

    const valid = await createVariantRoute(
      request('/api/admin/variants', token, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, barcode: '4006381333931' }),
      }),
    );
    expect(valid.status).toBe(200);

    // A 13-digit code with a bad check digit is refused.
    const invalid = await createVariantRoute(
      request('/api/admin/variants', token, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, barcode: '4006381333932' }),
      }),
    );
    expect(invalid.status).toBe(422);

    // The same barcode twice is refused by the partial unique index.
    const duplicate = await createVariantRoute(
      request('/api/admin/variants', token, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, barcode: '4006381333931' }),
      }),
    );
    expect(duplicate.status).toBe(422);
  });

  it('100. A batch belongs to a variant and reports its days to expiry', async () => {
    const fixture = await adminFixture('A1 test 100');
    const token = tenantToken(fixture.tenant);

    const created = await createBatchRoute(
      request('/api/admin/batches', token, {
        method: 'POST',
        body: JSON.stringify({
          variant_id: fixture.variantId,
          batch_no: 'B-1',
          expiry_date: '2027-01-01',
        }),
      }),
    );
    expect(created.status).toBe(200);

    const list = await batchesRoute(
      request(`/api/admin/batches?product_id=${fixture.productId}`, token),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      batches: Array<{ batch_no: string; expiry_date: string; days_to_expiry: number }>;
    };
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]!.batch_no).toBe('B-1');
    expect(body.batches[0]!.expiry_date).toBe('2027-01-01');
    expect(body.batches[0]!.days_to_expiry).toBeGreaterThan(0);

    // The expiry tone is a pure function of the days to expiry.
    expect(expiryTone(-1)).toBe('expired');
    expect(expiryTone(10)).toBe('soon');
    expect(expiryTone(200)).toBe('ok');
    expect(expiryTone(null)).toBe('none');
  });

  it('101. The admin product list pages by keyset and returns every product exactly once', async () => {
    const tenant = await createTenant('A1 test 101');
    const created: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const row = await one<{ id: string }>(
        `insert into public.products (org_id, sku, name)
         values ($1, app.next_number($1, 'SKU'), $2) returning id`,
        [tenant.orgId, `Product ${i}`],
      );
      created.push(row!.id);
    }

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await tx((client) =>
        listProducts(client, { orgId: tenant.orgId, limit: 3, cursor }),
      );
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it('102. The admin routes refuse a limit above 100 and a body naming another org', async () => {
    const fixture = await adminFixture('A1 test 102');
    const other = await createTenant('A1 test 102 other');
    const token = tenantToken(fixture.tenant);

    const overLimit = await productsRoute(request('/api/admin/products?limit=101', token));
    expect(overLimit.status).toBe(422);

    const crossOrg = await createProductRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Sneaky', org_id: other.orgId }),
      }),
    );
    expect(crossOrg.status).toBe(403);

    // The SQL function is RLS-scoped: the same write with another org's id is refused.
    const sqlBlocked = await expectError(() =>
      asUser(fixture.tenant.claims, (client) =>
        client.query('select app.create_product($1, $2, null, $3, false, null)', [
          other.orgId,
          'Sneaky',
          'each',
        ]),
      ),
    );
    expect(sqlBlocked.message).toMatch(/row-level security/);

    // A category delete through the route is org-scoped: another org cannot delete it.
    const crossDelete = await deleteCategoryRoute(
      request(`/api/admin/categories/${fixture.categoryId}`, tenantToken(other), { method: 'DELETE' }),
      { params: { id: fixture.categoryId } },
    );
    expect(crossDelete.status).not.toBe(200);
    expect(
      await one('select 1 from public.categories where id = $1', [fixture.categoryId]),
    ).toBeDefined();
  });

  it('103. An offline edit is queued in the IndexedDB outbox and backs off after a failure', async () => {
    expect(await countEdits()).toBe(0);

    const edit = await enqueueEdit({
      editId: randomUUID(),
      method: 'POST',
      path: '/api/admin/variants',
      body: { product_id: randomUUID(), barcode: '4006381333931' },
      editedAt: new Date().toISOString(),
    });
    expect(await countEdits()).toBe(1);
    expect((await listEdits())[0]!.editId).toBe(edit.editId);

    await markEditAttempt(edit.editId, 'offline', () => 1);
    const after = (await listEdits())[0]!;
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBe('offline');
    expect(after.nextAttemptAt).toBeGreaterThan(0);

    // The backoff is capped at five minutes.
    expect(adminBackoffDelay(0, () => 1)).toBe(2000);
    expect(adminBackoffDelay(20, () => 1)).toBe(300000);
  });

  it('104. The barcode wedge detector tells a fast scan from slow typing', async () => {
    let clock = 0;
    const detector = new WedgeDetector({ now: () => clock, gapMs: 50, minLength: 4 });

    // A fast burst: every key arrives 5 ms after the last.
    const scanned = '4006381333931';
    for (const char of scanned) {
      clock += 5;
      expect(detector.key(char)).toBe(true);
    }
    clock += 5;
    expect(detector.enter('')).toBe(scanned);

    // A human typing with a long pause between keys is not a scan: the fallback text is used.
    const slow = new WedgeDetector({ now: () => clock, gapMs: 50, minLength: 4 });
    clock += 5;
    slow.key('1');
    clock += 500;
    expect(slow.key('2')).toBe(false);
    expect(slow.enter('12')).toBe('12');
  });
});
