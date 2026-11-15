import { describe, expect, it } from 'vitest';
import { expectError, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  type Tenant,
} from './support/fixtures';
import { drainFiscalJobs, unreachableTransport } from '@/fiscal/worker';
import { enqueueFiscalJob } from '@/fiscal/adapter';

/**
 * R6 — Fiscal integration adapter (Retail vertical). Test 25 is the gate.
 *
 * The adapter is queue-only. These tests check queueing and non-blocking behaviour ONLY. They do
 * not assert anything about ZIMRA compliance, fiscal formats or device protocols: whether ZIMRA
 * requires printing at the moment of sale is an open item (see docs/ADR.md).
 *
 * Nothing is mocked. Every test runs against the real local Postgres; the "unreachable" transport
 * performs no network call, it just reports 'unreachable'.
 */

const SALE_DATE = '2026-06-15';

interface FiscalFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price and stock on hand. */
async function fiscalFixture(name: string, qty = 100): Promise<FiscalFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
  const productId = await addProduct(tenant, `${name} product`);

  const barcode = `BC-${Math.random().toString(36).slice(2, 10)}`;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, productId, barcode],
  );
  const variantId = variant!.id;

  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, '5.0000')`,
    [tenant.orgId, priceList!.id, variantId],
  );

  await postReceipt(tenant, warehouseId, productId, qty, 2, SALE_DATE, variantId);

  await sql(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0)`,
    [tenant.orgId, tenant.branchId],
  );

  return { tenant, warehouseId, productId, variantId, barcode };
}

/** Configure the branch's fiscal integration. `mode` is 'none' or 'async'. */
async function configureFiscal(
  fixture: FiscalFixture,
  input: { mode: 'none' | 'async'; status?: 'active' | 'error' },
): Promise<void> {
  await sql(
    `insert into public.fiscal_device_integration
       (org_id, branch_id, device_type, mode, status, payload)
     values ($1, $2, 'generic_http', $3, $4, $5::jsonb)
     on conflict (org_id, branch_id) do update
       set mode = excluded.mode, status = excluded.status, payload = excluded.payload`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      input.mode,
      input.status ?? 'active',
      // A device that cannot be reached: an endpoint that does not resolve.
      JSON.stringify({ endpoint: 'http://fiscal-device.invalid/zimra' }),
    ],
  );
}

