import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * A3 — the admin operations console, driven through the browser like an operator would.
 *
 * This is a navigation/smoke test, not one of the numbered Vitest tests (tests/ owns those). It
 * walks the four A3 pages — /admin/laybys, /admin/returns, /admin/shifts, /admin/stocktake — using
 * the real UI: it clicks the nav links, opens the status filters, opens and closes a stock count,
 * and completes a layby. It seeds its own tenant, mints a real access token and drives the app
 * exactly as the browser does, so it proves the pages render and the console reaches the A3 APIs.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/admin-ops.e2e.ts
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
  laybyNo: string;
  laybyId: string;
}

/** One tenant with a received product, an open layby and an open shift, ready to walk the console. */
async function seed(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [
        `A3 e2e ${suffix}`,
        `a3-e2e-${suffix}`,
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
         values ($1, $2, 'W1', 'Shop floor') returning id`,
        [org, branch],
      )
    ).rows[0].id as string;

    const product = (
      await client.query(
        `insert into public.products (org_id, sku, name)
         values ($1, app.next_number($1, 'SKU'), 'Console widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const variant = (
      await client.query(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [org, product, `A3E2E-${suffix}`],
      )
    ).rows[0].id as string;

    const contact = (
      await client.query(
        `insert into public.contacts (org_id, kind, name) values ($1, 'customer', 'Console customer') returning id`,
        [org],
      )
    ).rows[0].id as string;

    await client.query(`select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`, [
      org,
      branch,
      warehouse,
      product,
      variant,
    ]);

    // An open layby with a past due date, so the list shows it as overdue.
    const layby = (
      await client.query(
        `select app.create_layby($1, $2, $3, $4, $5::date, $6::jsonb, 5, 'USD', 'VAT15', $5::date) as app`,
        [
          org,
          branch,
          contact,
          warehouse,
          '2020-01-01',
          JSON.stringify([{ product_id: product, variant_id: variant, qty: 2, unit_price: 10 }]),
        ],
      )
    ).rows[0].app as { layby_id: string; layby_no: string };

    // An open shift, so the shifts page can be closed through the UI.
    await client.query(
      `insert into public.shifts (org_id, branch_id, till_id, opening_float)
       values ($1, $2, 'T1', 0)`,
      [org, branch],
    );

    const userId = crypto.randomUUID();
    const email = `a3-e2e-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    return {
      token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }),
      laybyNo: layby.layby_no,
      laybyId: layby.layby_id,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

test('A3 console: an operator can navigate every admin operations page', async ({ page }) => {
  const { token, laybyNo } = await seed();

  // The page reads the access token from localStorage before it loads, exactly as a signed-in
  // operator's browser would.
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  // --- Laybys -------------------------------------------------------------------------------
  await page.goto('/admin/laybys');
  await expect(page.getByRole('heading', { name: 'Laybys', exact: true })).toBeVisible();

  const laybyRow = page.getByTestId(`layby-${laybyNo}`);
  await expect(laybyRow).toBeVisible();

  // The overdue due date is flagged (red in the UI; the test asserts the text).
  await expect(page.getByTestId(`layby-due-${laybyNo}`)).toContainText('overdue');

  // The status filter narrows the list and back.
  await page.getByLabel('Filter by status').selectOption('completed');
  await expect(page.getByTestId(`layby-${laybyNo}`)).toHaveCount(0);
  await page.getByLabel('Filter by status').selectOption('open');
  await expect(page.getByTestId(`layby-${laybyNo}`)).toBeVisible();

  // The nav link walks to Returns, then back — the console is fully navigable by clicking.
  await page.getByRole('link', { name: 'Returns' }).click();
  await expect(page.getByRole('heading', { name: 'Returns', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Laybys' }).click();
  await expect(page.getByRole('heading', { name: 'Laybys', exact: true })).toBeVisible();

  // Open the detail page by clicking the layby number.
  await page.getByRole('link', { name: laybyNo }).click();
  await expect(page.getByTestId('layby-detail')).toBeVisible();
  await expect(page.getByTestId('layby-deposit')).toHaveText('5.0000');
  await expect(page.getByTestId('layby-customer')).toHaveText('Console customer');
  await expect(page.getByTestId('layby-reservations').locator('tbody tr')).toHaveCount(1);

  // Complete the layby from the list: a CORE invoice is created and the deposit cleared.
  await page.goto('/admin/laybys');
  await page.getByTestId(`layby-complete-${laybyNo}`).click();
  await expect(page.getByTestId('laybys-notice')).toContainText('Invoice');

  // --- Returns ------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Returns' }).click();
  await expect(page.getByRole('heading', { name: 'Returns', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New return' })).toBeVisible();
  await expect(page.getByTestId('load-invoice')).toBeVisible();

  // --- Shifts & Z-reports -------------------------------------------------------------------
  await page.getByRole('link', { name: 'Shifts & Z-reports' }).click();
  await expect(page.getByRole('heading', { name: 'Shifts & Z-reports', exact: true })).toBeVisible();

  // Close the open shift; the Z-report appears read-only below the table.
  await page.getByTestId('shift-table').waitFor();
  await page.getByRole('button', { name: 'Close shift' }).first().click();
  await expect(page.getByTestId('z-report')).toBeVisible();
  await expect(page.getByTestId('z-report')).toContainText('Z-report');

  // --- Stocktake ----------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Stocktake' }).click();
  await expect(page.getByRole('heading', { name: 'Stocktake', exact: true })).toBeVisible();

  // Open a count, edit the counted quantity, then close it — all through the UI.
  await page.getByLabel('Warehouse').selectOption({ index: 1 });
  await page.getByTestId('open-count').click();
  await expect(page.getByTestId('active-count')).toBeVisible();
  await expect(page.getByTestId('count-lines').locator('tbody tr')).toHaveCount(1);

  const counted = page.getByLabel(/Counted qty/).first();
  await counted.fill('90');
  await page.getByTestId('close-count').click();
  await expect(page.getByTestId('stocktake-notice')).toContainText('closed');

  // The count now appears in the list as closed.
  await expect(page.getByTestId('stocktake-table').locator('tbody tr').first()).toContainText(
    'closed',
  );
});
