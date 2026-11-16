import { describe, expect, it } from 'vitest';
import { one, sql, tx } from './support/db';
import { addWarehouse, createTenant, postReceipt, tenantToken, type Tenant } from './support/fixtures';
import { GET as laybysGet, POST as laybysPost } from '../src/app/api/admin/laybys/route';
import { GET as laybyDetailGet } from '../src/app/api/admin/laybys/[id]/route';
import { GET as returnsGet, POST as returnsPost } from '../src/app/api/admin/returns/route';
import { GET as returnableGet } from '../src/app/api/admin/invoices/[id]/returnable-lines/route';
import { GET as shiftsGet, POST as shiftsPost } from '../src/app/api/admin/shifts/route';
import { GET as zReportGet } from '../src/app/api/admin/z-reports/[id]/route';
import { GET as stocktakeGet, POST as stocktakePost } from '../src/app/api/admin/stocktake/route';
import { GET as stocktakeDetailGet } from '../src/app/api/admin/stocktake/[id]/route';

/**
 * A3 — the admin operations UI's server side. Tests 108–111, continuing from A2's 107 (ADR-0059).
 *
 * The brief called these 32–35, but Phase 1 owns 32–35 (sales) and ADR-0010 forbids renumbering: a
 * new run continues from the highest number actually present. See ADR-0059.
 *
 * Every test drives the real route handlers with a real access token, so RLS is genuinely
 * exercised, and calls the real R5 functions underneath. Nothing is mocked.
 */

const DATE = '2026-06-15';

interface OpsFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  contactId: string;
}

