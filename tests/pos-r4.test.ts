import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as salesRoute } from '../src/app/api/pos/sales/route';
import { POST as syncRoute } from '../src/app/api/pos/sync/route';
import { one, sql } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  tenantToken,
  type Tenant,
} from './support/fixtures';
import {
  clearOutbox,
  countPending,
  enqueueSale,
  listPending,
  type OutboxSale,
} from '../src/verticals/pos/outbox';
import { syncOnce, type SyncSalePayload, type SyncSaleResult } from '../src/verticals/pos/sync';
import { LIVE_SALE_LIMIT } from '../src/verticals/pos/rateLimit';

/**
 * R4 — offline outbox and sync. Tests 14–18. The offline Playwright run (network disabled then
 * restored) lives in e2e/pos-offline.e2e.ts.
 *
 * These drive the real route handlers and the real outbox module against real Postgres and real
 * Redis. Nothing is mocked. IndexedDB is provided by fake-indexeddb, which is an in-memory
 * implementation of the real API, not a stub of our code.
 */

const SALE_DATE = '2026-06-15';

interface PosFixture {
  tenant: Tenant;
  token: string;
  warehouseId: string;
  variantId: string;
  productId: string;
  barcode: string;
  unitPrice: string;
  shiftId: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price, stock and an open shift. */
async function posFixture(
  name: string,
  options: { qty?: number; unitCost?: number; unitPrice?: string } = {},
): Promise<PosFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
  const productId = await addProduct(tenant, `${name} product`);

  const barcode = `R4-${Math.random().toString(36).slice(2, 10)}`;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, productId, barcode],
  );
  const variantId = variant!.id;

  const unitPrice = options.unitPrice ?? '5.0000';
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, $4)`,
    [tenant.orgId, priceList!.id, variantId, unitPrice],
  );
  await sql(
    `insert into public.exchange_rates (org_id, currency, rate, effective_from)
     values ($1, 'ZWG', 30, date '2020-01-01')`,
    [tenant.orgId],
  );

  await postReceipt(
    tenant,
    warehouseId,
    productId,
    options.qty ?? 1000,
    options.unitCost ?? 2,
    SALE_DATE,
    variantId,
  );

  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );

  return {
    tenant,
    token: tenantToken(tenant),
    warehouseId,
    variantId,
    productId,
    barcode,
    unitPrice,
    shiftId: shift!.id,
  };
}

function saleBody(fixture: PosFixture, clientSaleId: string, qty = 1) {
  return {
    warehouse_id: fixture.warehouseId,
    shift_id: fixture.shiftId,
    client_sale_id: clientSaleId,
    tax_code: 'VAT15',
    lines: [{ variant_id: fixture.variantId, barcode: fixture.barcode, qty: String(qty), unit_price: fixture.unitPrice }],
    tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100.0000' }],
  };
}

/** Ring a live sale through the real route handler. */
async function liveSale(fixture: PosFixture, clientSaleId: string, qty = 1) {
  const request = new Request('http://localhost/api/pos/sales', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.token}` },
    body: JSON.stringify(saleBody(fixture, clientSaleId, qty)),
  });
  return salesRoute(request);
}

/** A deliver function that pushes a batch through the real sync route handler. */
function deliverWith(token: string) {
  return async (sales: SyncSalePayload[]): Promise<{ results: SyncSaleResult[] }> => {
    const request = new Request('http://localhost/api/pos/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sales }),
    });
    const response = await syncRoute(request);
    const payload = (await response.json()) as { results?: SyncSaleResult[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `sync failed (${response.status})`);
    return { results: payload.results ?? [] };
  };
}

/** The outbox entry for a sale, as the till would write it when the network is down. */
function outboxEntry(fixture: PosFixture, clientSaleId: string, qty = 1): Omit<OutboxSale, 'attempts' | 'nextAttemptAt' | 'lastError'> {
  return {
    clientSaleId,
    shiftId: fixture.shiftId,
    warehouseId: fixture.warehouseId,
    soldAt: new Date().toISOString(),
    currency: 'USD',
    lines: [
      {
        variantId: fixture.variantId,
        barcode: fixture.barcode,
        qty: String(qty),
        unitPrice: fixture.unitPrice,
        promotionIds: [],
      },
    ],
    tenders: [{ method: 'cash', currency: 'USD', amountTendered: '100.0000' }],
  };
}

beforeEach(async () => {
  await clearOutbox();
});

