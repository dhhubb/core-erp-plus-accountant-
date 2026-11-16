import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectError, one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  refreshedClaims,
  tenantToken,
  type Tenant,
} from './support/fixtures';
import { GET as profitRoute } from '../src/app/api/reports/profit/route';
import { GET as vatRoute } from '../src/app/api/reports/vat/route';
import { GET as zReportsRoute } from '../src/app/api/reports/z-reports/route';
import {
  glPeriodProfit,
  lastSync,
  productRanking,
  profitByProduct,
  vatReport,
  zReports,
} from '../src/verticals/reports';

/**
 * H6 — reports and the owner console. Tests 86–95, continuing from H5's 85 (ADR-0045).
 *
 * Everything runs against the real local Postgres. A report is read two ways in these tests: through
 * the SQL functions on a real transaction, and through the route handlers with a real access token,
 * so RLS is genuinely exercised.
 *
 * A closed day is read from the immutable `daily_product_sales` facts (written at shift close);
 * today is read live from `invoices` + `invoice_lines`. The two never overlap (ADR-0046).
 */

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

interface ReportFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
  shiftId: string;
  unitPrice: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price and stock on hand. */
async function reportFixture(
  name: string,
  options: { qty?: number; unitCost?: number; unitPrice?: string } = {},
): Promise<ReportFixture> {
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

  const unitPrice = options.unitPrice ?? '10.0000';
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, $4)`,
    [tenant.orgId, priceList!.id, variantId, unitPrice],
  );

  await postReceipt(
    tenant,
    warehouseId,
    productId,
    options.qty ?? 100,
    options.unitCost ?? 4,
    TODAY,
    variantId,
  );

  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );

  return { tenant, warehouseId, productId, variantId, barcode, shiftId: shift!.id, unitPrice };
}

/** Ring a sale through app.post_pos_sale, exactly as the thin route handler does. */
async function postSale(
  fixture: ReportFixture,
  input: {
    lines: Array<{ barcode?: string; variant_id?: string; qty: string | number }>;
    amountTendered: string;
    clientSaleId?: string;
    saleDate?: string;
  },
): Promise<Record<string, unknown>> {
  const row = await one<{ app: Record<string, unknown> }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, null, $8::date) as app`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      fixture.warehouseId,
      fixture.shiftId,
      input.clientSaleId ?? randomUUID(),
      JSON.stringify(
        input.lines.map((line) => ({ ...line, unit_price: fixture.unitPrice })),
      ),
      JSON.stringify([
        { method: 'cash', currency: 'USD', amount_tendered: input.amountTendered },
      ]),
      input.saleDate ?? TODAY,
    ],
  );
  return row!.app;
}

/** Close a shift, writing its Z-report and its immutable daily facts. */
async function closeShift(fixture: ReportFixture): Promise<string> {
  const row = await one<{ app: string }>(`select app.close_shift($1, $2, $3) as app`, [
    fixture.tenant.orgId,
    fixture.shiftId,
    fixture.tenant.userId,
  ]);
  return row!.app;
}

/** A sale that has been rung and its shift closed: a closed-day fact. */
async function closedSale(
  name: string,
  qty: number,
  options: { unitPrice?: string; unitCost?: number } = {},
): Promise<ReportFixture> {
  const fixture = await reportFixture(name, options);
  await postSale(fixture, { lines: [{ barcode: fixture.barcode, qty }], amountTendered: '1000' });
  await closeShift(fixture);
  return fixture;
}

