import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { expectError, one, sql, tx } from './support/db';
import { accountId, createTenant, tenantToken, type Tenant } from './support/fixtures';
import {
  arAging,
  apAging,
  balanceSheet,
  cashFlow,
  changesInEquity,
  generalLedger,
  journalDetail,
  journalList,
  profitAndLoss,
  trialBalance,
  vatReturn,
} from '../src/accounting/reports';
import { listSupplierBills, paySupplierBill, postSupplierBill } from '../src/accounting/supplier-bills';
import { toCsv, trialBalanceCsv } from '../src/accounting/export';
import { GET as trialBalanceGet } from '../src/app/api/accounting/trial-balance/route';
import { GET as profitAndLossGet } from '../src/app/api/accounting/profit-and-loss/route';
import { GET as balanceSheetGet } from '../src/app/api/accounting/balance-sheet/route';
import { GET as arAgingGet } from '../src/app/api/accounting/ar-aging/route';
import { GET as accountsGet } from '../src/app/api/accounting/accounts/route';

/**
 * AC — the accountant. Every report is read from the real ledger, so the statements reconcile by
 * construction and a closed period reprints the same way (ADR-0065). Nothing is mocked.
 */

interface Fixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  customerId: string;
  supplierId: string;
}

/** A branch with stock, one product and a customer and a supplier contact. */
async function acFixture(name: string): Promise<Fixture> {
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
  const customer = await one<{ id: string }>(
    `insert into public.contacts (org_id, kind, name) values ($1, 'customer', $2) returning id`,
    [tenant.orgId, `${name} customer`],
  );
  const supplier = await one<{ id: string }>(
    `insert into public.contacts (org_id, kind, name) values ($1, 'supplier', $2) returning id`,
    [tenant.orgId, `${name} supplier`],
  );
  return {
    tenant,
    warehouseId: warehouse!.id,
    productId: product!.id,
    customerId: customer!.id,
    supplierId: supplier!.id,
  };
}

/** Inbound stock layer plus journal (Dr Inventory, Cr AP). */
async function receive(
  fx: Fixture,
  qty: string,
  unitCost: string,
  date = '2026-06-01',
): Promise<void> {
  await sql(`select app.post_receipt($1, $2, $3, $4, null, $5, $6, $7::date)`, [
    fx.tenant.orgId,
    fx.tenant.branchId,
    fx.warehouseId,
    fx.productId,
    qty,
    unitCost,
    date,
  ]);
}

/** Create an invoice and return its id and total. */
async function invoice(
  fx: Fixture,
  input: {
    qty: string;
    unitPrice: string;
    date?: string;
    taxCode?: string | null;
    contactId?: string | null;
  },
): Promise<{ id: string; total: Decimal }> {
  const line: Record<string, unknown> = {
    product_id: fx.productId,
    warehouse_id: fx.warehouseId,
    qty: input.qty,
    unit_price: input.unitPrice,
  };
  if (input.taxCode !== null && input.taxCode !== undefined) line['tax_rate_code'] = input.taxCode;

  const row = await one<{ app: { invoice_id: string; total: string } }>(
    `select app.create_invoice($1, $2, $3, $4::date, $5::jsonb) as app`,
    [
      fx.tenant.orgId,
      fx.tenant.branchId,
      input.contactId ?? fx.customerId,
      input.date ?? '2026-06-15',
      JSON.stringify([line]),
    ],
  );
  return { id: row!.app.invoice_id, total: new Decimal(row!.app.total) };
}

/** A tenant with one receipt, one paid invoice and a second open invoice. */
async function tradingFixture(name: string): Promise<Fixture & { openInvoiceTotal: Decimal }> {
  const fx = await acFixture(name);
  // Dr Inventory 20 / Cr AP 20
  await receive(fx, '10', '2.0000');
  // Dr AR 23 / Cr Revenue 20 / Cr VAT 3 ; Dr COGS 8 / Cr Inventory 8
  const first = await invoice(fx, { qty: '4', unitPrice: '5.0000', taxCode: 'VAT15' });
  // Pay it in full: Dr Bank 23 / Cr AR 23
  await sql(`select app.allocate_payment($1, $2, $3, $4, $5::date)`, [
    fx.tenant.orgId,
    fx.tenant.branchId,
    first.id,
    first.total.toFixed(4),
    '2026-06-20',
  ]);
  // A second, unpaid invoice aged 45 days: subtotal 10, VAT 1.5, total 11.5
  const second = await invoice(fx, {
    qty: '2',
    unitPrice: '5.0000',
    taxCode: 'VAT15',
    date: '2026-05-01',
  });
  return { ...fx, openInvoiceTotal: second.total };
}

