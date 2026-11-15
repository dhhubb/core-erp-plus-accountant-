import { describe, expect, it } from 'vitest';
import { expectError, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  runConcurrently,
  type Tenant,
} from './support/fixtures';

/**
 * R5 — Operations (Retail vertical). Tests 19-24.
 *
 * Laybys (reservations, deposit journal, collection, cancellation), returns, credit limits,
 * Z-reports and stock counts. These call the SQL functions directly, exactly as the thin route
 * handlers do. Nothing is mocked: every test runs against the real local Postgres.
 */

const DATE = '2026-06-15';

interface OpsFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  contactId: string;
}

/** A tenant with a warehouse, a product + variant, a customer and stock on hand. */
async function opsFixture(name: string, options: { qty?: number; unitCost?: number } = {}): Promise<OpsFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
  const productId = await addProduct(tenant, `${name} product`);

  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, productId, `BC-${Math.random().toString(36).slice(2, 10)}`],
  );
  const variantId = variant!.id;

  const contact = await one<{ id: string }>(
    `insert into public.contacts (org_id, kind, name)
     values ($1, 'customer', 'Ops customer') returning id`,
    [tenant.orgId],
  );

  await postReceipt(tenant, warehouseId, productId, options.qty ?? 100, options.unitCost ?? 2, DATE, variantId);

  return { tenant, warehouseId, productId, variantId, contactId: contact!.id };
}

async function createLayby(
  fixture: OpsFixture,
  input: { qty: string | number; unitPrice: string | number; deposit: string | number; dueDate?: string },
): Promise<Record<string, unknown>> {
  const row = await one<{ app: Record<string, unknown> }>(
    `select app.create_layby($1, $2, $3, $4, $5::date, $6::jsonb, $7, 'USD', 'VAT15', $8::date) as app`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      fixture.contactId,
      fixture.warehouseId,
      input.dueDate ?? '2026-07-15',
      JSON.stringify([
        {
          product_id: fixture.productId,
          variant_id: fixture.variantId,
          qty: input.qty,
          unit_price: input.unitPrice,
        },
      ]),
      input.deposit,
      DATE,
    ],
  );
  return row!.app;
}

function journalLines(journalId: string): Promise<Array<{ code: string; debit: string; credit: string }>> {
  return sql<{ code: string; debit: string; credit: string }>(
    `select coa.code, jl.debit::text, jl.credit::text
       from public.journal_lines jl
       join public.chart_of_accounts coa on coa.id = jl.account_id
      where jl.journal_id = $1
      order by jl.line_no`,
    [journalId],
  );
}

