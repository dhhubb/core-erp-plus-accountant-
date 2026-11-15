import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { expectError, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  runConcurrently,
} from './support/fixtures';

describe('M3 inventory', () => {
  it('25. UPDATE and DELETE on stock_ledger are rejected', async () => {
    const t = await createTenant('Inv 25');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Ledger product');
    const ledgerId = await postReceipt(t, wh, product, 5, 2);

    const updateError = await expectError(() =>
      sql('update public.stock_ledger set qty = 99 where id = $1', [ledgerId]),
    );
    expect(updateError.message).toMatch(/append-only/i);

    const deleteError = await expectError(() =>
      sql('delete from public.stock_ledger where id = $1', [ledgerId]),
    );
    expect(deleteError.message).toMatch(/append-only/i);
  });

  it('26. FIFO consumes the oldest layer first', async () => {
    const t = await createTenant('Inv 26');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'FIFO product');

    // Two layers at different costs, oldest first.
    await postReceipt(t, wh, product, 10, 5);
    await sql('select pg_sleep(0.01)');
    await postReceipt(t, wh, product, 10, 8);

    const consumption = await tx(async (client) => {
      const out = await client.query<{ id: string; created_at: string }>(
        `insert into public.stock_ledger
           (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
         values ($1, $2, $3, $4, 'out', 15, 0, 'sale')
         returning id, created_at::text as created_at`,
        [t.orgId, t.branchId, wh, product],
      );
      const outId = out.rows[0]!.id;
      const outAt = out.rows[0]!.created_at;
      const cost = await client.query<{ app: string }>(
        'select app.consume_fifo($1, $2, $3, $4, null, $5, $6, $7::timestamptz)::text as app',
        [t.orgId, t.branchId, wh, product, 15, outId, outAt],
      );
      return cost.rows[0]!.app;
    });

    // 10 units at 5 plus 5 units at 8 = 50 + 40 = 90.
    expect(new Decimal(consumption).equals(new Decimal(90))).toBe(true);

    const consumptions = await sql<{ qty: string; unit_cost: string }>(
      `select qty::text, unit_cost::text from public.stock_consumptions
        where org_id = $1 order by created_at`,
      [t.orgId],
    );
    expect(consumptions).toHaveLength(2);
    // Oldest layer (unit cost 5) consumed first, in full.
    expect(consumptions[0]!.unit_cost).toBe('5.0000');
    expect(consumptions[0]!.qty).toBe('10.0000');
    expect(consumptions[1]!.unit_cost).toBe('8.0000');
    expect(consumptions[1]!.qty).toBe('5.0000');

    // The oldest layer is exhausted; the newer layer has 5 remaining.
    const layers = await sql<{ unit_cost: string; qty_remaining: string }>(
      `select unit_cost::text, qty_remaining::text from public.stock_layer_balances
        where org_id = $1 order by created_at`,
      [t.orgId],
    );
    expect(layers[0]!.qty_remaining).toBe('0.0000');
    expect(layers[1]!.qty_remaining).toBe('5.0000');
  });

  it('27. An outbound quantity beyond available stock is rejected by default', async () => {
    const t = await createTenant('Inv 27');
    const wh = await addWarehouse(t, 'W1', 'W1', false);
    const product = await addProduct(t, 'Short stock');

    await postReceipt(t, wh, product, 3, 1);

    const error = await expectError(() =>
      tx(async (client) => {
        const out = await client.query<{ id: string; created_at: string }>(
          `insert into public.stock_ledger
             (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
           values ($1, $2, $3, $4, 'out', 5, 0, 'sale')
           returning id, created_at::text as created_at`,
          [t.orgId, t.branchId, wh, product],
        );
        await client.query(
          'select app.consume_fifo($1, $2, $3, $4, null, $5, $6, $7::timestamptz)',
          [t.orgId, t.branchId, wh, product, 5, out.rows[0]!.id, out.rows[0]!.created_at],
        );
      }),
    );
    expect(error.message).toMatch(/insufficient stock/i);

    // A warehouse that allows negative stock is not blocked by create_invoice.
    const whNeg = await addWarehouse(t, 'W2', 'W2', true);
    const invoice = await one<{ app: string }>(
      `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
      [
        t.orgId,
        t.branchId,
        '2026-06-15',
        JSON.stringify([
          { product_id: product, warehouse_id: whNeg, qty: 5, unit_price: 1 },
        ]),
      ],
    );
    expect(invoice!.app).toBeTruthy();

    // The same request against a warehouse that forbids negative stock is rejected.
    const blocked = await expectError(() =>
      one(
        `select app.create_invoice($1, $2, null, $3::date, $4::jsonb) as app`,
        [
          t.orgId,
          t.branchId,
          '2026-06-15',
          JSON.stringify([
            { product_id: product, warehouse_id: wh, qty: 5, unit_price: 1 },
          ]),
        ],
      ),
    );
    expect(blocked.message).toMatch(/insufficient stock/i);
  });

  it('28. An adjustment writes ledger rows and a balanced journal in one transaction', async () => {
    const t = await createTenant('Inv 28');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Adjust product');

    await tx(async (client) => {
      await client.query(
        'select app.post_stock_adjustment($1, $2, $3, $4, null, $5, $6, $7::date)',
        [t.orgId, t.branchId, wh, product, 7, 3, '2026-06-15'],
      );
    });

    const ledger = await sql<{ n: string }>(
      `select count(*)::text as n from public.stock_ledger
        where org_id = $1 and source_type = 'adjustment'`,
      [t.orgId],
    );
    expect(ledger[0]?.n).toBe('1');

    const balance = await one<{ dr: string; cr: string }>(
      `select sum(jl.base_debit)::text as dr, sum(jl.base_credit)::text as cr
         from public.journal_lines jl
         join public.journals j
           on j.id = jl.journal_id and j.created_at = jl.journal_created_at
        where jl.org_id = $1 and j.source_type = 'stock_adjustment'`,
      [t.orgId],
    );
    expect(balance).toBeDefined();
    expect(new Decimal(balance!.dr).equals(new Decimal(balance!.cr))).toBe(true);

    // The ledger row and the journal are committed together.
    const journals = await one<{ n: string }>(
      `select count(*)::text as n from public.journals
        where org_id = $1 and source_type = 'stock_adjustment'`,
      [t.orgId],
    );
    expect(journals!.n).toBe('1');

    // A failure inside the adjustment leaves neither behind.
    const before = await one<{ n: string }>(
      `select count(*)::text as n from public.stock_ledger where org_id = $1`,
      [t.orgId],
    );
    const error = await expectError(() =>
      tx(async (client) => {
        await client.query(
          'select app.post_stock_adjustment($1, $2, $3, $4, null, $5, $6, $7::date)',
          [t.orgId, t.branchId, wh, product, -100, 3, '2026-06-15'],
        );
      }),
    );
    expect(error.message).toMatch(/insufficient stock|negative/i);

    const after = await one<{ n: string }>(
      `select count(*)::text as n from public.stock_ledger where org_id = $1`,
      [t.orgId],
    );
    expect(after!.n).toBe(before!.n);
  });

  it('29. A receipt creates an inbound layer with the correct unit cost', async () => {
    const t = await createTenant('Inv 29');
    const wh = await addWarehouse(t, 'W1');
    const product = await addProduct(t, 'Receipt product');

    const ledgerId = await postReceipt(t, wh, product, 12, '7.2500');

    const ledger = await one<{ direction: string; qty: string; unit_cost: string; source_type: string }>(
      `select direction, qty::text, unit_cost::text, source_type
         from public.stock_ledger where id = $1`,
      [ledgerId],
    );
    expect(ledger).toEqual({
      direction: 'in',
      qty: '12.0000',
      unit_cost: '7.2500',
      source_type: 'receipt',
    });

    const layer = await one<{ qty_remaining: string; unit_cost: string }>(
      `select qty_remaining::text, unit_cost::text from public.stock_layer_balances
        where in_ledger_id = $1`,
      [ledgerId],
    );
    expect(layer!.qty_remaining).toBe('12.0000');
    expect(layer!.unit_cost).toBe('7.2500');

    // Dr Inventory / Cr Accounts Payable.
    const journal = await one<{ n: string }>(
      `select count(*)::text as n from public.journals
        where org_id = $1 and source_type = 'receipt'`,
      [t.orgId],
    );
    expect(journal!.n).toBe('1');
  });

  it('30. 200 concurrent SKU generations produce unique SKUs', async () => {
    const t = await createTenant('Inv 30');

    const results = await runConcurrently(200, async () => {
      const row = await one<{ sku: string }>(
        `select app.next_number($1, 'SKU') as sku`,
        [t.orgId],
      );
      return row!.sku;
    });

    const skus = results.map((r) => (r.ok ? r.value : 'FAILED'));
    expect(skus.filter((s) => s === 'FAILED')).toEqual([]);
    expect(new Set(skus).size).toBe(200);
  });

  it('31. A bulk insert of 10,000 products completes in under 3 seconds', async () => {
    const t = await createTenant('Inv 31');

    const start = performance.now();
    await tx(async (client) => {
      await client.query(
        `insert into public.products (org_id, sku, name)
         select $1,
                'BULK-' || lpad(g::text, 8, '0'),
                'Bulk product ' || g
           from generate_series(1, 10000) as g`,
        [t.orgId],
      );
    });
    const elapsed = performance.now() - start;

    const count = await one<{ n: string }>(
      `select count(*)::text as n from public.products where org_id = $1`,
      [t.orgId],
    );
    expect(count!.n).toBe('10000');
    expect(elapsed).toBeLessThan(3000);
  });
});