describe('R4 offline outbox and sync', () => {
  it('14. Sale completed offline survives page reload in IndexedDB with UUID intact', async () => {
    const fixture = await posFixture('R4 test 14');
    const clientSaleId = crypto.randomUUID();

    // The till is offline: the sale is written to the outbox and nothing reaches the server.
    await enqueueSale(outboxEntry(fixture, clientSaleId, 2));

    const onServer = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(onServer!.n).toBe('0');

    // Reload the page: drop every module and re-import, so only IndexedDB carries the state.
    vi.resetModules();
    const reloaded = await import('../src/verticals/pos/outbox');

    const survived = await reloaded.getSale(clientSaleId);
    expect(survived).toBeDefined();
    expect(survived!.clientSaleId).toBe(clientSaleId);
    expect(survived!.lines).toHaveLength(1);
    expect(survived!.lines[0]!.qty).toBe('2');
    expect(survived!.lines[0]!.unitPrice).toBe('5.0000');
    expect(survived!.tenders[0]!.amountTendered).toBe('100.0000');
    expect(survived!.shiftId).toBe(fixture.shiftId);
    expect(await reloaded.countPending()).toBe(1);

    // And the UUID is the one the server will treat as the idempotency key.
    expect(survived!.clientSaleId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('15. Reconnecting syncs every queued sale and clears the outbox', async () => {
    const fixture = await posFixture('R4 test 15');
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await enqueueSale(outboxEntry(fixture, id, 1));
    }
    expect(await countPending()).toBe(3);

    const report = await syncOnce(deliverWith(fixture.token));

    expect(report).not.toBeNull();
    expect(report!.cleared).toBe(3);
    expect(report!.remaining).toBe(0);
    expect(await countPending()).toBe(0);
    expect(await listPending()).toHaveLength(0);

    // Every sale reached the ledger exactly once.
    const sales = await sql<{ client_sale_id: string }>(
      'select client_sale_id from public.pos_sales where org_id = $1 order by client_sale_id',
      [fixture.tenant.orgId],
    );
    expect(sales.map((row) => row.client_sale_id).sort()).toEqual([...ids].sort());
  });

  it('16. Same client_sale_id twice posts once and the second request is a duplicate', async () => {
    const fixture = await posFixture('R4 test 16');
    const clientSaleId = crypto.randomUUID();

    const deliver = deliverWith(fixture.token);
    const payload = [outboxPayload(fixture, clientSaleId)];
    const one1 = await deliver(payload);
    expect(one1.results[0]!.outcome).toBe('committed');

    const two = await deliver(payload);
    expect(two.results[0]!.outcome).toBe('duplicate');

    // Posted once: one POS sale, one invoice, one claim.
    const sales = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('1');
    const invoices = await one<{ n: string }>(
      'select count(*)::text as n from public.invoices where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(invoices!.n).toBe('1');
    const keys = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sale_keys where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(keys!.n).toBe('1');

    // The duplicate carries the original receipt.
    expect((two.results[0]!.receipt as { invoice_no?: string }).invoice_no).toBe(
      (one1.results[0]!.receipt as { invoice_no?: string }).invoice_no,
    );
  });

  it('17. A sale synced after stock hit zero is accepted and logged as an exception', async () => {
    const fixture = await posFixture('R4 test 17', { qty: 1 });

    // The live sale takes the last unit. Strict rules still apply on the live path.
    const live = await liveSale(fixture, crypto.randomUUID(), 1);
    expect(live.status).toBe(200);

    // A second sale was completed offline against that same unit. It syncs after the stock is gone.
    const clientSaleId = crypto.randomUUID();
    await enqueueSale(outboxEntry(fixture, clientSaleId, 1));
    const report = await syncOnce(deliverWith(fixture.token));

    expect(report!.cleared).toBe(1);
    const result = report!.results[0]!;
    expect(result.outcome).toBe('committed');
    expect(result.exceptions.some((e) => e.kind === 'negative_stock')).toBe(true);

    // The oversell is recorded, not silently swallowed.
    const exceptions = await sql<{ kind: string; client_sale_id: string }>(
      'select kind, client_sale_id from public.pos_sync_exceptions where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(exceptions.some((row) => row.kind === 'negative_stock' && row.client_sale_id === clientSaleId)).toBe(true);

    // Both sales posted, and the ledger still balances.
    const sales = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('2');
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('18. The 31st live sale in one minute is 429, and a 100-sale sync backlog is accepted', async () => {
    const fixture = await posFixture('R4 test 18', { qty: 500 });

    // 30 live sales pass; the 31st is rate limited.
    for (let i = 0; i < LIVE_SALE_LIMIT; i += 1) {
      const response = await liveSale(fixture, crypto.randomUUID(), 1);
      expect(response.status, `live sale ${i + 1} should pass`).toBe(200);
    }

    const blocked = await liveSale(fixture, crypto.randomUUID(), 1);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = (await blocked.json()) as { error?: string };
    expect(body.error).toBeTruthy();

    // The sync endpoint is exempt: a 100-sale backlog is delivered, in batches of 50, with no 429.
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    for (const id of ids) {
      await enqueueSale(outboxEntry(fixture, id, 1));
    }
    expect(await countPending()).toBe(100);

    const deliver = deliverWith(fixture.token);
    let synced = 0;
    let sawRateLimit = false;
    for (let round = 0; round < 5 && (await countPending()) > 0; round += 1) {
      const report = await syncOnce(deliver);
      if (!report) break;
      synced += report.cleared;
      for (const result of report.results) {
        if (result.outcome === 'exception' && result.exceptions.some((e) => e.kind === 'rate_limited')) {
          sawRateLimit = true;
        }
      }
    }

    expect(sawRateLimit).toBe(false);
    expect(synced).toBe(100);
    expect(await countPending()).toBe(0);
  });
});

/** One sale's wire payload, built the way the outbox builds it. */
function outboxPayload(fixture: PosFixture, clientSaleId: string): SyncSalePayload {
  return {
    client_sale_id: clientSaleId,
    shift_id: fixture.shiftId,
    warehouse_id: fixture.warehouseId,
    sold_at: new Date().toISOString(),
    lines: [
      {
        variant_id: fixture.variantId,
        barcode: fixture.barcode,
        qty: '1.0000',
        unit_price: fixture.unitPrice,
      },
    ],
    tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100.0000' }],
  };
}
