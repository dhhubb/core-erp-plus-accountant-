import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { expectError, one, sql } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import {
  MockFdmsClient,
  type FdmsClient,
  type FdmsResult,
  type FdmsSubmission,
} from '../src/fiscal/fdms';
import { runFiscalPassOn } from '../src/fiscal/queue';
import {
  ensureNextBlock,
  issueNumberBlock,
  storeNumberBlock,
} from '../src/fiscal/numberBlocks';

/**
 * H3 — fiscal and numbering. Tests 64–68, continuing from H2's 63.
 *
 * Everything runs against the real local Postgres. The branch side is exercised through a pool that
 * carries `app.branch_mode=branch` (the fiscal enqueue is a branch responsibility, like the H2
 * outbox). The FDMS device is the in-memory mock from `src/fiscal/fdms.ts`: a real object with real
 * state that can be put into an outage or told to reject, so no network is involved and nothing about
 * the database is mocked.
 */

/** A branch-mode pool: every connection carries the GUC the fiscal enqueue reads. */
const branchPool = new Pool({
  connectionString: testDatabaseUrl(),
  options: '-c app.branch_mode=branch',
  max: 12,
});

afterAll(async () => {
  await branchPool.end();
});

/** Run fn on one branch-mode connection. Rolls back any open transaction on error, so an aborted
 * transaction is never returned to the pool (a later `begin` would then fail). */
async function withBranch<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await branchPool.connect();
  try {
    return await fn(client);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One fiscal pass on its own connection and transaction, as the branch worker runs it. */
async function pass(
  client: PoolClient,
  fdms: FdmsClient,
  orgId: string,
  branchId: string,
  limit?: number,
): Promise<Awaited<ReturnType<typeof runFiscalPassOn>>> {
  await client.query('begin');
  try {
    const result = await runFiscalPassOn(client, fdms, {
      orgId,
      branchId,
      ...(limit !== undefined ? { limit } : {}),
    });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** Force every pending row due now (simulates time passing between backoff windows). */
async function makeDue(orgId: string): Promise<void> {
  await sql(`update public.fiscal_invoices set next_attempt_at = now() where org_id = $1`, [orgId]);
}

interface H3Fixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
  shiftId: string;
}

/** A branch with stock, a price, a barcode and an open shift. */
async function h3Fixture(name: string, qty = 1000): Promise<H3Fixture> {
  const tenant = await createTenant(name);
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'W1', 'W1') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), $2) returning id`,
    [tenant.orgId, `${name} product`],
  );
  const barcode = `BC-${Math.random().toString(36).slice(2, 10)}`;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, barcode],
  );
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, '5.0000')`,
    [tenant.orgId, priceList!.id, variant!.id],
  );
  await sql(`select app.post_receipt($1, $2, $3, $4, $5, $6, 2, '2026-06-15'::date)`, [
    tenant.orgId,
    tenant.branchId,
    warehouse!.id,
    product!.id,
    variant!.id,
    qty,
  ]);
  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );
  return {
    tenant,
    warehouseId: warehouse!.id,
    productId: product!.id,
    variantId: variant!.id,
    barcode,
    shiftId: shift!.id,
  };
}

/** Ring one sale through app.post_pos_sale on a branch-mode connection. */
async function ringSale(fx: H3Fixture, client: PoolClient, clientSaleId = crypto.randomUUID()): Promise<void> {
  await client.query(`select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as app`, [
    fx.tenant.orgId,
    fx.tenant.branchId,
    fx.warehouseId,
    fx.shiftId,
    clientSaleId,
    JSON.stringify([{ barcode: fx.barcode, qty: 1 }]),
    JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '10' }]),
  ]);
}

/** Post a bare invoice through app.create_invoice and return its id. */
async function createInvoice(fx: H3Fixture, client: PoolClient): Promise<string> {
  const result = await client.query<{ app: { invoice_id: string; invoice_no: string } }>(
    `select app.create_invoice($1, $2, null, '2026-06-15'::date, $3::jsonb) as app`,
    [
      fx.tenant.orgId,
      fx.tenant.branchId,
      JSON.stringify([
        {
          product_id: fx.productId,
          variant_id: fx.variantId,
          warehouse_id: fx.warehouseId,
          qty: '1',
          unit_price: '5.0000',
        },
      ]),
    ],
  );
  return result.rows[0]!.app.invoice_id;
}

function fiscalRow(fx: H3Fixture): Promise<
  { status: string; attempts: number; invoice_id: string; fdms_response: Record<string, unknown> | null } | undefined
> {
  return one(
    `select status, attempts, invoice_id, fdms_response
       from public.fiscal_invoices where org_id = $1`,
    [fx.tenant.orgId],
  );
}

