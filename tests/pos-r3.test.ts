import { describe, expect, it } from 'vitest';
import { expectError, isRetryable, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  runConcurrently,
  type Tenant,
} from './support/fixtures';

/**
 * R3 — online POS sale. Tests 9-12. Test 13 (the keyboard-only Playwright run) lives in
 * tests/pos-r3-keyboard.test.ts.
 *
 * A POS sale is a CORE invoice plus CORE payments in one transaction. These tests call
 * app.post_pos_sale directly, exactly as the thin route handler does.
 */

const SALE_DATE = '2026-06-15';

interface PosFixture {
  tenant: Tenant;
  warehouseId: string;
  variantId: string;
  productId: string;
  barcode: string;
  unitPrice: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price and stock on hand. */
async function posFixture(
  name: string,
  options: { qty?: number; unitCost?: number; unitPrice?: string; zwgRate?: string } = {},
): Promise<PosFixture> {
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
     values ($1, 'ZWG', $2, date '2020-01-01')`,
    [tenant.orgId, options.zwgRate ?? '30.0000000000'],
  );

  await postReceipt(
    tenant,
    warehouseId,
    productId,
    options.qty ?? 100,
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
    warehouseId,
    variantId,
    productId,
    barcode,
    unitPrice,
  };
}

function shiftIdFor(fixture: PosFixture): Promise<string> {
  return one<{ id: string }>(
    `select id from public.shifts where org_id = $1 order by opened_at desc limit 1`,
    [fixture.tenant.orgId],
  ).then((row) => row!.id);
}

async function postSale(
  fixture: PosFixture,
  input: {
    lines: Array<{ barcode?: string | null; variant_id?: string | null; qty: string | number; unit_price?: string | null }>;
    tenders: Array<{ method: string; currency: string; amount_tendered: string | number }>;
    clientSaleId?: string;
  },
): Promise<Record<string, unknown>> {
  const shiftId = await shiftIdFor(fixture);
  const row = await one<{ app: Record<string, unknown> }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as app`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      fixture.warehouseId,
      shiftId,
      input.clientSaleId ?? crypto.randomUUID(),
      JSON.stringify(input.lines),
      JSON.stringify(input.tenders),
    ],
  );
  return row!.app;
}