async function opsFixture(name: string, options: { qty?: number; unitCost?: number } = {}): Promise<OpsFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');

  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), $2) returning id`,
    [tenant.orgId, `${name} product`],
  );
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, `BC-${Math.random().toString(36).slice(2, 10)}`],
  );
  const contact = await one<{ id: string }>(
    `insert into public.contacts (org_id, kind, name) values ($1, 'customer', 'Ops customer') returning id`,
    [tenant.orgId],
  );

  await postReceipt(tenant, warehouseId, product!.id, options.qty ?? 100, options.unitCost ?? 2, DATE, variant!.id);

  return {
    tenant,
    warehouseId,
    productId: product!.id,
    variantId: variant!.id,
    contactId: contact!.id,
  };
}

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function createLaybyThroughRoute(
  fixture: OpsFixture,
  input: { dueDate: string; qty: number; unitPrice: number; deposit: number },
): Promise<{ status: number; body: { layby_id: string; layby_no: string; total: string; deposit_paid: string } }> {
  const response = await laybysPost(
    request('/api/admin/laybys', tenantToken(fixture.tenant), {
      method: 'POST',
      body: JSON.stringify({
        contact_id: fixture.contactId,
        warehouse_id: fixture.warehouseId,
        due_date: input.dueDate,
        deposit: input.deposit.toFixed(4),
        lines: [
          {
            product_id: fixture.productId,
            variant_id: fixture.variantId,
            qty: input.qty.toFixed(4),
            unit_price: input.unitPrice.toFixed(4),
          },
        ],
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as never };
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

describe('A3 admin operations UI (server side)', () => {
  it('108. The layby list filters by status and flags overdue; the detail shows deposit, customer and reservations; completing creates a CORE invoice and clears the deposit', async () => {
    const fixture = await opsFixture('A3 108');
    const token = tenantToken(fixture.tenant);

    const created = await createLaybyThroughRoute(fixture, {
      dueDate: '2020-01-01',
      qty: 2,
      unitPrice: 10,
      deposit: 5,
    });
    expect(created.status).toBe(200);
    expect(created.body.total).toBe('23.0000'); // 2 * 10 + 15% VAT
    expect(created.body.deposit_paid).toBe('5.0000');
    const laybyId = created.body.layby_id;

    // A second, completed layby, so the status filter has something to exclude.
    const other = await createLaybyThroughRoute(fixture, {
      dueDate: '2026-12-31',
      qty: 1,
      unitPrice: 10,
      deposit: 1,
    });
    await laybysPost(
      request('/api/admin/laybys', token, {
        method: 'POST',
        body: JSON.stringify({ action: 'complete', layby_id: other.body.layby_id, payment: '0' }),
      }),
    );

    // status=open returns only the open layby, flagged overdue (due_date 2020 is in the past).
    const openPage = await laybysGet(request('/api/admin/laybys?status=open', token));
    const openBody = (await openPage.json()) as {
      laybys: Array<{ id: string; status: string; is_overdue: boolean; contact_name: string | null }>;
    };
    const openRow = openBody.laybys.find((row) => row.id === laybyId);
    expect(openRow?.status).toBe('open');
    expect(openRow?.is_overdue).toBe(true);
    expect(openRow?.contact_name).toBe('Ops customer');
    expect(openBody.laybys.some((row) => row.id === other.body.layby_id)).toBe(false);

    // status=completed returns only the completed one.
    const completedPage = await laybysGet(request('/api/admin/laybys?status=completed', token));
    const completedBody = (await completedPage.json()) as { laybys: Array<{ id: string }> };
    expect(completedBody.laybys.map((row) => row.id)).toEqual([other.body.layby_id]);

    // The detail carries the deposit, the customer and the reservations.
    const detailResponse = await laybyDetailGet(
      request(`/api/admin/laybys/${laybyId}`, token),
      { params: { id: laybyId } },
    );
    const detail = (await detailResponse.json()) as {
      deposit_paid: string;
      is_overdue: boolean;
      customer: { name: string } | null;
      reservations: Array<{ qty: string; unit_cost: string; status: string }>;
    };
    expect(detail.deposit_paid).toBe('5.0000');
    expect(detail.is_overdue).toBe(true);
    expect(detail.customer?.name).toBe('Ops customer');
    expect(detail.reservations).toHaveLength(1);
    expect(detail.reservations[0]!.qty).toBe('2.0000');
    expect(detail.reservations[0]!.unit_cost).toBe('2.0000');
    expect(detail.reservations[0]!.status).toBe('reserved');

    // Complete the layby: a CORE invoice is created and the deposit is cleared against AR.
    const completeResponse = await laybysPost(
      request('/api/admin/laybys', token, {
        method: 'POST',
        body: JSON.stringify({ action: 'complete', layby_id: laybyId, payment: '0' }),
      }),
    );
    expect(completeResponse.status).toBe(200);
    const completed = (await completeResponse.json()) as {
      invoice_id: string;
      invoice_no: string;
      deposit_applied: string;
    };
    expect(completed.invoice_no).toBeTruthy();
    expect(completed.deposit_applied).toBe('5.0000');

    const invoice = await one<{ total: string; amount_paid: string }>(
      `select total::text, amount_paid::text from public.invoices where id = $1`,
      [completed.invoice_id],
    );
    expect(invoice!.total).toBe('23.0000');
    expect(invoice!.amount_paid).toBe('5.0000');

    // The detail now reports the completed status.
    const afterResponse = await laybyDetailGet(
      request(`/api/admin/laybys/${laybyId}`, token),
      { params: { id: laybyId } },
    );
    const after = (await afterResponse.json()) as { status: string; invoice_id: string | null };
    expect(after.status).toBe('completed');
    expect(after.invoice_id).toBe(completed.invoice_id);

    // Everything balances.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('109. Cancelling a layby posts Dr Customer Deposits / Cr Bank / Cr Fee Income with the fee read from settings, and the route refuses a limit above 100 and another org', async () => {
    const fixture = await opsFixture('A3 109');
    const token = tenantToken(fixture.tenant);
    await sql('update public.settings set layby_cancellation_fee = 1 where org_id = $1', [
      fixture.tenant.orgId,
    ]);

    const created = await createLaybyThroughRoute(fixture, {
      dueDate: '2026-12-31',
      qty: 4,
      unitPrice: 10,
      deposit: 6,
    });

    // Cancel with no fee in the body: the settings fee (1) applies.
    const cancelResponse = await laybysPost(
      request('/api/admin/laybys', token, {
        method: 'POST',
        body: JSON.stringify({ action: 'cancel', layby_id: created.body.layby_id }),
      }),
    );
    expect(cancelResponse.status).toBe(200);
    const cancelled = (await cancelResponse.json()) as {
      deposit_paid: string;
      cancellation_fee: string;
      refund: string;
      journal_id: string;
    };
    expect(cancelled.deposit_paid).toBe('6.0000');
    expect(cancelled.cancellation_fee).toBe('1.0000');
    expect(cancelled.refund).toBe('5.0000');

    // Dr Customer Deposits 6, Cr Bank 5, Cr Fee Income 1.
    const lines = await journalLines(cancelled.journal_id);
    expect(lines.find((line) => line.code === '2300')?.debit).toBe('6.0000');
    expect(lines.find((line) => line.code === '1200')?.credit).toBe('5.0000');
    expect(lines.find((line) => line.code === '4600')?.credit).toBe('1.0000');

    // The reserved stock came back.
    const available = await one<{ qty: string }>(
      `select coalesce(sum(qty_remaining), 0)::text as qty
         from public.stock_layer_balances
        where org_id = $1 and product_id = $2 and qty_remaining > 0`,
      [fixture.tenant.orgId, fixture.productId],
    );
    expect(available!.qty).toBe('100.0000');

    // A limit above 100 is refused.
    const tooBig = await laybysGet(request('/api/admin/laybys?limit=101', token));
    expect(tooBig.status).toBe(422);

    // A body naming another org is refused.
    const otherTenant = await createTenant('A3 109 other');
    const crossOrg = await laybysPost(
      request('/api/admin/laybys', token, {
        method: 'POST',
        body: JSON.stringify({
          action: 'cancel',
          layby_id: created.body.layby_id,
          org_id: otherTenant.orgId,
        }),
      }),
    );
    expect(crossOrg.status).toBe(403);
  });

  it('110. A return locks the invoice lines, cannot exceed the quantity sold, and returns stock at the original FIFO cost; the returnable-lines read agrees', async () => {
    const fixture = await opsFixture('A3 110', { qty: 100, unitCost: 2 });
    const token = tenantToken(fixture.tenant);

    // Invoice 5 units at 10 (FIFO cost 2).
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

    // The console reads the returnable lines before creating a return.
    const beforeResponse = await returnableGet(
      request(`/api/admin/invoices/${invoiceId}/returnable-lines`, token),
      { params: { id: invoiceId } },
    );
    const before = (await beforeResponse.json()) as {
      lines: Array<{ line_no: number; qty_sold: string; qty_returned: string; qty_returnable: string }>;
    };
    expect(before.lines).toHaveLength(1);
    expect(before.lines[0]!.line_no).toBe(1);
    expect(before.lines[0]!.qty_sold).toBe('5.0000');
    expect(before.lines[0]!.qty_returned).toBe('0.0000');
    expect(before.lines[0]!.qty_returnable).toBe('5.0000');

    // Return 2 through the route.
    const returnResponse = await returnsPost(
      request('/api/admin/returns', token, {
        method: 'POST',
        body: JSON.stringify({
          original_invoice_id: invoiceId,
          return_date: '2026-06-16',
          refund_method: 'cash',
          lines: [{ line_no: 1, qty: '2.0000' }],
        }),
      }),
    );
    expect(returnResponse.status).toBe(200);
    const returned = (await returnResponse.json()) as {
      return_id: string;
      return_no: string;
      credit_note_id: string;
      total: string;
      refund_method: string;
    };
    expect(returned.total).toBe('23.0000'); // 2 * 10 + 15% VAT
    expect(returned.refund_method).toBe('cash');

    // Stock came back at the original FIFO cost.
    const line = await one<{ unit_cost: string; qty: string }>(
      `select unit_cost::text, qty::text from public.return_lines where return_id = $1`,
      [returned.return_id],
    );
    expect(line!.unit_cost).toBe('2.0000');
    expect(line!.qty).toBe('2.0000');

    // The returnable read now shows the 2 already returned.
    const afterResponse = await returnableGet(
      request(`/api/admin/invoices/${invoiceId}/returnable-lines`, token),
      { params: { id: invoiceId } },
    );
    const after = (await afterResponse.json()) as {
      lines: Array<{ qty_returned: string; qty_returnable: string }>;
    };
    expect(after.lines[0]!.qty_returned).toBe('2.0000');
    expect(after.lines[0]!.qty_returnable).toBe('3.0000');

    // Returning 4 more exceeds the 5 sold (2 already returned): a 422.
    const overResponse = await returnsPost(
      request('/api/admin/returns', token, {
        method: 'POST',
        body: JSON.stringify({
          original_invoice_id: invoiceId,
          return_date: '2026-06-16',
          lines: [{ line_no: 1, qty: '4.0000' }],
        }),
      }),
    );
    expect(overResponse.status).toBe(422);

    // The returns list shows the one return.
    const listResponse = await returnsGet(request('/api/admin/returns', token));
    const listBody = (await listResponse.json()) as {
      returns: Array<{ id: string; return_no: string; refund_method: string }>;
    };
    const row = listBody.returns.find((entry) => entry.id === returned.return_id);
    expect(row?.return_no).toBe(returned.return_no);
    expect(row?.refund_method).toBe('cash');

    // Nothing balances out of true.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('111. Closing a shift writes one Z-report the console reads; a stocktake snapshots, imports and closes to one balanced journal', async () => {
    const fixture = await opsFixture('A3 111', { qty: 100, unitCost: 2 });
    const token = tenantToken(fixture.tenant);

    // An open shift with one sale.
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

    // The console lists the open shift with no Z-report yet.
    const openShifts = (await (await shiftsGet(request('/api/admin/shifts?status=open', token))).json()) as {
      shifts: Array<{ id: string; status: string; z_report_id: string | null; till_id: string }>;
    };
    const openRow = openShifts.shifts.find((row) => row.id === shiftId);
    expect(openRow?.status).toBe('open');
    expect(openRow?.z_report_id).toBeNull();
    expect(openRow?.till_id).toBe('T1');

    // Close the shift through the route: one immutable Z-report.
    const closeResponse = await shiftsPost(
      request('/api/admin/shifts', token, {
        method: 'POST',
        body: JSON.stringify({ shift_id: shiftId }),
      }),
    );
    expect(closeResponse.status).toBe(200);
    const closed = (await closeResponse.json()) as { z_report_id: string };

    const zResponse = await zReportGet(
      request(`/api/admin/z-reports/${closed.z_report_id}`, token),
      { params: { id: closed.z_report_id } },
    );
    const z = (await zResponse.json()) as {
      sale_count: number;
      void_count: number;
      gross_sales: string;
      tax_total: string;
      by_method: Record<string, string>;
      vat_by_rate: Record<string, string>;
    };
    expect(z.sale_count).toBe(1);
    expect(z.void_count).toBe(0);
    expect(z.gross_sales).toBe('20.0000');
    expect(z.tax_total).toBe('3.0000');
    expect(z.by_method).toEqual({ cash: '23.0000' });
    expect(z.vat_by_rate).toEqual({ '0.150000': '3.0000' });

    // The shift now shows as closed with its Z-report.
    const closedShifts = (await (await shiftsGet(request('/api/admin/shifts?status=closed', token))).json()) as {
      shifts: Array<{ id: string; z_report_id: string | null }>;
    };
    expect(closedShifts.shifts.find((row) => row.id === shiftId)?.z_report_id).toBe(
      closed.z_report_id,
    );

    // Stocktake: the snapshot prefills the system quantity and average cost.
    const snapshotResponse = await stocktakeGet(
      request(`/api/admin/stocktake?warehouse_id=${fixture.warehouseId}&snapshot=1`, token),
    );
    const snapshot = (await snapshotResponse.json()) as {
      items: Array<{ product_id: string; system_qty: string; unit_cost: string }>;
    };
    const snap = snapshot.items.find((item) => item.product_id === fixture.productId);
    expect(snap?.system_qty).toBe('98.0000'); // 100 received, 2 sold at the till
    expect(snap?.unit_cost).toBe('2.0000');

    // Open a count and import a counted line (90 where the system says 98: a 8-unit write-off).
    const openResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({ warehouse_id: fixture.warehouseId, counted_at: DATE }),
      }),
    );
    expect(openResponse.status).toBe(200);
    const opened = (await openResponse.json()) as { count_id: string; count_no: string; created_at: string };

    const importResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({
          action: 'lines',
          count_id: opened.count_id,
          count_created_at: opened.created_at,
          lines: [
            {
              product_id: fixture.productId,
              variant_id: fixture.variantId,
              counted_qty: '90.0000',
              system_qty: '98.0000',
              unit_cost: '2.0000',
            },
          ],
        }),
      }),
    );
    expect(importResponse.status).toBe(200);
    expect(((await importResponse.json()) as { imported: number }).imported).toBe(1);

    // The detail shows the variance before closing.
    const detailResponse = await stocktakeDetailGet(
      request(`/api/admin/stocktake/${opened.count_id}?created_at=${encodeURIComponent(opened.created_at)}`, token),
      { params: { id: opened.count_id } },
    );
    const detail = (await detailResponse.json()) as {
      status: string;
      line_count: number;
      variance_lines: number;
      inventory_decrease: string;
    };
    expect(detail.status).toBe('open');
    expect(detail.line_count).toBe(1);
    expect(detail.variance_lines).toBe(1);
    expect(detail.inventory_decrease).toBe('16.0000'); // 8 * 2

    // Close it: one balanced journal, Dr Inventory Adjustment 16 / Cr Inventory 16.
    const closeCountResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({
          action: 'close',
          count_id: opened.count_id,
          count_created_at: opened.created_at,
          posting_date: DATE,
        }),
      }),
    );
    expect(closeCountResponse.status).toBe(200);
    const closedCount = (await closeCountResponse.json()) as {
      adjusted_lines: number;
      inventory_decrease: string;
      journal_id: string;
    };
    expect(closedCount.adjusted_lines).toBe(1);
    expect(closedCount.inventory_decrease).toBe('16.0000');

    const countLines = await journalLines(closedCount.journal_id);
    expect(countLines.find((line) => line.code === '6900')?.debit).toBe('16.0000');
    expect(countLines.find((line) => line.code === '1000')?.credit).toBe('16.0000');

    // The count list shows it as closed.
    const countsResponse = await stocktakeGet(request('/api/admin/stocktake', token));
    const counts = (await countsResponse.json()) as {
      stock_counts: Array<{ id: string; status: string; line_count: number }>;
    };
    const countRow = counts.stock_counts.find((row) => row.id === opened.count_id);
    expect(countRow?.status).toBe('closed');
    expect(countRow?.line_count).toBe(1);

    // The whole ledger balances.
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });
});
