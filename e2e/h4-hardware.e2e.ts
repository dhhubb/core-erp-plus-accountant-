import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * H4 — hardware and receipts, keyboard only.
 *
 *   * a keyboard-wedge scan works with the scan field NOT focused (the till reads the document),
 *   * F2 focuses the scan field, F3 holds the cart, F4 recalls it,
 *   * F9 opens payment with the exact amount preselected and Enter confirms,
 *   * the receipt is correct: shop header, VAT breakdown, USD and ZWG totals, footer.
 */

const JWT_SECRET =
  POS_ENV.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintToken(claims: { sub: string; orgId: string; branchIds: string[]; email: string }): string {
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
}

async function seed(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [`H4 e2e ${suffix}`, `h4-e2e-${suffix}`])
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
         values ($1, app.next_number($1, 'SKU'), 'H4 widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const barcode = `H4-${suffix}`;
    const variant = (
      await client.query(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [org, product, barcode],
      )
    ).rows[0].id as string;

    const priceList = (
      await client.query(
        `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
        [org],
      )
    ).rows[0].id as string;

    await client.query(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       values ($1, $2, $3, 5.0000)`,
      [org, priceList, variant],
    );

    await client.query(`select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`, [
      org,
      branch,
      warehouse,
      product,
      variant,
    ]);

    const userId = crypto.randomUUID();
    const email = `h4-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    return { token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }), barcode };
  } finally {
    client.release();
    await pool.end();
  }
}

async function openTill(page: import('@playwright/test').Page, token: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );
  await page.goto('/pos');
}

test('H4. A scan works with the field blurred, F3 holds, F4 recalls, F9 pays, the receipt is correct', async ({
  page,
}) => {
  const { token, barcode } = await seed();
  await openTill(page, token);

  const scan = page.getByTestId('scan');
  await expect(scan).toBeFocused();

  // Blur the scan field: a keyboard-wedge scan must still be read, because the till reads the
  // document, not just the field.
  await scan.evaluate((element: HTMLInputElement) => element.blur());
  await expect(scan).not.toBeFocused();

  await page.keyboard.type(barcode, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-line')).toHaveCount(1);

  // F3 holds the cart: it is parked and the till is empty for the next customer.
  await page.keyboard.press('F3');
  await expect(page.getByTestId('cart-line')).toHaveCount(0);
  await expect(page.getByTestId('held')).toHaveText('Held 1');

  // F4 recalls it.
  await page.keyboard.press('F4');
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByTestId('held')).toHaveText('Held 0');

  // F2 focuses the scan field.
  await page.keyboard.press('F2');
  await expect(scan).toBeFocused();

  // F9 opens payment with the exact amount preselected; the remaining balance is zero.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('pay-panel')).toBeVisible();
  await expect(page.getByTestId('remaining')).toHaveText('Remaining 0.00');

  // Enter confirms and prints.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status')).toHaveText('paid');

  // The receipt is correct.
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByTestId('receipt-shop')).toBeVisible();
  await expect(receipt.getByTestId('receipt-vat-number')).toContainText('VAT');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('5.75');
  await expect(receipt.getByTestId('receipt-total-zwg')).toHaveText('172.50');
  await expect(receipt.getByTestId('receipt-vat-band')).toContainText('VAT 15%');
  await expect(receipt.getByTestId('receipt-footer')).toHaveText('Powered by AfritecX');
  await expect(receipt.getByTestId('receipt-fiscal-pending')).toBeVisible();

  // The print was issued promptly after the sale committed.
  const timing = page.getByTestId('print-timing');
  await expect(timing).toBeVisible();
  const text = (await timing.textContent()) ?? '';
  const printMs = Number(/print (\d+)ms/.exec(text)?.[1] ?? 'NaN');
  expect(printMs).toBeLessThan(1000);
});