/** Ring a sale through app.post_pos_sale, exactly as the thin route handler does. */
async function ringSale(fixture: FiscalFixture, clientSaleId = crypto.randomUUID()): Promise<void> {
  const shift = await one<{ id: string }>(
    `select id from public.shifts where org_id = $1 order by opened_at desc limit 1`,
    [fixture.tenant.orgId],
  );
  await one<{ app: unknown }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as app`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      fixture.warehouseId,
      shift!.id,
      clientSaleId,
      JSON.stringify([{ barcode: fixture.barcode, qty: 1 }]),
      JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '10' }]),
    ],
  );
}

function jobCount(tenant: Tenant): Promise<string> {
  return one<{ n: string }>(
    `select count(*)::text as n from public.fiscal_jobs where org_id = $1`,
    [tenant.orgId],
  ).then((row) => row!.n);
}

describe('R6 fiscal integration adapter', () => {
  it('25. With mode async and device unreachable, sale still commits and exactly one fiscal job is queued', async () => {
    const fixture = await fiscalFixture('R6 25');
    // Mode async, and a device that cannot be reached.
    await configureFiscal(fixture, { mode: 'async', status: 'error' });

    // The sale commits: the fiscal device is nowhere on the sale path.
    await ringSale(fixture);

    const sales = await one<{ n: string }>(
      `select count(*)::text as n from public.pos_sales where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('1');

    const invoices = await one<{ n: string }>(
      `select count(*)::text as n from public.invoices where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(invoices!.n).toBe('1');

    // Exactly one fiscal job is queued for the sale.
    expect(await jobCount(fixture.tenant)).toBe('1');
    const job = await one<{ sale_id: string; status: string; invoice_id: string | null }>(
      `select sale_id, status, invoice_id from public.fiscal_jobs where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(job!.status).toBe('queued');
    expect(job!.invoice_id).toBeTruthy();

    // The device is unreachable: a delivery pass records one attempt and the job stays queued.
    const drain = await drainFiscalJobs(unreachableTransport('connect ETIMEDOUT'), {
      orgId: fixture.tenant.orgId,
      branchId: fixture.tenant.branchId,
      claims: fixture.tenant.claims,
    });
    expect(drain.examined).toBe(1);
    expect(drain.sent).toBe(0);
    expect(drain.retried).toBe(1);

    const attempts = await sql<{ outcome: string; error: string | null }>(
      `select outcome, error from public.fiscal_job_attempts where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('unreachable');
    expect(attempts[0]!.error).toContain('ETIMEDOUT');

    // Still exactly one job, still queued: the ledger is unaffected by the failed delivery.
    expect(await jobCount(fixture.tenant)).toBe('1');
  });

  it('mode none queues nothing, and a branch with no integration queues nothing', async () => {
    const off = await fiscalFixture('R6 mode none');
    await configureFiscal(off, { mode: 'none' });
    await ringSale(off);
    expect(await jobCount(off.tenant)).toBe('0');

    const absent = await fiscalFixture('R6 no integration');
    await ringSale(absent);
    expect(await jobCount(absent.tenant)).toBe('0');
  });

  it('a sale queues exactly one job even when it is retried (idempotent per sale)', async () => {
    const fixture = await fiscalFixture('R6 idempotent');
    await configureFiscal(fixture, { mode: 'async' });

    const clientSaleId = crypto.randomUUID();
    await ringSale(fixture, clientSaleId);
    // The same client_sale_id again is a duplicate: it returns the original receipt.
    await ringSale(fixture, clientSaleId);

    const sales = await one<{ n: string }>(
      `select count(*)::text as n from public.pos_sales where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('1');
    expect(await jobCount(fixture.tenant)).toBe('1');
  });

  it('the enqueue is idempotent when called again for the same sale', async () => {
    const fixture = await fiscalFixture('R6 enqueue idempotent');
    await configureFiscal(fixture, { mode: 'async' });
    await ringSale(fixture);

    const sale = await one<{ id: string; invoice_id: string }>(
      `select id, invoice_id from public.pos_sales where org_id = $1`,
      [fixture.tenant.orgId],
    );

    // A backfill call for the same sale must not queue a second job.
    const again = await tx((client) =>
      enqueueFiscalJob(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        saleId: sale!.id,
        invoiceId: sale!.invoice_id,
      }),
    );
    expect(again).toBeTruthy();
    expect(await jobCount(fixture.tenant)).toBe('1');
  });

  it('the queue is append-only: UPDATE and DELETE on a fiscal job are rejected', async () => {
    const fixture = await fiscalFixture('R6 append-only');
    await configureFiscal(fixture, { mode: 'async' });
    await ringSale(fixture);

    const update = await expectError(() =>
      sql(`update public.fiscal_jobs set status = 'sent' where org_id = $1`, [fixture.tenant.orgId]),
    );
    expect(update.message).toMatch(/append-only/);

    const remove = await expectError(() =>
      sql(`delete from public.fiscal_jobs where org_id = $1`, [fixture.tenant.orgId]),
    );
    expect(remove.message).toMatch(/append-only/);
  });

  it('a device is not required: the enqueue is in the sale transaction, so a rollback leaves no job', async () => {
    const fixture = await fiscalFixture('R6 same transaction');
    await configureFiscal(fixture, { mode: 'async' });

    const shift = await one<{ id: string }>(
      `select id from public.shifts where org_id = $1 order by opened_at desc limit 1`,
      [fixture.tenant.orgId],
    );

    // Ring the sale inside a transaction, then roll the whole thing back on purpose.
    const rolledBack = await expectError(() =>
      tx(async (client) => {
        await client.query(
          `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as app`,
          [
            fixture.tenant.orgId,
            fixture.tenant.branchId,
            fixture.warehouseId,
            shift!.id,
            crypto.randomUUID(),
            JSON.stringify([{ barcode: fixture.barcode, qty: 1 }]),
            JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '10' }]),
          ],
        );
        throw new Error('rollback on purpose');
      }),
    );
    expect(rolledBack.message).toContain('rollback on purpose');

    // Neither the sale nor a job survives: the enqueue is in the sale's own transaction.
    expect(
      (
        await one<{ n: string }>(
          `select count(*)::text as n from public.pos_sales where org_id = $1`,
          [fixture.tenant.orgId],
        )
      )!.n,
    ).toBe('0');
    expect(await jobCount(fixture.tenant)).toBe('0');
  });
});