describe('AC accounting reports', () => {
  it('112. Trial balance reconciles: period debits equal credits and closing sums to zero', async () => {
    const fx = await tradingFixture('AC 112');
    const rows = await tx((client) =>
      trialBalance(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );

    const byCode = new Map(rows.map((row) => [row.code, row]));
    // Inventory 20 in, 8 + 4 out = 8 debit; AR 23 out, 23 paid, 11.5 open; Bank 23 debit.
    expect(byCode.get('1000')!.closing.toFixed(4)).toBe('8.0000');
    expect(byCode.get('1100')!.closing.toFixed(4)).toBe('11.5000');
    expect(byCode.get('1200')!.closing.toFixed(4)).toBe('23.0000');
    expect(byCode.get('2000')!.closing.toFixed(4)).toBe('-20.0000');
    expect(byCode.get('2100')!.closing.toFixed(4)).toBe('-4.5000');
    expect(byCode.get('4000')!.closing.toFixed(4)).toBe('-30.0000');
    expect(byCode.get('5000')!.closing.toFixed(4)).toBe('12.0000');

    const debit = rows.reduce((sum, row) => sum.plus(row.debit), new Decimal(0));
    const credit = rows.reduce((sum, row) => sum.plus(row.credit), new Decimal(0));
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));

    const closing = rows.reduce((sum, row) => sum.plus(row.closing), new Decimal(0));
    expect(closing.toFixed(4)).toBe('0.0000');
  });

  it('113. Profit and loss splits revenue, cost of sales and operating expenses', async () => {
    const fx = await tradingFixture('AC 113');
    const report = await tx((client) =>
      profitAndLoss(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );

    expect(report.totalRevenue.toFixed(4)).toBe('30.0000');
    expect(report.totalCostOfSales.toFixed(4)).toBe('12.0000');
    expect(report.grossProfit.toFixed(4)).toBe('18.0000');
    expect(report.totalOperatingExpenses.toFixed(4)).toBe('0.0000');
    expect(report.netProfit.toFixed(4)).toBe('18.0000');
  });

  it('114. Balance sheet balances: assets equal liabilities plus equity', async () => {
    const fx = await tradingFixture('AC 114');
    const report = await tx((client) =>
      balanceSheet(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        asOf: '2026-06-30',
      }),
    );

    // Assets: inventory 8 + AR 11.5 + bank 23 = 42.5
    expect(report.totalAssets.toFixed(4)).toBe('42.5000');
    // Liabilities: AP 20 + VAT 4.5 = 24.5
    expect(report.totalLiabilities.toFixed(4)).toBe('24.5000');
    // Equity: accumulated profit 18 (revenue 30 - COGS 12); no retained-earnings movement.
    expect(report.totalEquity.toFixed(4)).toBe('18.0000');
    expect(report.balanced).toBe(true);
    expect(report.difference.toFixed(4)).toBe('0.0000');
  });

  it('115. Statement of changes in equity carries the profit for the period', async () => {
    const fx = await tradingFixture('AC 115');
    const report = await tx((client) =>
      changesInEquity(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-06-01', to: '2026-06-30' },
      }),
    );

    const profit = report.rows.find((row) => row.kind === 'profit_for_period');
    expect(profit).toBeDefined();
    // June only: invoice 1 revenue 20 - COGS 8 = 12; invoice 2 (May) excluded.
    expect(report.profitForPeriod.toFixed(4)).toBe('12.0000');
    expect(report.openingEquity.toFixed(4)).toBe('6.0000');
    expect(report.closingEquity.toFixed(4)).toBe('18.0000');
    for (const row of report.rows) {
      expect(row.opening.plus(row.movement).toFixed(4)).toBe(row.closing.toFixed(4));
    }
  });

  it('116. Statement of cash flows reconciles the three activities to the change in cash', async () => {
    const fx = await tradingFixture('AC 116');
    const report = await tx((client) =>
      cashFlow(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );

    expect(report.openingCash.toFixed(4)).toBe('0.0000');
    expect(report.closingCash.toFixed(4)).toBe('23.0000');
    expect(report.netChange.toFixed(4)).toBe('23.0000');
    expect(report.operating.toFixed(4)).toBe('23.0000');
    expect(report.reconciles).toBe(true);
  });

  it('117. AR aging buckets the open invoice and reconciles with the AR control account', async () => {
    const fx = await tradingFixture('AC 117');
    const report = await tx((client) =>
      arAging(client, { orgId: fx.tenant.orgId, branchId: fx.tenant.branchId, asOf: '2026-06-30' }),
    );

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.contactName).toContain('customer');
    // The invoice is 45 days old, so it lands in the 31-60 bucket.
    expect(row.days31To60.toFixed(4)).toBe('11.5000');
    expect(row.current.toFixed(4)).toBe('0.0000');
    expect(report.totals.total.toFixed(4)).toBe('11.5000');
    expect(report.controlAccount.toFixed(4)).toBe('11.5000');
    expect(report.reconciles).toBe(true);
  });

  it('118. Supplier bills post to AP and pay down to zero', async () => {
    const fx = await acFixture('AC 118');
    const bill = await tx((client) =>
      postSupplierBill(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        contactId: fx.supplierId,
        billNo: 'BILL-1',
        billDate: '2026-06-10',
        dueDate: '2026-06-10',
        subtotal: '100',
        taxTotal: '15',
      }),
    );
    expect(bill.total.toFixed(4)).toBe('115.0000');

    const apBalance = await one<{ balance: string }>(
      `select app.report_control_account_balance($1, $2, '2000', '2026-06-30'::date)::text as balance`,
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(new Decimal(apBalance!.balance).toFixed(4)).toBe('-115.0000');

    await tx((client) =>
      paySupplierBill(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        billId: bill.billId,
        amount: '115',
        paymentDate: '2026-06-20',
      }),
    );

    const paid = await one<{ open_balance: string }>(
      'select (total - amount_paid)::text as open_balance from public.supplier_bills where id = $1',
      [bill.billId],
    );
    expect(new Decimal(paid!.open_balance).toFixed(4)).toBe('0.0000');
  });

  it('119. AP aging ages a supplier bill from its due date', async () => {
    const fx = await acFixture('AC 119');
    await tx((client) =>
      postSupplierBill(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        contactId: fx.supplierId,
        billNo: 'BILL-1',
        billDate: '2026-05-01',
        dueDate: '2026-05-01',
        subtotal: '200',
        taxTotal: '0',
      }),
    );

    const report = await tx((client) =>
      apAging(client, { orgId: fx.tenant.orgId, branchId: fx.tenant.branchId, asOf: '2026-06-15' }),
    );
    const row = report.rows[0]!;
    // 45 days overdue lands in the 31-60 bucket.
    expect(row.days31To60.toFixed(4)).toBe('200.0000');
    expect(report.controlAccount.toFixed(4)).toBe('200.0000');
    expect(report.reconciles).toBe(true);
  });

  it('120. A supplier payment above the open balance is rejected', async () => {
    const fx = await acFixture('AC 120');
    const bill = await tx((client) =>
      postSupplierBill(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        contactId: fx.supplierId,
        billNo: 'BILL-1',
        billDate: '2026-06-10',
        subtotal: '50',
        taxTotal: '0',
      }),
    );

    const error = await expectError(() =>
      tx((client) =>
        paySupplierBill(client, {
          orgId: fx.tenant.orgId,
          branchId: fx.tenant.branchId,
          billId: bill.billId,
          amount: '60',
          paymentDate: '2026-06-20',
        }),
      ),
    );
    expect(error.message).toMatch(/exceeds open balance/i);
  });

  it('121. The general ledger lists one account with a running balance and keyset pagination', async () => {
    const fx = await tradingFixture('AC 121');
    const inventoryAccount = await accountId(fx.tenant, '1000');

    // June only, so the May invoice's COGS line is the opening balance (-4).
    const firstPage = await tx((client) =>
      generalLedger(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        accountId: inventoryAccount,
        period: { from: '2026-06-01', to: '2026-06-30' },
        limit: 1,
      }),
    );
    expect(firstPage.rows).toHaveLength(1);
    expect(firstPage.rows[0]!.debit.toFixed(4)).toBe('20.0000');
    expect(firstPage.rows[0]!.runningBalance.toFixed(4)).toBe('16.0000');
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.openingBalance.toFixed(4)).toBe('-4.0000');
    expect(firstPage.closingBalance.toFixed(4)).toBe('8.0000');

    const secondPage = await tx((client) =>
      generalLedger(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        accountId: inventoryAccount,
        period: { from: '2026-06-01', to: '2026-06-30' },
        limit: 1,
        cursor: firstPage.nextCursor,
      }),
    );
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0]!.credit.toFixed(4)).toBe('8.0000');
    // The running balance continues across pages because it is recomputed from the opening balance.
    expect(secondPage.rows[0]!.runningBalance.toFixed(4)).toBe('8.0000');

    // A full page always returns a cursor; the next page past the end is empty.
    expect(secondPage.nextCursor).not.toBeNull();
    const thirdPage = await tx((client) =>
      generalLedger(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        accountId: inventoryAccount,
        period: { from: '2026-06-01', to: '2026-06-30' },
        limit: 1,
        cursor: secondPage.nextCursor,
      }),
    );
    expect(thirdPage.rows).toHaveLength(0);
    expect(thirdPage.nextCursor).toBeNull();
  });

  it('122. The journal list pages by keyset and its detail balances', async () => {
    const fx = await tradingFixture('AC 122');
    const page = await tx((client) =>
      journalList(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
        limit: 2,
      }),
    );
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const detail = await tx((client) =>
      journalDetail(client, {
        orgId: fx.tenant.orgId,
        journalId: page.rows[0]!.journalId,
        journalCreatedAt: page.rows[0]!.createdAt,
      }),
    );
    expect(detail.journal).not.toBeNull();
    expect(detail.lines.length).toBeGreaterThanOrEqual(2);
    const debit = detail.lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
    const credit = detail.lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it('123. The VAT return nets output VAT against input VAT', async () => {
    const fx = await tradingFixture('AC 123');
    await tx((client) =>
      postSupplierBill(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        contactId: fx.supplierId,
        billNo: 'BILL-1',
        billDate: '2026-06-05',
        subtotal: '100',
        taxTotal: '15',
      }),
    );

    const report = await tx((client) =>
      vatReturn(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );
    // Output VAT on both invoices: 3 + 1.5 = 4.5. Input VAT on the bill: 15.
    expect(report.outputVat.toFixed(4)).toBe('4.5000');
    expect(report.inputVat.toFixed(4)).toBe('15.0000');
    expect(report.netVat.toFixed(4)).toBe('-10.5000');
  });

  it('124. A report is tenant-scoped: another org sees none of the rows', async () => {
    const fx = await tradingFixture('AC 124');
    const other = await createTenant('AC 124 other');

    const rows = await tx((client) =>
      trialBalance(client, {
        orgId: other.orgId,
        branchId: other.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );
    // The other org has the default chart of accounts but no movement, so no rows.
    expect(rows).toHaveLength(0);

    const control = await one<{ balance: string }>(
      `select app.report_control_account_balance($1, $2, '1000', '2026-06-30'::date)::text as balance`,
      [other.orgId, other.branchId],
    );
    expect(new Decimal(control!.balance).toFixed(4)).toBe('0.0000');
    expect(fx.tenant.orgId).not.toBe(other.orgId);
  });

  it('125. The trial balance CSV carries a header row and one row per account', async () => {
    const fx = await tradingFixture('AC 125');
    const rows = await tx((client) =>
      trialBalance(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        period: { from: '2026-05-01', to: '2026-06-30' },
      }),
    );
    const csv = toCsv(trialBalanceCsv(rows));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Code,Account,Type,Section,Opening,Debit,Credit,Closing');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1]).toContain('1000');
  });

  it('126. listSupplierBills pages by keyset', async () => {
    const fx = await acFixture('AC 126');
    for (let i = 1; i <= 3; i += 1) {
      await tx((client) =>
        postSupplierBill(client, {
          orgId: fx.tenant.orgId,
          branchId: fx.tenant.branchId,
          contactId: fx.supplierId,
          billNo: `BILL-${i}`,
          billDate: '2026-06-10',
          subtotal: `${i * 10}`,
          taxTotal: '0',
        }),
      );
    }

    const page = await tx((client) =>
      listSupplierBills(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        limit: 2,
      }),
    );
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const next = await tx((client) =>
      listSupplierBills(client, {
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        limit: 2,
        cursor: page.nextCursor,
      }),
    );
    expect(next.rows).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
  });
});