describe('H3 fiscal and numbering', () => {
  it('64. A sale inserts its pending fiscal row in the same transaction', async () => {
    const fx = await h3Fixture('H3 64');

    await withBranch(async (client) => {
      await client.query('begin');
      await ringSale(fx, client);
      await client.query('commit');
    });

    const row = await fiscalRow(fx);
    expect(row).toBeTruthy();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);

    // The fiscal row points at the invoice the sale created, and its payload carries the number.
    const invoice = await one<{ id: string; invoice_no: string }>(
      `select id, invoice_no from public.invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(row!.invoice_id).toBe(invoice!.id);
    const payload = await one<{ fdms_payload: { invoice_no: string } }>(
      `select fdms_payload from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(payload!.fdms_payload.invoice_no).toBe(invoice!.invoice_no);

    // A rolled-back sale leaves no fiscal row: the enqueue is in the sale's own transaction.
    const rolled = await expectError(() =>
      withBranch(async (client) => {
        await client.query('begin');
        await ringSale(fx, client);
        await client.query('rollback');
        throw new Error('rollback on purpose');
      }),
    );
    expect(rolled.message).toContain('rollback on purpose');

    const count = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(count!.n).toBe('1');
  });

  it('65. A real FDMS rejection retries with backoff, and 5 rejections move the row to failed', async () => {
    const fx = await h3Fixture('H3 65');
    await withBranch((client) => createInvoice(fx, client));

    const rejecting = new MockFdmsClient({ rejections: 100 });

    // The first rejection: the row stays pending, one attempt is recorded, and the next attempt is
    // scheduled in the future (the backoff), not immediately.
    await withBranch(async (client) => {
      await pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId);
    });
    const afterOne = await fiscalRow(fx);
    expect(afterOne!.status).toBe('pending');
    expect(afterOne!.attempts).toBe(1);

    const backoff = await one<{ future: boolean }>(
      `select (next_attempt_at > now()) as future
         from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(backoff!.future).toBe(true);

    // A pass before the backoff elapses claims nothing.
    const tooSoon = await withBranch((client) =>
      pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(tooSoon.claimed).toBe(0);

    // Four more real rejections (forcing the backoff window open each time) reach the cap.
    for (let i = 0; i < 4; i += 1) {
      await makeDue(fx.tenant.orgId);
      await withBranch((client) => pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId));
    }

    const failed = await fiscalRow(fx);
    expect(failed!.status).toBe('failed');
    expect(failed!.attempts).toBe(5);

    // A failed row is no longer claimed, even once due.
    await makeDue(fx.tenant.orgId);
    const after = await withBranch((client) =>
      pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(after.claimed).toBe(0);

    // Every real rejection is recorded as an attempt (append-only).
    const attempts = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoice_attempts where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(attempts!.n).toBe('5');
  });

  it('65b. A network outage keeps the row pending and does NOT increase attempts', async () => {
    const fx = await h3Fixture('H3 65b');
    await withBranch((client) => createInvoice(fx, client));

    const down = new MockFdmsClient({ online: false });
    await withBranch(async (client) => {
      await pass(client, down, fx.tenant.orgId, fx.tenant.branchId);
    });

    const row = await fiscalRow(fx);
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
    expect(row!.fdms_response).toBeNull();
  });

  it('66. With FDMS down 10 sales queue 10 fiscal invoices; when it returns all 10 submit exactly once', async () => {
    const fx = await h3Fixture('H3 66', 5000);

    const fdms = new MockFdmsClient({ online: false });

    // Ten sales while the device is down: every sale commits and queues its fiscal row.
    await withBranch(async (client) => {
      for (let i = 0; i < 10; i += 1) {
        await client.query('begin');
        await ringSale(fx, client);
        await client.query('commit');
      }
    });

    const queued = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1 and status = 'pending'`,
      [fx.tenant.orgId],
    );
    expect(queued!.n).toBe('10');

    // One pass while still down: nothing is sent and no attempt is counted.
    await withBranch((client) => pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId));
    const stillPending = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1 and status = 'pending' and attempts = 0`,
      [fx.tenant.orgId],
    );
    expect(stillPending!.n).toBe('10');

    // The device returns: every queued invoice is submitted exactly once.
    fdms.restore();
    await makeDue(fx.tenant.orgId);
    const result = await withBranch((client) =>
      pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(result.sent).toBe(10);

    const sent = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1 and status = 'sent'`,
      [fx.tenant.orgId],
    );
    expect(sent!.n).toBe('10');

    // Exactly once: ten distinct invoices accepted, and no invoice accepted twice.
    expect(fdms.accepted).toHaveLength(10);
    expect(new Set(fdms.accepted).size).toBe(10);

    // A further pass sends nothing more.
    const again = await withBranch((client) =>
      pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(again.claimed).toBe(0);
    expect(fdms.accepted).toHaveLength(10);
  });

  it('67. The next number block is requested before the current one runs out; offline exhaustion fails clearly and reuses no number', async () => {
    const fx = await h3Fixture('H3 67', 5000);
    const orgId = fx.tenant.orgId;
    const branchId = fx.tenant.branchId;

    // The cloud issues a first block of two numbers; the branch stores it and is now in block mode.
    const block1 = await withBranch(async (client) => {
      const issued = await issueNumberBlock(client, { orgId, branchId, size: 2 });
      await storeNumberBlock(client, { orgId, branchId, block: issued });
      return issued;
    });
    expect(block1.firstValue).toBe('1');
    expect(block1.lastValue).toBe('2');

    // A fetcher the branch will use to top up; it fails when the "cloud" is offline.
    let offline = false;
    let nextFirst = 3;
    const fetchBlock = async () => {
      if (offline) throw new Error('cloud unreachable');
      const first = nextFirst;
      nextFirst += 2;
      return { blockNo: String(first), firstValue: String(first), lastValue: String(first + 1), size: 2 };
    };

    const sell = () =>
      withBranch(async (client) => {
        await client.query('begin');
        const id = await createInvoice(fx, client);
        await client.query('commit');
        return id;
      });

    // One sale consumes number 1; the block now has one number left (the low-water mark).
    await sell();

    // The branch requests the next block BEFORE the current one runs out.
    const topUp = await withBranch((client) =>
      ensureNextBlock(client, fetchBlock, { orgId, branchId, lowWater: 1 }),
    );
    expect(topUp.requested).toBe(true);
    expect(topUp.status.exhausted).toBe(false);
    expect(topUp.status.remaining).toBe(3);

    // The cloud goes offline. Two more sales use up the first block and one of the second.
    offline = true;
    await sell();
    await sell();

    // A top-up while offline is a no-op: the branch keeps the numbers it already has.
    const offlineTopUp = await withBranch((client) =>
      ensureNextBlock(client, fetchBlock, { orgId, branchId, lowWater: 1 }),
    );
    expect(offlineTopUp.requested).toBe(false);
    expect(offlineTopUp.status.exhausted).toBe(false);
    expect(offlineTopUp.status.remaining).toBe(1);

    // The last number is used, then the next sale fails with a clear message.
    await sell();
    const failure = await expectError(sell);
    expect(failure.message).toMatch(/block exhausted/i);

    // Every number used is unique and gapless; the failed sale reused nothing.
    const numbers = await sql<{ invoice_no: string }>(
      `select invoice_no from public.invoices where org_id = $1 order by invoice_no`,
      [orgId],
    );
    expect(numbers.map((row) => row.invoice_no)).toEqual(['000001', '000002', '000003', '000004']);
  });

  it('68. Two fiscal workers running at once never submit the same invoice twice', async () => {
    const fx = await h3Fixture('H3 68', 5000);
    const orgId = fx.tenant.orgId;
    const branchId = fx.tenant.branchId;

    // Twenty invoices, each with a pending fiscal row.
    await withBranch(async (client) => {
      for (let i = 0; i < 20; i += 1) {
        await client.query('begin');
        await createInvoice(fx, client);
        await client.query('commit');
      }
    });

    // A device that is slow enough that the two workers really overlap.
    const inner = new MockFdmsClient();
    const slow: FdmsClient = {
      async submit(submission: FdmsSubmission): Promise<FdmsResult> {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return inner.submit(submission);
      },
    };

    const clientA = await branchPool.connect();
    const clientB = await branchPool.connect();
    try {
      // Start A first so it locks its claim, then B: B's claim skips the rows A holds.
      const a = pass(clientA, slow, orgId, branchId, 10);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const b = pass(clientB, slow, orgId, branchId, 10);
      const [resultA, resultB] = await Promise.all([a, b]);

      expect(resultA.claimed + resultB.claimed).toBe(20);
      // No invoice was submitted twice, by either worker.
      expect(new Set(inner.submissions.map((s) => s.invoiceId)).size).toBe(inner.submissions.length);
      expect(new Set(inner.accepted).size).toBe(inner.accepted.length);
    } finally {
      clientA.release();
      clientB.release();
    }

    // Drain whatever is left and confirm exactly-once across the whole run.
    let sent = 0;
    for (let i = 0; i < 5; i += 1) {
      await makeDue(orgId);
      const result = await withBranch((client) => pass(client, slow, orgId, branchId));
      sent += result.sent;
      if (result.claimed === 0) break;
    }

    expect(new Set(inner.accepted).size).toBe(inner.accepted.length);
    const sentRows = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1 and status = 'sent'`,
      [orgId],
    );
    expect(sentRows!.n).toBe('20');
    expect(inner.accepted).toHaveLength(20);
  });
});
