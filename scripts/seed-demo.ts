/**
 * Seed one org, branch, warehouse, product and price so the till at /pos can be used by hand.
 *
 *   npm run db:seed-demo
 *
 * It prints a ready-to-paste access token. Put it in the browser console on /pos:
 *
 *   localStorage.setItem('pos_access_token', '<token>'); location.reload();
 *
 * The token carries the same claims the Supabase custom access token hook would add, so the RLS
 * policies apply exactly as they do in production. It expires after 12 hours.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1]) out[match[1]] = match[2] ?? '';
  }
  return out;
}

const fileEnv = {
  ...loadEnvFile(path.resolve(__dirname, '..', '.env.local')),
  ...loadEnvFile(path.resolve(__dirname, '..', '.env.test')),
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintToken(claims: { sub: string; orgId: string; branchIds: string[]; email: string }): string {
  const secret =
    process.env.SUPABASE_JWT_SECRET ??
    fileEnv.SUPABASE_JWT_SECRET ??
    'super-secret-jwt-token-with-at-least-32-characters-long';
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: claims.sub,
      role: 'authenticated',
      email: claims.email,
      org_id: claims.orgId,
      branch_ids: claims.branchIds,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

async function main(): Promise<void> {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? fileEnv.TEST_DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set DATABASE_URL or TEST_DATABASE_URL (see supabase status)');
  }

  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 8);
    const org = (
      await client.query('select app.create_org($1, $2) as id', [
        `Demo store ${suffix}`,
        `demo-${suffix}`,
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

    const priceList = (
      await client.query(
        `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const items = [
      { name: 'Coffee 250g', barcode: `DEMO-COFFEE-${suffix}`, price: '5.0000', cost: '2.0000' },
      { name: 'Bread loaf', barcode: `DEMO-BREAD-${suffix}`, price: '2.5000', cost: '1.1000' },
      { name: 'Milk 1L', barcode: `DEMO-MILK-${suffix}`, price: '1.7500', cost: '0.9000' },
    ];

    for (const item of items) {
      const product = (
        await client.query(
          `insert into public.products (org_id, sku, name)
           values ($1, app.next_number($1, 'SKU'), $2) returning id`,
          [org, item.name],
        )
      ).rows[0].id as string;

      const variant = (
        await client.query(
          `insert into public.product_variants (org_id, product_id, sku, name, barcode)
           values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
          [org, product, item.barcode],
        )
      ).rows[0].id as string;

      await client.query(
        `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
         values ($1, $2, $3, $4)`,
        [org, priceList, variant, item.price],
      );

      await client.query(`select app.post_receipt($1, $2, $3, $4, $5, 100, $6, current_date)`, [
        org,
        branch,
        warehouse,
        product,
        variant,
        item.cost,
      ]);
    }

    const userId = randomUUID();
    const email = `demo-${suffix}@example.test`;
    await client.query('insert into auth.users (id, email) values ($1, $2)', [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    const token = mintToken({ sub: userId, orgId: org, branchIds: [branch], email });

    console.log('');
    console.log('Seeded demo tenant. Scan these barcodes at /pos:');
    for (const item of items) console.log(`  ${item.barcode}   ${item.name}   ${item.price}`);
    console.log('');
    console.log('Paste this in the browser console on /pos, then reload:');
    console.log('');
    console.log(`  localStorage.setItem('pos_access_token', '${token}'); location.reload();`);
    console.log('');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
