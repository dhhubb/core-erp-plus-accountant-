import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * R3 test 13 — a one-item exact cash sale completes in three actions, keyboard only.
 *
 * No mouse event is used anywhere in this test. The three actions are:
 *   1. scan the barcode and press Enter
 *   2. press F9 for exact cash
 *   3. press Enter to confirm and print
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

/** Mint an HS256 Supabase-style access token carrying the tenant claims. */
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
        `POS e2e ${suffix}`,
        `pos-e2e-${suffix}`,
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
         values ($1, app.next_number($1, 'SKU'), 'Keyboard widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const barcode = `E2E-${suffix}`;
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
    const email = `e2e-${suffix}@example.test`;
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

test('13. One-item exact cash sale completes in three actions, keyboard only', async ({ page }) => {
  const { token, barcode } = await seed();

  // Put the till's access token where the page reads it, before the app loads.
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  await page.goto('/pos');

  const scan = page.getByTestId('scan');
  await expect(scan).toBeFocused();

  // Action 1: the scanner types the barcode and sends Enter.
  await page.keyboard.type(barcode);
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByTestId('actions')).toHaveText('Actions 1');

  // Action 2: F9 tenders exact cash for the total.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('actions')).toHaveText('Actions 2');
  await expect(page.getByTestId('remaining')).toHaveText('Remaining 0.00');

  // Action 3: Enter confirms and prints.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('actions')).toHaveText('Actions 3');
  await expect(page.getByTestId('status')).toHaveText('paid');

  // The receipt shows the CORE invoice number and the paid total.
  const receipt = page.getByTestId('receipt');
  await expect(receipt).toContainText('Tax invoice');
  await expect(receipt).toContainText('000001');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('5.75');
});