describe('R5 operations', () => {
  it('19. A layby deposit posts Dr Bank / Cr Customer Deposits and holds the stock aside', async () => {
    const fixture = await opsFixture('R5 19');

    const layby = await createLayby(fixture, { qty: 3, unitPrice: 10, deposit: 5 });
    const journalId = layby.deposit_journal_id as string;
    expect(journalId).toBeTruthy();

    // Dr Bank 1200, Cr Customer Deposits 2300.
    const lines = await journalLines(journalId);
    const bank = lines.find((line) => line.code === '1200');
    const deposits = lines.find((line) => line.code === '2300');
    expect(bank?.debit).toBe('5.0000');
    expect(deposits?.credit).toBe('5.0000');

    // The journal balances.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where journal_id = $1`,
      [journalId],
    );
    expect(imbalance!.d).toBe('0.0000');

    // The reserved stock left the available pool: 100 received, 3 reserved.
    const available = await one<{ qty: string }>(
      `select coalesce(sum(qty_remaining), 0)::text as qty
         from public.stock_layer_balances
        where org_id = $1 and product_id = $2 and qty_remaining > 0`,
      [fixture.tenant.orgId, fixture.productId],
    );
    expect(available!.qty).toBe('97.0000');

    // The reservation row records the reserved cost.
    const reservation = await one<{ qty: string; unit_cost: string; status: string }>(
      `select qty::text, unit_cost::text, status
         from public.layby_reservations where layby_id = $1`,
      [layby.layby_id as string],
    );
    expect(reservation!.qty).toBe('3.0000');
    expect(reservation!.unit_cost).toBe('2.0000');
    expect(reservation!.status).toBe('reserved');
  });

  it('20. Completing a layby creates the invoice and clears the deposit against AR', async () => {
    const fixture = await opsFixture('R5 20');
    const layby = await createLayby(fixture, { qty: 2, unitPrice: 10, deposit: 5 });

    const completed = await one<{ app: Record<string, unknown> }>(
      `select app.complete_layby($1, $2, $3::date, 0) as app`,
      [fixture.tenant.orgId, layby.layby_id as string, '2026-06-16'],
    );
    const payload = completed!.app;
    expect(payload.invoice_no).toBeTruthy();

    // One invoice for the reserved goods; its deposit was applied to AR.
    const invoice = await one<{ total: string; amount_paid: string }>(
      `select total::text, amount_paid::text from public.invoices where id = $1`,
      [payload.invoice_id as string],
    );
    expect(invoice!.total).toBe('23.0000'); // 2 * 10 + 15% VAT
    expect(invoice!.amount_paid).toBe('5.0000');

    const status = await one<{ status: string; invoice_id: string }>(
      `select status, invoice_id from public.laybys where id = $1`,
      [layby.layby_id as string],
    );
    expect(status!.status).toBe('completed');
    expect(status!.invoice_id).toBe(payload.invoice_id);

    const reserved = await one<{ status: string }>(
      `select status from public.layby_reservations where layby_id = $1`,
      [layby.layby_id as string],
    );
    expect(reserved!.status).toBe('collected');

    // Everything still balances.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('21. Cancelling a layby refunds the deposit less the fee and returns the stock', async () => {
    const fixture = await opsFixture('R5 21');
    await sql('update public.settings set layby_cancellation_fee = 1 where org_id = $1', [
      fixture.tenant.orgId,
    ]);

    const layby = await createLayby(fixture, { qty: 4, unitPrice: 10, deposit: 6 });

    const cancelled = await one<{ app: Record<string, unknown> }>(
      `select app.cancel_layby($1, $2, $3::date, null) as app`,
      [fixture.tenant.orgId, layby.layby_id as string, '2026-06-16'],
    );
    const payload = cancelled!.app;

    // Dr Customer Deposits 6, Cr Bank 5, Cr Fee Income 1. (Read the amounts from the ledger, which
    // stores them as NUMERIC, rather than from the jsonb payload, which returns JS numbers.)
    const lines = await journalLines(payload.journal_id as string);
    expect(lines.find((line) => line.code === '2300')?.debit).toBe('6.0000');
    expect(lines.find((line) => line.code === '1200')?.credit).toBe('5.0000');
    expect(lines.find((line) => line.code === '4600')?.credit).toBe('1.0000');

    // The 4 reserved units came back to the available pool.
    const available = await one<{ qty: string }>(
      `select coalesce(sum(qty_remaining), 0)::text as qty
         from public.stock_layer_balances
        where org_id = $1 and product_id = $2 and qty_remaining > 0`,
      [fixture.tenant.orgId, fixture.productId],
    );
    expect(available!.qty).toBe('100.0000');

    const reservation = await one<{ status: string }>(
      `select status from public.layby_reservations where layby_id = $1`,
      [layby.layby_id as string],
    );
    expect(reservation!.status).toBe('released');

    const status = await one<{ status: string; cancellation_fee: string }>(
      `select status, cancellation_fee::text from public.laybys where id = $1`,
      [layby.layby_id as string],
    );
    expect(status!.status).toBe('cancelled');
    expect(status!.cancellation_fee).toBe('1.0000');
  });

  it('22. A return cannot exceed the quantity sold and returns stock at the original FIFO cost', async () => {
    const fixture = await opsFixture('R5 22', { qty: 100, unitCost: 2 });

    // Invoice 5 units at 10, FIFO cost 2.
    const invoice = await one<{ app: { invoice_id: string } }>(
      `select app.create_invoice($1, $2, $3, $4::date, $5::jsonb, 'USD', null) as app`,
      [
        fixture.tenant.orgId,
        fixture.tenant.branchId,
        fixture.contactId,
        DATE,
        JSON.stringify([
          {
            product_id: fixture.productId,
            variant_id: fixture.variantId,
            warehouse_id: fixture.warehouseId,
            qty: 5,
            unit_price: 10,
            tax_rate_code: 'VAT15',
          },
        ]),
      ],
    );
    const invoiceId = invoice!.app.invoice_id;

    // Return 2: allowed.
    const returned = await one<{ app: Record<string, unknown> }>(
      `select app.create_return($1, $2, $3, $4::jsonb, $5::date, 'cash', null) as app`,
      [
        fixture.tenant.orgId,
        fixture.tenant.branchId,
        invoiceId,
        JSON.stringify([{ line_no: 1, qty: 2 }]),
        '2026-06-16',
      ],
    );
    expect(returned!.app.refund_method).toBe('cash');

    // 2 * 10 + 15% VAT = 23. Read the total from the credit note, which is NUMERIC.
    const creditNote = await one<{ total: string }>(
      `select total::text from public.credit_notes where id = $1`,
      [returned!.app.credit_note_id as string],
    );
    expect(creditNote!.total).toBe('23.0000');

    // Stock came back at the original FIFO cost (2 each).
    const line = await one<{ unit_cost: string; qty: string }>(
      `select unit_cost::text, qty::text from public.return_lines where return_id = $1`,
      [returned!.app.return_id as string],
    );
    expect(line!.unit_cost).toBe('2.0000');
    expect(line!.qty).toBe('2.0000');

    // Returning 4 more exceeds the 5 sold (2 already returned).
    const error = await expectError(() =>
      one(
        `select app.create_return($1, $2, $3, $4::jsonb, $5::date, 'cash', null) as app`,
        [
          fixture.tenant.orgId,
          fixture.tenant.branchId,
          invoiceId,
          JSON.stringify([{ line_no: 1, qty: 4 }]),
          '2026-06-16',
        ],
      ),
    );
    expect(error.message).toMatch(/exceeds the/i);

    // Nothing balances out of true.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('23. 20 concurrent credit sales against one customer never exceed the ceiling', async () => {
    const fixture = await opsFixture('R5 23', { qty: 100, unitCost: 2 });

    // A ceiling of 100 with a sale of 10 each: at most 10 may pass. Each task checks the ceiling
    // and then writes the unpaid invoice, inside one transaction. app.check_credit locks the
    // contact FOR UPDATE, so the checks serialise and none of them can each see the same headroom.
    await sql(
      `insert into public.credit_limits (org_id, contact_id, credit_limit)
       values ($1, $2, 100)`,
      [fixture.tenant.orgId, fixture.contactId],
    );

    const results = await runConcurrently(20, async () =>
      tx(async (client) => {
        await client.query(`select app.check_credit($1, $2, 10)`, [
          fixture.tenant.orgId,
          fixture.contactId,
        ]);
        await client.query(
          `select app.create_invoice($1, $2, $3, $4::date, $5::jsonb, 'USD', null)`,
          [
            fixture.tenant.orgId,
            fixture.tenant.branchId,
            fixture.contactId,
            DATE,
            JSON.stringify([
              {
                product_id: fixture.productId,
                variant_id: fixture.variantId,
                warehouse_id: fixture.warehouseId,
                qty: 1,
                unit_price: 10,
              },
            ]),
          ],
        );
      }),
    );

    const succeeded = results.filter((result) => result.ok).length;
    expect(succeeded).toBe(10);

    const failures = results.filter((result) => !result.ok);
    expect(failures.length).toBe(10);
    for (const failure of failures) {
      expect((failure as { error: Error }).error.message).toMatch(/credit limit exceeded/i);
    }

    // The open balance never went past the ceiling.
    const open = await one<{ open: string }>(
      `select coalesce(sum(total - amount_paid), 0)::text as open
         from public.invoices where org_id = $1 and contact_id = $2`,
      [fixture.tenant.orgId, fixture.contactId],
    );
    expect(open!.open).toBe('100.0000');
  });

  it('24. Closing a stock count posts one balanced journal, and closing a shift writes one Z-report', async () => {
    const fixture = await opsFixture('R5 24', { qty: 100, unitCost: 2 });

    // A stock count that finds 90 where the system says 100: a 10-unit write-off at cost 2 = 20.
    const count = await one<{ app: { count_id: string; created_at: string } }>(
      `select app.create_stock_count($1, $2, $3, $4::date) as app`,
      [fixture.tenant.orgId, fixture.tenant.branchId, fixture.warehouseId, DATE],
    );
    const countId = count!.app.count_id;
    const countCreatedAt = count!.app.created_at;

    await sql(
      `insert into public.stock_count_items
         (org_id, branch_id, count_id, count_created_at, line_no, product_id, variant_id,
          counted_qty, system_qty, unit_cost)
       values ($1, $2, $3, $4, 1, $5, $6, 90, 100, 2)`,
      [fixture.tenant.orgId, fixture.tenant.branchId, countId, countCreatedAt, fixture.productId, fixture.variantId],
    );

    const closed = await one<{ app: Record<string, unknown> }>(
      `select app.close_stock_count($1, $2, $3::timestamptz, $4::date, null) as app`,
      [fixture.tenant.orgId, countId, countCreatedAt, DATE],
    );
    expect(closed!.app.adjusted_lines).toBe(1);
    expect(closed!.app.journal_id).toBeTruthy();

    // One journal for the whole count: Dr Inventory Adjustment 20, Cr Inventory 20.
    const lines = await journalLines(closed!.app.journal_id as string);
    expect(lines.find((line) => line.code === '6900')?.debit).toBe('20.0000');
    expect(lines.find((line) => line.code === '1000')?.credit).toBe('20.0000');

    // One ledger row for the variance, and the balance dropped.
    const ledger = await one<{ n: string }>(
      `select count(*)::text as n from public.stock_ledger
        where org_id = $1 and source_type = 'adjustment'`,
      [fixture.tenant.orgId],
    );
    expect(ledger!.n).toBe('1');

    // A shift, a sale, then a Z-report.
    const shift = await one<{ id: string }>(
      `insert into public.shifts (org_id, branch_id, till_id, opening_float)
       values ($1, $2, 'T1', 0) returning id`,
      [fixture.tenant.orgId, fixture.tenant.branchId],
    );
    const shiftId = shift!.id;

    await one(
      `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::date) as app`,
      [
        fixture.tenant.orgId,
        fixture.tenant.branchId,
        fixture.warehouseId,
        shiftId,
        crypto.randomUUID(),
        JSON.stringify([{ variant_id: fixture.variantId, qty: 2, unit_price: 10 }]),
        JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: 100 }]),
        fixture.contactId,
        DATE,
      ],
    );

    const closedShift = await one<{ app: string }>(
      `select app.close_shift($1, $2, $3) as app`,
      [fixture.tenant.orgId, shiftId, fixture.tenant.userId],
    );
    const zReportId = closedShift!.app;

    const report = await one<{
      sale_count: number;
      void_count: number;
      gross_sales: string;
      tax_total: string;
      by_method: string;
      vat_by_rate: string;
    }>(
      `select sale_count, void_count, gross_sales::text, tax_total::text, by_method::text,
              vat_by_rate::text
         from public.z_reports where id = $1`,
      [zReportId],
    );
    expect(report!.sale_count).toBe(1);
    expect(report!.void_count).toBe(0);
    expect(report!.gross_sales).toBe('20.0000');
    expect(report!.tax_total).toBe('3.0000');
    expect(JSON.parse(report!.by_method)).toEqual({ cash: 23 });
    expect(JSON.parse(report!.vat_by_rate)).toEqual({ '0.150000': 3 });

    // A Z-report is immutable.
    const error = await expectError(() =>
      sql('update public.z_reports set sale_count = 99 where id = $1', [zReportId]),
    );
    expect(error.message).toMatch(/append-only/i);

    // Everything balances.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });
});
