import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * R4 — the offline till. The network is cut, a sale is rung, the page is reloaded (so only
 * IndexedDB carries the queued sale), the network is restored, and the outbox drains itself.
 *
 * The sale must reach the ledger exactly once, with the client_sale_id it was rung under.
 */

const JWT_SECRET =
  POS_ENV.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintToken(claims: {
  sub: string;
  orgId: string;
  branchIds: string[];
  email: string;
}): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: claims.sub,
      role: 'authenticated',
      email: claims.email,
      org_id: claims.orgId,
      branch_ids: claims.branchIds,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

interface Seed {
  token: string;
  barcode: string;
  orgId: string;
}

async function seed(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [
        `Offline e2e ${suffix}`,
        `offline-e2e-${suffix}`,
      ])
    ).rows[0].id as string;

    const branch = (
      await client.query(
        `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const warehouse = (
      await client.query(
        `insert into public.warehouses (org_id, branch_id, code, name)
         values ($1, $2, 'W1', 'W1') returning id`,
        [org, branch],
      )
    ).rows[0].id as string;

    const product = (
      await client.query(
        `insert into public.products (org_id, sku, name)
         values ($1, app.next_number($1, 'SKU'), 'Offline widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const barcode = `OFF-${suffix}`;
    const variant = (
      await client.query(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [org, product, barcode],
      )
    ).rows[0].id as string;

    const priceList = (
      await client.query(
        `insert into public.price_lists (org_id, name, kind)
         values ($1, 'Retail', 'retail') returning id`,
        [org],
      )
    ).rows[0].id as string;

    await client.query(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       values ($1, $2, $3, 5.0000)`,
      [org, priceList, variant],
    );

    await client.query(
      `select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`,
      [org, branch, warehouse, product, variant],
    );

    const userId = crypto.randomUUID();
    const email = `offline-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    return {
      token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }),
      barcode,
      orgId: org,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

async function saleCount(orgId: string): Promise<number> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 1 });
  try {
    const result = await pool.query(
      'select count(*)::int as n from public.pos_sales where org_id = $1',
      [orgId],
    );
    return result.rows[0].n as number;
  } finally {
    await pool.end();
  }
}

test('14. An offline sale survives reload and syncs when the network returns', async ({ page }) => {
  const { token, barcode, orgId } = await seed();

  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  // Cut the network to the sale and sync endpoints. Everything else still loads.
  await page.route('**/api/pos/sales', (route) => route.abort());
  await page.route('**/api/pos/sync', (route) => route.abort());

  await page.goto('/pos');
  await expect(page.getByTestId('scan')).toBeFocused();

  // Ring one item and confirm. The POST fails, so the sale is queued.
  await page.keyboard.type(barcode);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await page.keyboard.press('F9');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status')).toHaveText('queued');
  await expect(page.getByTestId('pending')).toHaveText('Pending 1');

  // Nothing reached the server yet.
  expect(await saleCount(orgId)).toBe(0);

  // Reload the page: the queued sale must come back from IndexedDB.
  await page.reload();
  await expect(page.getByTestId('pending')).toHaveText('Pending 1', { timeout: 20_000 });

  // Restore the network. The sync loop drains the outbox on its own.
  await page.unroute('**/api/pos/sales');
  await page.unroute('**/api/pos/sync');

  await expect(page.getByTestId('pending')).toHaveText('Pending 0', { timeout: 40_000 });
  await expect.poll(() => saleCount(orgId), { timeout: 40_000 }).toBe(1);

  // Exactly one sale, one invoice: the idempotency key did its job.
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 1 });
  try {
    const invoices = await pool.query(
      'select count(*)::int as n from public.invoices where org_id = $1',
      [orgId],
    );
    expect(invoices.rows[0].n).toBe(1);
  } finally {
    await pool.end();
  }
});