describe('H6 reports and the owner console', () => {
  it('86. Profit by product equals the GL for the period', async () => {
    const fixture = await closedSale('H6 test 86', 3, { unitPrice: '10.0000', unitCost: 4 });
    // A return nets out of the report as a negative row and lowers the GL by the same amount.
    const invoice = await one<{ id: string }>(
      `select i.id from public.invoices i
        join public.pos_sales ps on ps.invoice_id = i.id
       where ps.org_id = $1 limit 1`,
      [fixture.tenant.orgId],
    );
    await sql(`select app.create_return($1, $2, $3, $4::jsonb)`, [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      invoice!.id,
      JSON.stringify([{ line_no: 1, qty: 1 }]),
    ]);

    await tx(async (client) => {
      const report = await profitByProduct(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: TODAY, to: TODAY },
      });
      const gl = await glPeriodProfit(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: TODAY, to: TODAY },
      });

      // One product: revenue 20 (30 sold less 10 returned), cogs 8 (12 less 4), profit 12.
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]!.revenue.toFixed(4)).toBe('20.0000');
      expect(report.rows[0]!.cogs.toFixed(4)).toBe('8.0000');
      expect(report.rows[0]!.profit.toFixed(4)).toBe('12.0000');

      // The report must equal the ledger.
      expect(gl.revenue.toFixed(4)).toBe(report.rows[0]!.revenue.toFixed(4));
      expect(gl.cogs.toFixed(4)).toBe(report.rows[0]!.cogs.toFixed(4));
      expect(gl.profit.toFixed(4)).toBe(report.rows[0]!.profit.toFixed(4));
    });
  });

  it('87. Best sellers and slow movers are ranked by quantity', async () => {
    const tenant = await createTenant('H6 test 87');
    const warehouseId = await addWarehouse(tenant, 'W1');
    const shift = await one<{ id: string }>(
      `insert into public.shifts (org_id, branch_id, till_id, opening_float)
       values ($1, $2, 'T1', 0) returning id`,
      [tenant.orgId, tenant.branchId],
    );
    const priceList = await one<{ id: string }>(
      `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
      [tenant.orgId],
    );

    const makeProduct = async (qty: number): Promise<string> => {
      const productId = await addProduct(tenant, `ranked ${qty}`);
      const variant = await one<{ id: string }>(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [tenant.orgId, productId, `BC-${randomUUID().slice(0, 8)}`],
      );
      await sql(
        `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
         values ($1, $2, $3, '10.0000')`,
        [tenant.orgId, priceList!.id, variant!.id],
      );
      await postReceipt(tenant, warehouseId, productId, qty + 10, 4, TODAY, variant!.id);
      await sql(
        `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, null, $8::date)`,
        [
          tenant.orgId,
          tenant.branchId,
          warehouseId,
          shift!.id,
          randomUUID(),
          JSON.stringify([{ variant_id: variant!.id, qty, unit_price: '10.0000' }]),
          JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '10000' }]),
          TODAY,
        ],
      );
      return productId;
    };

    const low = await makeProduct(1);
    const mid = await makeProduct(5);
    const high = await makeProduct(9);

    await tx(async (client) => {
      const best = await productRanking(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        period: { from: TODAY, to: TODAY },
        ascending: false,
      });
      expect(best.rows.map((row) => row.productId)).toEqual([high, mid, low]);

      const slow = await productRanking(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        period: { from: TODAY, to: TODAY },
        ascending: true,
      });
      expect(slow.rows.map((row) => row.productId)).toEqual([low, mid, high]);
    });
  });

  it('88. The VAT report splits sales by the rate each line used, matching the Z-report', async () => {
    const fixture = await closedSale('H6 test 88', 2, { unitPrice: '10.0000' });

    await tx(async (client) => {
      const vat = await vatReport(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: TODAY, to: TODAY },
      });
      expect(vat).toHaveLength(1);
      expect(vat[0]!.taxRate.toFixed(6)).toBe('0.150000');
      expect(vat[0]!.net.toFixed(4)).toBe('20.0000');
      expect(vat[0]!.tax.toFixed(4)).toBe('3.0000');
      expect(vat[0]!.gross.toFixed(4)).toBe('23.0000');

      // The Z-report reads the same invoice lines, so its by-rate split must agree.
      const page = await zReports(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.vatByRate['0.150000']!.toFixed(4)).toBe(vat[0]!.tax.toFixed(4));
    });
  });

  it('89. Z-reports page with their fiscal totals', async () => {
    const fixture = await closedSale('H6 test 89', 2, { unitPrice: '10.0000' });

    // The fiscal queue row is created by the branch worker, not the close; add it and mark it sent.
    await sql(
      `insert into public.fiscal_invoices (org_id, branch_id, invoice_id, status, sent_at)
       select $1, $2, ps.invoice_id, 'sent', now()
         from public.pos_sales ps
        where ps.org_id = $1 and ps.shift_id = $3`,
      [fixture.tenant.orgId, fixture.tenant.branchId, fixture.shiftId],
    );

    await tx(async (client) => {
      const page = await zReports(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(page.rows).toHaveLength(1);
      const report = page.rows[0]!;
      expect(report.grossSales.toFixed(4)).toBe('20.0000');
      expect(report.taxTotal.toFixed(4)).toBe('3.0000');
      // The fiscal totals are computed at read time: the invoice was sent after the close.
      expect(report.fiscal.sent.count).toBe(1);
      expect(report.fiscal.sent.amount.toFixed(4)).toBe('23.0000');
      expect(report.fiscal.pending.count).toBe(0);
      expect(report.fiscal.failed.count).toBe(0);
    });
  });

  it('90. A closed day is read from the facts; today is read live', async () => {
    const fixture = await reportFixture('H6 test 90', { unitPrice: '10.0000', unitCost: 4 });

    // Today: a sale that has NOT been closed. The report must read it live.
    await postSale(fixture, { lines: [{ barcode: fixture.barcode, qty: 2 }], amountTendered: '1000' });
    await tx(async (client) => {
      const today = await profitByProduct(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: TODAY, to: TODAY },
      });
      expect(today.rows[0]!.qty.toFixed(4)).toBe('2.0000');
      const facts = await one<{ n: string }>(
        'select count(*)::text as n from public.daily_product_sales where org_id = $1',
        [fixture.tenant.orgId],
      );
      expect(facts!.n).toBe('0');
    });

    // Close the shift: the fact is written and the live figure is unchanged.
    await closeShift(fixture);
    await tx(async (client) => {
      const facts = await one<{ n: string; qty: string }>(
        `select count(*)::text as n, coalesce(sum(qty), 0)::text as qty
           from public.daily_product_sales where org_id = $1`,
        [fixture.tenant.orgId],
      );
      expect(facts!.n).toBe('1');
      expect(Number(facts!.qty)).toBe(2);
    });

    // A yesterday-bounded report reads the fact and not the live table: the sale date is today, so
    // the closed-day read for yesterday returns nothing even though the fact exists.
    await tx(async (client) => {
      const yesterday = await profitByProduct(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: YESTERDAY, to: YESTERDAY },
      });
      expect(yesterday.rows).toHaveLength(0);
    });
  });

  it('91. Keyset pagination returns every product exactly once', async () => {
    const tenant = await createTenant('H6 test 91');
    const shift = await one<{ id: string }>(
      `insert into public.shifts (org_id, branch_id, till_id, opening_float)
       values ($1, $2, 'T1', 0) returning id`,
      [tenant.orgId, tenant.branchId],
    );

    // Twelve closed-day facts for twelve distinct products, inserted directly (the fact table is
    // written by close_shift; a direct insert stands in for a closed shift here).
    const productIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const productId = await addProduct(tenant, `paged ${i}`);
      productIds.push(productId);
      await sql(
        `insert into public.daily_product_sales
           (org_id, branch_id, business_date, shift_id, product_id, qty, gross, tax, cogs)
         values ($1, $2, current_date - 1, $3, $4, 1, 10, 1.5, 4)`,
        [tenant.orgId, tenant.branchId, shift!.id, productId],
      );
    }

    await tx(async (client) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page = await profitByProduct(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          period: { from: YESTERDAY, to: YESTERDAY },
          limit: 5,
          afterProductId: cursor,
        });
        seen.push(...page.rows.map((row) => row.productId));
        pages += 1;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor.afterProductId;
        expect(pages).toBeLessThan(10);
      }
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect([...seen].sort()).toEqual([...productIds].sort());
    });
  });

  it('92. The daily facts are append-only, and a closed day cannot be changed', async () => {
    const fixture = await closedSale('H6 test 92', 2, { unitPrice: '10.0000' });

    const update = await expectError(() =>
      sql(`update public.daily_product_sales set qty = 99 where org_id = $1`, [fixture.tenant.orgId]),
    );
    expect(update.message).toMatch(/immutable|permission denied|not allowed/i);

    const remove = await expectError(() =>
      sql(`delete from public.daily_product_sales where org_id = $1`, [fixture.tenant.orgId]),
    );
    expect(remove.message).toMatch(/immutable|permission denied|not allowed/i);

    // The row is untouched.
    const row = await one<{ qty: string }>(
      'select qty::text as qty from public.daily_product_sales where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(Number(row!.qty)).toBe(2);

    // Closing the same shift again cannot double-write: the unique key makes it idempotent, and the
    // close itself is refused.
    const secondClose = await expectError(() => closeShift(fixture));
    expect(secondClose.message).toMatch(/already closed/);
  });

  it('93. daily_product_sales is a well-formed tenant table', async () => {
    const table = await one<{ org_id: string; created_at: string; rls: boolean; forced: boolean }>(
      `select
         (select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'daily_product_sales'
             and column_name = 'org_id') as org_id,
         (select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'daily_product_sales'
             and column_name = 'created_at') as created_at,
         c.relrowsecurity as rls,
         c.relforcerowsecurity as forced
       from pg_class c
      where c.oid = 'public.daily_product_sales'::regclass`,
    );
    expect(table!.org_id).toBe('NO');
    expect(table!.created_at).toBe('NO');
    expect(table!.rls).toBe(true);
    expect(table!.forced).toBe(true);

    // The high-volume branch index and the FK indexes.
    const indexes = await sql<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'daily_product_sales'`,
    );
    const defs = indexes.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/\(org_id, branch_id, created_at DESC, id DESC\)/);
    expect(defs).toMatch(/\(product_id\)/);
    expect(defs).toMatch(/\(shift_id\)/);

    // No float, real or double column anywhere in the new table.
    const floats = await sql(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'daily_product_sales'
          and data_type in ('real', 'double precision')`,
    );
    expect(floats).toHaveLength(0);
  });

  it('94. A report reads only its own branch', async () => {
    const fixture = await closedSale('H6 test 94', 2, { unitPrice: '10.0000' });

    // A second branch in the same org, with its own closed sale.
    const otherBranch = await one<{ id: string }>(
      `insert into public.branches (org_id, name, slug) values ($1, 'Other', 'other') returning id`,
      [fixture.tenant.orgId],
    );
    const otherWarehouse = await one<{ id: string }>(
      `insert into public.warehouses (org_id, branch_id, code, name)
       values ($1, $2, 'W2', 'W2') returning id`,
      [fixture.tenant.orgId, otherBranch!.id],
    );
    const otherProduct = await addProduct(fixture.tenant, 'other branch product');
    const otherVariant = await one<{ id: string }>(
      `insert into public.product_variants (org_id, product_id, sku, name, barcode)
       values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
      [fixture.tenant.orgId, otherProduct, `BC-${randomUUID().slice(0, 8)}`],
    );
    await postReceipt(
      fixture.tenant,
      otherWarehouse!.id,
      otherProduct,
      100,
      4,
      TODAY,
      otherVariant!.id,
    );
    const otherShift = await one<{ id: string }>(
      `insert into public.shifts (org_id, branch_id, till_id, opening_float)
       values ($1, $2, 'T2', 0) returning id`,
      [fixture.tenant.orgId, otherBranch!.id],
    );
    await sql(
      `insert into public.daily_product_sales
         (org_id, branch_id, business_date, shift_id, product_id, qty, gross, tax, cogs)
       values ($1, $2, current_date - 1, $3, $4, 7, 70, 10.5, 28)`,
      [fixture.tenant.orgId, otherBranch!.id, otherShift!.id, otherProduct],
    );

    // The user's token scopes only the first branch.
    const claims = refreshedClaims(fixture.tenant.userId, fixture.tenant.orgId, [
      fixture.tenant.branchId,
    ]);
    await tx(async (client) => {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: claims.sub, role: 'authenticated', org_id: claims.orgId, branch_ids: claims.branchIds }),
      ]);
      const page = await profitByProduct(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: YESTERDAY, to: TODAY },
      });
      // Only the first branch's product, never the other branch's seven units.
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.productId).toBe(fixture.productId);
    });
  });

  it('95. The report routes reject a limit above 100 and a branch out of scope', async () => {
    const fixture = await closedSale('H6 test 95', 1, { unitPrice: '10.0000' });
    const token = tenantToken(fixture.tenant);

    const request = (path: string): Request =>
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });

    const overLimit = await profitRoute(request('/api/reports/profit?limit=101'));
    expect(overLimit.status).toBe(422);

    const outOfScope = await profitRoute(
      request(`/api/reports/profit?branch_id=${randomUUID()}`),
    );
    expect(outOfScope.status).toBe(403);

    const ok = await profitRoute(request(`/api/reports/profit?from=${TODAY}&to=${TODAY}`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);

    // The VAT and Z-report routes answer too.
    expect((await vatRoute(request(`/api/reports/vat?from=${TODAY}&to=${TODAY}`))).status).toBe(200);
    expect((await zReportsRoute(request('/api/reports/z-reports'))).status).toBe(200);

    // The owner console's sync label is well-formed: the same figures read the same way on both
    // sides, and the label states when the branch last synced (ADR-0049).
    await tx(async (client) => {
      const sync = await lastSync(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(typeof sync.outboxSize).toBe('number');
      expect(sync.lastCloudContactAt).toBeNull();
    });
  });
});