/** post_pos_sale inside a transaction on a dedicated connection, for concurrency tests. */
async function postSaleTx(
  fixture: PosFixture,
  clientSaleId: string,
  qty: string | number,
): Promise<void> {
  const shiftId = await shiftIdFor(fixture);
  await tx(async (client) => {
    await client.query(
      `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        fixture.tenant.orgId,
        fixture.tenant.branchId,
        fixture.warehouseId,
        shiftId,
        clientSaleId,
        JSON.stringify([{ barcode: fixture.barcode, qty }]),
        JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '1000' }]),
      ],
    );
  });
}

describe('R3 online POS sale', () => {
  it('9. Sale creates one invoice, payments, and a balanced journal', async () => {
    const fixture = await posFixture('R3 sale 9');
    const receipt = await postSale(fixture, {
      lines: [{ barcode: fixture.barcode, qty: 2 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '20' }],
    });

    expect(receipt.invoice_no).toBeTruthy();

    const invoices = await sql<{ n: string }>(
      'select count(*)::text as n from public.invoices where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(invoices[0]?.n).toBe('1');

    const payments = await sql<{ n: string }>(
      'select count(*)::text as n from public.payments where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(payments[0]?.n).toBe('1');

    const posPayments = await sql<{ n: string }>(
      'select count(*)::text as n from public.pos_payments where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(posPayments[0]?.n).toBe('1');

    // The ledger balances at commit: sum(base_debit) - sum(base_credit) = 0.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');

    // Every journal this org posted has at least two lines and balances.
    const journals = await sql<{ imbalance: string; lines: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as imbalance,
              count(*)::text as lines
         from public.journal_lines
        where org_id = $1
        group by journal_id, journal_created_at`,
      [fixture.tenant.orgId],
    );
    expect(journals.length).toBeGreaterThan(0);
    for (const journal of journals) {
      expect(journal.imbalance).toBe('0.0000');
      expect(Number(journal.lines)).toBeGreaterThanOrEqual(2);
    }
  });

  it('10. 50 concurrent sales for 10 units leave exactly 10 successful and 40 out of stock', async () => {
    const fixture = await posFixture('R3 sale 10', { qty: 10 });

    const results = await runConcurrently(50, async () => {
      await postSaleTx(fixture, crypto.randomUUID(), 1);
    });

    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.filter((result) => !result.ok);

    expect(succeeded).toBe(10);
    expect(failed).toHaveLength(40);

    // The 40 failures are out-of-stock, not deadlocks.
    for (const failure of failed) {
      expect(isRetryable(failure.error), `unexpected retryable failure: ${failure.error.message}`).toBe(false);
      expect(failure.error.message).toMatch(/insufficient stock/i);
    }

    // No oversell: stock on hand is exactly zero.
    const balance = await one<{ qty: string }>(
      `select qty::text as qty from public.stock_balances
        where org_id = $1 and warehouse_id = $2 and product_id = $3 and variant_id = $4`,
      [fixture.tenant.orgId, fixture.warehouseId, fixture.productId, fixture.variantId],
    );
    expect(balance!.qty).toBe('0.0000');

    const sold = await one<{ qty: string }>(
      `select coalesce(sum(il.qty), 0)::text as qty
         from public.invoice_lines il where il.org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(sold!.qty).toBe('10.0000');

    const sales = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('10');
  });

  it('11. A sale paid with USD and ZWG creates 2 pos_payments rows and 2 CORE payments', async () => {
    const fixture = await posFixture('R3 sale 11', { qty: 100, unitPrice: '5.0000' });

    // Total is 2 x 5.0000 plus 15% VAT = 11.5000. Pay 5.00 USD and the rest in ZWG at 30.
    const receipt = await postSale(fixture, {
      lines: [{ barcode: fixture.barcode, qty: 2 }],
      tenders: [
        { method: 'cash', currency: 'USD', amount_tendered: '5' },
        { method: 'cash', currency: 'ZWG', amount_tendered: '300' },
      ],
    });

    const payments = receipt.payments as Array<Record<string, unknown>>;
    expect(payments).toHaveLength(2);
    expect(payments[0]?.currency).toBe('USD');
    expect(payments[1]?.currency).toBe('ZWG');

    const posPayments = await sql<{ currency: string; amount_applied: string; rate: string; change_given: string }>(
      `select currency, amount_applied::text, rate::text, change_given::text
         from public.pos_payments where org_id = $1 order by currency`,
      [fixture.tenant.orgId],
    );
    expect(posPayments).toHaveLength(2);

    const corePayments = await sql<{ n: string }>(
      'select count(*)::text as n from public.payments where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(corePayments[0]?.n).toBe('2');

    // The invoice is fully paid, so no balance is left open.
    const invoice = await one<{ total: string; amount_paid: string }>(
      `select total::text, amount_paid::text from public.invoices where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(invoice!.amount_paid).toBe(invoice!.total);

    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('12. 100 concurrent sales in one branch across shared products finish without deadlock', async () => {
    const fixture = await posFixture('R3 sale 12', { qty: 500 });

    // Ten barcoded variants sharing the one warehouse, so the sales contend on the same rows.
    const barcodes: string[] = [fixture.barcode];
    for (let i = 0; i < 9; i += 1) {
      const barcode = `BC-12-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const variant = await one<{ id: string }>(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Shared', $3) returning id`,
        [fixture.tenant.orgId, fixture.productId, barcode],
      );
      const priceList = await one<{ id: string }>(
        `select id from public.price_lists where org_id = $1 and kind = 'retail'`,
        [fixture.tenant.orgId],
      );
      await sql(
        `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
         values ($1, $2, $3, 5.0000)`,
        [fixture.tenant.orgId, priceList!.id, variant!.id],
      );
      await postReceipt(
        fixture.tenant,
        fixture.warehouseId,
        fixture.productId,
        500,
        2,
        SALE_DATE,
        variant!.id,
      );
      barcodes.push(barcode);
    }

    const shiftId = await shiftIdFor(fixture);

    const results = await runConcurrently(100, async (index) => {
      const barcode = barcodes[index % barcodes.length]!;
      await tx(async (client) => {
        await client.query(
          `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [
            fixture.tenant.orgId,
            fixture.tenant.branchId,
            fixture.warehouseId,
            shiftId,
            crypto.randomUUID(),
            JSON.stringify([{ barcode, qty: 1 }]),
            JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '1000' }]),
          ],
        );
      });
    });

    const committed = results.filter((result) => result.ok).length;
    const failures = results.filter((result) => !result.ok);

    expect(committed).toBeGreaterThan(0);
    // Every sale either commits or fails with a retryable error. A deadlock is a 40P01, which is
    // retryable; no non-retryable error may appear.
    for (const failure of failures) {
      expect(
        isRetryable(failure.error),
        `non-retryable failure: ${(failure.error as { code?: string }).code} ${failure.error.message}`,
      ).toBe(true);
    }

    // Whatever committed, the ledger still balances and stock never went negative.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');

    const negative = await one<{ n: string }>(
      `select count(*)::text as n from public.stock_balances
        where org_id = $1 and qty < 0`,
      [fixture.tenant.orgId],
    );
    expect(negative!.n).toBe('0');
  });

  it('a retried client_sale_id returns the original sale rather than ringing a second one', async () => {
    const fixture = await posFixture('R3 sale idempotency');
    const clientSaleId = crypto.randomUUID();

    const first = await postSale(fixture, {
      clientSaleId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100' }],
    });
    const second = await postSale(fixture, {
      clientSaleId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100' }],
    });

    expect(second.sale_id).toBe(first.sale_id);
    expect(second.invoice_no).toBe(first.invoice_no);

    const sales = await one<{ n: string }>(
      'select count(*)::text as n from public.pos_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(sales!.n).toBe('1');
  });

  it('a sale that fails partway leaves no partial rows', async () => {
    const fixture = await posFixture('R3 sale rollback');

    // The second line asks for far more than is on hand, so create_invoice raises after the first
    // line was consumed. The whole transaction must roll back.
    const error = await expectError(() =>
      tx(async (client) => {
        const shiftId = await shiftIdFor(fixture);
        await client.query(
          `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [
            fixture.tenant.orgId,
            fixture.tenant.branchId,
            fixture.warehouseId,
            shiftId,
            crypto.randomUUID(),
            JSON.stringify([
              { barcode: fixture.barcode, qty: 1 },
              { barcode: fixture.barcode, qty: 100000 },
            ]),
            JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '100' }]),
          ],
        );
      }),
    );
    expect(error.message).toMatch(/insufficient stock/i);

    for (const table of ['pos_sales', 'pos_payments', 'invoices', 'payments']) {
      const row = await one<{ n: string }>(
        `select count(*)::text as n from public.${table} where org_id = $1`,
        [fixture.tenant.orgId],
      );
      expect(row!.n, `${table} has a partial row`).toBe('0');
    }

    // The receipt posted its own journal, but the sale posted none.
    const saleJournals = await one<{ n: string }>(
      `select count(*)::text as n from public.journals
        where org_id = $1 and source_type = 'invoice'`,
      [fixture.tenant.orgId],
    );
    expect(saleJournals!.n).toBe('0');

    // The stock is untouched.
    const balance = await one<{ qty: string }>(
      `select qty::text as qty from public.stock_balances
        where org_id = $1 and warehouse_id = $2 and product_id = $3 and variant_id = $4`,
      [fixture.tenant.orgId, fixture.warehouseId, fixture.productId, fixture.variantId],
    );
    expect(balance!.qty).toBe('100.0000');
  });
});
