import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { expectError, isRetryable, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  runConcurrently,
  type Tenant,
} from './support/fixtures';

const DATE = '2026-06-15';

async function createInvoice(
  t: Tenant,
  warehouseId: string,
  productId: string,
  qty: number | string,
  unitPrice: number | string,
  taxRateCode: string | null = null,
): Promise<{ invoice_id: string; invoice_no: string; subtotal: string; tax_total: string; total: string }> {
  const row = await one<{ app: { invoice_id: string; invoice_no: string; subtotal: string; tax_total: string; total: string } }>(
    `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
    [
      t.orgId,
      t.branchId,
      DATE,
      JSON.stringify([
        {
          product_id: productId,
          warehouse_id: warehouseId,
          qty,
          unit_price: unitPrice,
          tax_rate_code: taxRateCode,
        },
      ]),
    ],
  );
  return row!.app;
}

describe('M4 sales and purchases', () => {
  it('32. A rolled-back invoice does not consume an invoice number', async () => {
    const t = await createTenant('Sales 32');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Rollback product');
    await postReceipt(t, wh, product, 10, 1);

    const before = await one<{ next_value: string }>(
      `select next_value::text from public.number_series where org_id = $1 and code = 'INVOICE'`,
      [t.orgId],
    );

    await expectError(() =>
      tx(async (client) => {
        await client.query(
          `select app.create_invoice($1, $2, null, $3::date, $4::jsonb)`,
          [
            t.orgId,
            t.branchId,
            DATE,
            JSON.stringify([
              { product_id: product, warehouse_id: wh, qty: 1, unit_price: 10 },
            ]),
          ],
        );
        throw new Error('force rollback');
      }),
    );

    const after = await one<{ next_value: string }>(
      `select next_value::text from public.number_series where org_id = $1 and code = 'INVOICE'`,
      [t.orgId],
    );
    expect(after!.next_value).toBe(before!.next_value);

    const invoices = await one<{ n: string }>(
      'select count(*)::text as n from public.invoices where org_id = $1',
      [t.orgId],
    );
    expect(invoices!.n).toBe('0');

    // The next committed invoice takes the number the rollback would have used.
    const created = await createInvoice(t, wh, product, 1, 10);
    expect(created.invoice_no).toBe('000001');
  });

  it('33. A payment cannot exceed the open invoice balance', async () => {
    const t = await createTenant('Sales 33');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Payment product');
    await postReceipt(t, wh, product, 10, 2);

    const invoice = await createInvoice(t, wh, product, 2, 10);

    const tooMuch = await expectError(() =>
      one('select app.allocate_payment($1, $2, $3, $4, $5::date) as app', [
        t.orgId,
        t.branchId,
        invoice.invoice_id,
        '25.0000',
        DATE,
      ]),
    );
    expect(tooMuch.message).toMatch(/exceeds open balance/i);

    // An exact-balance payment is accepted.
    await one('select app.allocate_payment($1, $2, $3, $4, $5::date) as app', [
      t.orgId,
      t.branchId,
      invoice.invoice_id,
      '20.0000',
      DATE,
    ]);

    const paid = await one<{ amount_paid: string }>(
      'select amount_paid::text from public.invoices where id = $1',
      [invoice.invoice_id],
    );
    expect(new Decimal(paid!.amount_paid).equals(new Decimal('20'))).toBe(true);

    // Now the balance is zero: any further payment is rejected.
    const over = await expectError(() =>
      one('select app.allocate_payment($1, $2, $3, $4, $5::date) as app', [
        t.orgId,
        t.branchId,
        invoice.invoice_id,
        '0.0001',
        DATE,
      ]),
    );
    expect(over.message).toMatch(/exceeds open balance/i);
  });

  it('34. A credit note returns stock at the original FIFO cost and reverses the journal', async () => {
    const t = await createTenant('Sales 34');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Credit product');

    // Layer at 4, then a second layer at 9. The invoice consumes the 4-cost layer.
    await postReceipt(t, wh, product, 5, 4);
    await sql('select pg_sleep(0.01)');
    await postReceipt(t, wh, product, 5, 9);

    const invoice = await createInvoice(t, wh, product, 3, 20);

    const originalCost = await one<{ unit_cost: string }>(
      'select unit_cost::text from public.invoice_lines where invoice_id = $1 and line_no = 1',
      [invoice.invoice_id],
    );
    expect(originalCost!.unit_cost).toBe('4.0000');

    const beforeJournal = await one<{ dr: string; cr: string }>(
      `select sum(base_debit)::text as dr, sum(base_credit)::text as cr
         from public.journal_lines where org_id = $1`,
      [t.orgId],
    );

    const credit = await one<{ app: { credit_note_id: string; credit_no: string; total: string } }>(
      `select app.create_credit_note($1, $2, $3, $4::jsonb, $5::date) as app`,
      [
        t.orgId,
        t.branchId,
        invoice.invoice_id,
        JSON.stringify([{ line_no: 1, qty: 3 }]),
        DATE,
      ],
    );
    expect(credit!.app.credit_no).toBe('CN-000001');
    expect(new Decimal(credit!.app.total).equals(new Decimal('60'))).toBe(true);

    // Returned stock is a new inbound layer at the original FIFO cost (4), not today's cost (9).
    const returned = await one<{ unit_cost: string; qty_remaining: string }>(
      `select unit_cost::text, qty_remaining::text from public.stock_layer_balances
        where org_id = $1 and in_ledger_id in (
          select id from public.stock_ledger where source_type = 'credit_note'
        )`,
      [t.orgId],
    );
    expect(returned!.unit_cost).toBe('4.0000');
    expect(returned!.qty_remaining).toBe('3.0000');

    // The credit note's journal reverses revenue, VAT and AR, and returns inventory at cost.
    const noteJournal = await one<{ dr: string; cr: string }>(
      `select sum(jl.base_debit)::text as dr, sum(jl.base_credit)::text as cr
         from public.journal_lines jl
         join public.journals j on j.id = jl.journal_id and j.created_at = jl.journal_created_at
        where j.source_type = 'credit_note' and jl.org_id = $1`,
      [t.orgId],
    );
    expect(new Decimal(noteJournal!.dr).equals(new Decimal(noteJournal!.cr))).toBe(true);

    // Revenue account nets to zero across the invoice and the credit note.
    const revenue = await one<{ net: string }>(
      `select (sum(jl.base_credit) - sum(jl.base_debit))::text as net
         from public.journal_lines jl
         join public.journals j on j.id = jl.journal_id and j.created_at = jl.journal_created_at
         join public.chart_of_accounts a on a.id = jl.account_id
        where jl.org_id = $1 and a.code = '4000'`,
      [t.orgId],
    );
    expect(new Decimal(revenue!.net).isZero()).toBe(true);
    expect(beforeJournal).toBeDefined();
  });

  it('35. Keyset pagination returns every row exactly once across pages', async () => {
    const t = await createTenant('Sales 35');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Paging product');
    await postReceipt(t, wh, product, 200, 1);

    for (let i = 0; i < 25; i += 1) {
      await createInvoice(t, wh, product, 1, 1 + i);
    }

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows: Array<{ id: string; created_at: string }> = await sql(
        `select id, created_at from app.list_invoices($1, $2, $3, $4::timestamptz, $5)`,
        [t.orgId, t.branchId, 10, cursor?.createdAt ?? null, cursor?.id ?? null],
      );
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.created_at, id: last.id };
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);

    // Descending (created_at, id) order across page boundaries.
    const ordered = await sql<{ id: string }>(
      `select id from public.invoices where org_id = $1 order by created_at desc, id desc`,
      [t.orgId],
    );
    expect(seen).toEqual(ordered.map((r) => r.id));
  });

  it('36. A failure partway through create_invoice leaves no partial rows', async () => {
    const t = await createTenant('Sales 36');
    const wh = await addWarehouse(t, 'W1');
    const okProduct = await addProduct(t, 'Available');
    const shortProduct = await addProduct(t, 'Short');
    await postReceipt(t, wh, okProduct, 10, 1);
    await postReceipt(t, wh, shortProduct, 1, 1);

    const ledgerBefore = await one<{ n: string }>(
      'select count(*)::text as n from public.stock_ledger where org_id = $1',
      [t.orgId],
    );

    const error = await expectError(() =>
      tx(async (client) => {
        await client.query('select app.create_invoice($1, $2, null, $3::date, $4::jsonb)', [
          t.orgId,
          t.branchId,
          DATE,
          JSON.stringify([
            { product_id: okProduct, warehouse_id: wh, qty: 1, unit_price: 5 },
            { product_id: shortProduct, warehouse_id: wh, qty: 5, unit_price: 5 },
          ]),
        ]);
      }),
    );
    expect(error.message).toMatch(/insufficient stock/i);

    for (const table of ['invoices', 'invoice_lines', 'payments', 'credit_notes']) {
      const count = await one<{ n: string }>(
        `select count(*)::text as n from public.${table} where org_id = $1`,
        [t.orgId],
      );
      expect(count!.n, `${table} has partial rows`).toBe('0');
    }

    // Only the two receipts' journals exist; the rolled-back invoice posted none.
    const journals = await one<{ n: string }>(
      `select count(*)::text as n from public.journals
        where org_id = $1 and source_type = 'invoice'`,
      [t.orgId],
    );
    expect(journals!.n).toBe('0');

    const ledgerAfter = await one<{ n: string }>(
      'select count(*)::text as n from public.stock_ledger where org_id = $1',
      [t.orgId],
    );
    expect(ledgerAfter!.n).toBe(ledgerBefore!.n);

    // Stock is untouched: both layers still hold what they held.
    const balances = await sql<{ qty_remaining: string }>(
      `select qty_remaining::text from public.stock_layer_balances
        where org_id = $1 order by unit_cost`,
      [t.orgId],
    );
    expect(balances.map((b) => b.qty_remaining).sort()).toEqual(['1.0000', '10.0000']);
  });

  it('37. A list request with a limit above 100 is rejected', async () => {
    const t = await createTenant('Sales 37');

    const error = await expectError(() =>
      sql(`select * from app.list_invoices($1, $2, 101)`, [t.orgId, t.branchId]),
    );
    expect(error.message).toMatch(/limit must be between 1 and 100/i);

    const zero = await expectError(() =>
      sql(`select * from app.list_invoices($1, $2, 0)`, [t.orgId, t.branchId]),
    );
    expect(zero.message).toMatch(/limit must be between 1 and 100/i);

    // The maximum itself is accepted.
    const rows = await sql(`select * from app.list_invoices($1, $2, 100)`, [t.orgId, t.branchId]);
    expect(rows).toEqual([]);
  });
});

describe('M4 concurrency', () => {
  it('38. 100 concurrent sales across shared products finish without deadlock', async () => {
    const t = await createTenant('Conc 38');
    const wh = await addWarehouse(t, 'W1');
    const products = await Promise.all([0, 1, 2].map((i) => addProduct(t, `Shared ${i}`)));
    for (const product of products) {
      await postReceipt(t, wh, product, 1000, 1);
    }

    const results = await runConcurrently(100, async (index) => {
      const product = products[index % products.length]!;
      const row = await one<{ app: { invoice_no: string } }>(
        `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
        [
          t.orgId,
          t.branchId,
          DATE,
          JSON.stringify([
            { product_id: product, warehouse_id: wh, qty: 1, unit_price: 3 },
          ]),
        ],
      );
      return row!.app.invoice_no;
    });

    const failures = results.filter((r) => !r.ok);
    // Each one either commits or fails with a retryable error. No deadlock (40P01) is allowed
    // to be the reason, and every failure must be retryable.
    for (const failure of failures) {
      expect(isRetryable(failure.error), `non-retryable failure: ${failure.error.message}`).toBe(
        true,
      );
    }

    const committed = results.filter((r) => r.ok).length;
    const invoiceCount = await one<{ n: string }>(
      'select count(*)::text as n from public.invoices where org_id = $1',
      [t.orgId],
    );
    expect(Number(invoiceCount!.n)).toBe(committed);
    expect(committed).toBeGreaterThan(0);
  });

  it('39. 100 concurrent invoices receive 100 unique, gapless numbers', async () => {
    const t = await createTenant('Conc 39');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Numbered');
    await postReceipt(t, wh, product, 1000, 1);

    const results = await runConcurrently(100, async () => {
      const row = await one<{ app: { invoice_no: string } }>(
        `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
        [
          t.orgId,
          t.branchId,
          DATE,
          JSON.stringify([{ product_id: product, warehouse_id: wh, qty: 1, unit_price: 1 }]),
        ],
      );
      return row!.app.invoice_no;
    });

    const numbers = results.filter((r) => r.ok).map((r) => (r as { value: string }).value);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);

    // Gapless: 000001 .. 000100 with nothing missing.
    const expected = Array.from({ length: 100 }, (_, i) =>
      String(i + 1).padStart(6, '0'),
    );
    expect([...numbers].sort()).toEqual(expected);
  });

  it('40. 100 concurrent sales that lock products in opposite order finish without deadlock', async () => {
    const t = await createTenant('Conc 40');
    const whA = await addWarehouse(t, 'WA');
    const whB = await addWarehouse(t, 'WB');
    const productA = await addProduct(t, 'Cross A');
    const productB = await addProduct(t, 'Cross B');
    await postReceipt(t, whA, productA, 1000, 1);
    await postReceipt(t, whA, productB, 1000, 1);
    await postReceipt(t, whB, productA, 1000, 1);
    await postReceipt(t, whB, productB, 1000, 1);

    // Half the requests list (A, B) and half list (B, A) within the same warehouse. The SQL
    // function sorts the lock keys, so neither order can deadlock.
    const results = await runConcurrently(100, async (index) => {
      const reverse = index % 2 === 1;
      const warehouse = index % 4 < 2 ? whA : whB;
      const lines = reverse
        ? [
            { product_id: productB, warehouse_id: warehouse, qty: 1, unit_price: 2 },
            { product_id: productA, warehouse_id: warehouse, qty: 1, unit_price: 2 },
          ]
        : [
            { product_id: productA, warehouse_id: warehouse, qty: 1, unit_price: 2 },
            { product_id: productB, warehouse_id: warehouse, qty: 1, unit_price: 2 },
          ];

      const row = await one<{ app: { invoice_no: string } }>(
        `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
        [t.orgId, t.branchId, DATE, JSON.stringify(lines)],
      );
      return row!.app.invoice_no;
    });

    for (const failure of results.filter((r) => !r.ok)) {
      expect(
        failure.error.message,
        `deadlock detected: ${failure.error.message}`,
      ).not.toMatch(/deadlock/i);
      expect(isRetryable(failure.error)).toBe(true);
    }

    const committed = results.filter((r) => r.ok).length;
    expect(committed).toBeGreaterThan(0);

    const invoiceCount = await one<{ n: string }>(
      'select count(*)::text as n from public.invoices where org_id = $1',
      [t.orgId],
    );
    expect(Number(invoiceCount!.n)).toBe(committed);
  });
});