describe('AC accounting routes', () => {
  function request(token: string, path: string): Request {
    return new Request(`http://localhost${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  }

  it('127. the trial-balance route requires a bearer token', async () => {
    const response = await trialBalanceGet(
      new Request('http://localhost/api/accounting/trial-balance?from=2026-06-01&to=2026-06-30', {
        headers: { accept: 'application/json' },
      }),
    );
    expect(response.status).toBe(401);
  });

  it('128. the trial-balance route returns fixed-scale money and a CSV download', async () => {
    const fx = await tradingFixture('AC 128');
    const token = tenantToken(fx.tenant);

    const json = await trialBalanceGet(
      request(token, '/api/accounting/trial-balance?from=2026-05-01&to=2026-06-30'),
    );
    expect(json.status).toBe(200);
    const body = (await json.json()) as {
      rows: Array<{ code: string; closing: string }>;
    };
    const inventory = body.rows.find((row) => row.code === '1000')!;
    expect(inventory.closing).toBe('8.0000');

    const csv = await trialBalanceGet(
      request(token, '/api/accounting/trial-balance?from=2026-05-01&to=2026-06-30&format=csv'),
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe('Code,Account,Type,Section,Opening,Debit,Credit,Closing');
  });

  it('129. the profit-and-loss route returns the totals', async () => {
    const fx = await tradingFixture('AC 129');
    const token = tenantToken(fx.tenant);
    const response = await profitAndLossGet(
      request(token, '/api/accounting/profit-and-loss?from=2026-05-01&to=2026-06-30'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { net_profit: string; gross_profit: string };
    expect(body.net_profit).toBe('18.0000');
    expect(body.gross_profit).toBe('18.0000');
  });

  it('130. the balance-sheet route reports a balanced statement', async () => {
    const fx = await tradingFixture('AC 130');
    const token = tenantToken(fx.tenant);
    const response = await balanceSheetGet(
      request(token, '/api/accounting/balance-sheet?as_of=2026-06-30'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      balanced: boolean;
      difference: string;
      assets: { total: string };
    };
    expect(body.balanced).toBe(true);
    expect(body.difference).toBe('0.0000');
    expect(body.assets.total).toBe('42.5000');
  });

  it('131. the AR aging route reconciles with the control account', async () => {
    const fx = await tradingFixture('AC 131');
    const token = tenantToken(fx.tenant);
    const response = await arAgingGet(request(token, '/api/accounting/ar-aging?as_of=2026-06-30'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reconciles: boolean;
      control_account: string;
      totals: { total: string };
    };
    expect(body.reconciles).toBe(true);
    expect(body.control_account).toBe('11.5000');
    expect(body.totals.total).toBe('11.5000');
  });

  it('132. the accounts route lists the chart of accounts for the ledger picker', async () => {
    const fx = await acFixture('AC 132');
    const token = tenantToken(fx.tenant);
    const response = await accountsGet(request(token, '/api/accounting/accounts'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accounts: Array<{ code: string }> };
    const codes = body.accounts.map((account) => account.code);
    expect(codes).toContain('1000');
    expect(codes).toContain('2000');
    // Ordered by code.
    expect(codes).toEqual([...codes].sort());
  });

  it('133. a bad period is rejected with 422', async () => {
    const fx = await acFixture('AC 133');
    const token = tenantToken(fx.tenant);
    const response = await trialBalanceGet(
      request(token, '/api/accounting/trial-balance?from=2026-06-30&to=2026-06-01'),
    );
    expect(response.status).toBe(422);
  });
});
