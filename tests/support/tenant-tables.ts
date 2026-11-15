import { randomUUID } from 'node:crypto';
import { sql, tx } from './db';

/**
 * The tenant tables. `scope` is 'org' or 'branch'; `volatile` marks the tables whose rows are
 * created by the posting functions rather than by hand.
 */
export interface TenantTable {
  name: string;
  scope: 'org' | 'branch';
  /** Branch-scoped tables that must carry (org_id, branch_id, created_at desc, id desc). */
  highVolume: boolean;
  /** Partitioned on created_at. */
  partitioned: boolean;
}

export const TENANT_TABLES: TenantTable[] = [
  { name: 'organizations', scope: 'org', highVolume: false, partitioned: false },
  { name: 'branches', scope: 'org', highVolume: false, partitioned: false },
  { name: 'memberships', scope: 'org', highVolume: false, partitioned: false },
  { name: 'invites', scope: 'org', highVolume: false, partitioned: false },
  { name: 'settings', scope: 'org', highVolume: false, partitioned: false },
  { name: 'number_series', scope: 'org', highVolume: false, partitioned: false },
  { name: 'products', scope: 'org', highVolume: false, partitioned: false },
  { name: 'product_variants', scope: 'org', highVolume: false, partitioned: false },
  { name: 'contacts', scope: 'org', highVolume: false, partitioned: false },
  { name: 'chart_of_accounts', scope: 'org', highVolume: false, partitioned: false },
  { name: 'tax_rates', scope: 'org', highVolume: false, partitioned: false },
  { name: 'exchange_rates', scope: 'org', highVolume: false, partitioned: false },
  { name: 'fiscal_periods', scope: 'org', highVolume: false, partitioned: false },
  { name: 'warehouses', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_ledger', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'stock_consumptions', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'stock_balances', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_layer_balances', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_transfers', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'journals', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'journal_lines', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'sales_orders', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'invoices', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'invoice_lines', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'payments', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'credit_notes', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'purchase_orders', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'audit_logs', scope: 'branch', highVolume: true, partitioned: true },
  // R1 (retail): products, barcodes and search.
  { name: 'categories', scope: 'org', highVolume: false, partitioned: false },
  { name: 'product_batches', scope: 'org', highVolume: false, partitioned: false },
  // R2 (retail): pricing and promotions.
  { name: 'price_lists', scope: 'org', highVolume: false, partitioned: false },
  { name: 'price_list_items', scope: 'org', highVolume: false, partitioned: false },
  { name: 'customer_groups', scope: 'org', highVolume: false, partitioned: false },
  { name: 'promotions', scope: 'org', highVolume: false, partitioned: false },
  { name: 'discount_limits', scope: 'org', highVolume: false, partitioned: false },
  { name: 'manual_discounts', scope: 'branch', highVolume: true, partitioned: false },
];

export const PARTITIONED_TABLES = TENANT_TABLES.filter((t) => t.partitioned).map((t) => t.name);

export const HIGH_VOLUME_BRANCH_TABLES = TENANT_TABLES.filter(
  (t) => t.scope === 'branch' && t.highVolume,
).map((t) => t.name);

export const ORG_SCOPED_TABLES = TENANT_TABLES.filter((t) => t.scope === 'org').map((t) => t.name);
export const BRANCH_SCOPED_TABLES = TENANT_TABLES.filter((t) => t.scope === 'branch').map(
  (t) => t.name,
);

export interface SeedIds {
  orgId: string;
  branchId: string;
  warehouseId: string;
  productId: string;
  contactId: string;
  accountId: string;
  journalId: string;
  journalCreatedAt: string;
  ledgerInId: string;
  ledgerInCreatedAt: string;
  ledgerOutId: string;
  ledgerOutCreatedAt: string;
  invoiceId: string;
  userId: string;
}

/**
 * Insert exactly one row into every tenant table for the given org/branch, so a test can assert
 * that a user of another org sees none of them. Runs as the postgres superuser (RLS bypassed),
 * which is the point: the rows exist, and the other org's user must not see them.
 */
export async function seedOneRowPerTenantTable(
  orgId: string,
  branchId: string,
): Promise<SeedIds> {
  const userId = randomUUID();
  await sql('insert into auth.users (id, email) values ($1, $2)', [
    userId,
    `seed-${userId}@example.test`,
  ]);

  const warehouse = await sql<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, $3, 'Seed WH') returning id`,
    [orgId, branchId, `WH-${randomUUID().slice(0, 8)}`],
  );
  const warehouseId = warehouse[0]!.id;

  const product = await sql<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, $2, 'Seed Product') returning id`,
    [orgId, `SKU-${randomUUID().slice(0, 8)}`],
  );
  const productId = product[0]!.id;

  const contact = await sql<{ id: string }>(
    `insert into public.contacts (org_id, kind, name)
     values ($1, 'customer', 'Seed Contact') returning id`,
    [orgId],
  );
  const contactId = contact[0]!.id;

  const account = await sql<{ id: string }>(
    'select id from public.chart_of_accounts where org_id = $1 and code = $2',
    [orgId, '1000'],
  );
  const accountId = account[0]!.id;

  await sql(
    `insert into public.memberships (org_id, user_id, role, branch_ids)
     values ($1, $2, 'member', array[$3]::uuid[])`,
    [orgId, userId, branchId],
  );

  await sql(
    `insert into public.invites (org_id, email, token_hash, expires_at)
     values ($1, 'invitee@example.test', $2, now() + interval '72 hours')`,
    [orgId, randomUUID()],
  );

  await sql(
    `insert into public.product_variants (org_id, product_id, sku, name)
     values ($1, $2, $3, 'Seed Variant')`,
    [orgId, productId, `SKU-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.fiscal_periods (org_id, name, start_date, end_date)
     values ($1, 'Seed Period', date '2020-01-01', date '2020-12-31')`,
    [orgId],
  );

  await sql(
    `insert into public.tax_rates (org_id, code, name, rate, effective_from)
     values ($1, $2, 'Seed Rate', 0.05, date '2020-01-01')`,
    [orgId, `SEED-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.exchange_rates (org_id, currency, rate, effective_from)
     values ($1, 'ZAR', 18.5, date '2020-01-01')`,
    [orgId],
  );

  // The journal and its two balanced lines must be written in one transaction: the deferred
  // balance trigger fires at commit.
  const journalRow = await tx(async (client) => {
    const journal = await client.query<{ id: string; created_at: string }>(
      `insert into public.journals (org_id, branch_id, posting_date, source_type)
       values ($1, $2, current_date, 'manual') returning id, created_at::text as created_at`,
      [orgId, branchId],
    );
    const id = journal.rows[0]!.id;
    const createdAt = journal.rows[0]!.created_at;
    await client.query(
      `insert into public.journal_lines
         (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit,
          base_debit, posting_date)
       values ($1, $2, $3, $4, 1, $5, 1, 1, current_date)`,
      [orgId, branchId, id, createdAt, accountId],
    );
    await client.query(
      `insert into public.journal_lines
         (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, credit,
          base_credit, posting_date)
       values ($1, $2, $3, $4, 2, $5, 1, 1, current_date)`,
      [orgId, branchId, id, createdAt, accountId],
    );
    return { id, createdAt };
  });
  const journalId = journalRow.id;
  const journalCreatedAt = journalRow.createdAt;

  const ledgerIn = await sql<{ id: string; created_at: string }>(
    `insert into public.stock_ledger
       (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
     values ($1, $2, $3, $4, 'in', 10, 1, 'receipt') returning id, created_at::text as created_at`,
    [orgId, branchId, warehouseId, productId],
  );
  const ledgerInId = ledgerIn[0]!.id;
  const ledgerInCreatedAt = ledgerIn[0]!.created_at;

  const ledgerOut = await sql<{ id: string; created_at: string }>(
    `insert into public.stock_ledger
       (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
     values ($1, $2, $3, $4, 'out', 1, 1, 'sale') returning id, created_at::text as created_at`,
    [orgId, branchId, warehouseId, productId],
  );
  const ledgerOutId = ledgerOut[0]!.id;
  const ledgerOutCreatedAt = ledgerOut[0]!.created_at;

  await sql(
    `insert into public.stock_consumptions
       (org_id, branch_id, warehouse_id, product_id, out_ledger_id, out_ledger_created_at,
        in_ledger_id, in_ledger_created_at, qty, unit_cost)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1)`,
    [orgId, branchId, warehouseId, productId, ledgerOutId, ledgerOutCreatedAt, ledgerInId,
     ledgerInCreatedAt],
  );

  await sql(
    `insert into public.stock_balances (org_id, branch_id, warehouse_id, product_id, qty, value)
     values ($1, $2, $3, $4, 9, 9)`,
    [orgId, branchId, warehouseId, productId],
  );

  await sql(
    `insert into public.stock_layer_balances
       (org_id, branch_id, warehouse_id, product_id, in_ledger_id, in_ledger_created_at,
        unit_cost, qty_remaining)
     values ($1, $2, $3, $4, $5, $6, 1, 9)`,
    [orgId, branchId, warehouseId, productId, ledgerInId, ledgerInCreatedAt],
  );

  const warehouse2 = await sql<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, $3, 'Seed WH 2') returning id`,
    [orgId, branchId, `WH2-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.stock_transfers
       (org_id, branch_id, from_warehouse_id, to_warehouse_id, product_id, qty)
     values ($1, $2, $3, $4, $5, 1)`,
    [orgId, branchId, warehouseId, warehouse2[0]!.id, productId],
  );

  await sql(
    `insert into public.sales_orders (org_id, branch_id, contact_id)
     values ($1, $2, $3)`,
    [orgId, branchId, contactId],
  );

  const invoice = await sql<{ id: string }>(
    `insert into public.invoices
       (org_id, branch_id, contact_id, invoice_no, invoice_date, subtotal, tax_total, total)
     values ($1, $2, $3, $4, current_date, 1, 0, 1) returning id`,
    [orgId, branchId, contactId, `SEED-INV-${randomUUID().slice(0, 8)}`],
  );
  const invoiceId = invoice[0]!.id;

  await sql(
    `insert into public.invoice_lines
       (org_id, branch_id, invoice_id, line_no, product_id, warehouse_id, qty, unit_price)
     values ($1, $2, $3, 1, $4, $5, 1, 1)`,
    [orgId, branchId, invoiceId, productId, warehouseId],
  );

  await sql(
    `insert into public.payments (org_id, branch_id, contact_id, invoice_id, amount)
     values ($1, $2, $3, $4, 1)`,
    [orgId, branchId, contactId, invoiceId],
  );

  await sql(
    `insert into public.credit_notes (org_id, branch_id, invoice_id, credit_no, total)
     values ($1, $2, $3, $4, 1)`,
    [orgId, branchId, invoiceId, `SEED-CN-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.purchase_orders (org_id, branch_id, contact_id, po_no)
     values ($1, $2, $3, $4)`,
    [orgId, branchId, contactId, `SEED-PO-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.audit_logs (org_id, branch_id, table_name, record_id, action)
     values ($1, $2, 'invoices', $3, 'insert')`,
    [orgId, branchId, invoiceId],
  );

  await sql(
    `insert into public.categories (org_id, name, slug)
     values ($1, 'Seed Category', $2)`,
    [orgId, `seed-cat-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.product_batches (org_id, variant_id, batch_no, expiry_date)
     values ($1, (select id from public.product_variants where org_id = $1 limit 1), $2, date '2030-01-01')`,
    [orgId, `BATCH-${randomUUID().slice(0, 8)}`],
  );

  // R2 (retail): pricing and promotions.
  const retailList = await sql<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind)
     values ($1, 'Retail', 'retail') returning id`,
    [orgId],
  );
  const retailListId = retailList[0]!.id;

  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, (select id from public.product_variants where org_id = $1 limit 1), 10.0000)`,
    [orgId, retailListId],
  );

  await sql(
    `insert into public.customer_groups (org_id, name, price_list_id)
     values ($1, 'Seed Group', $2)`,
    [orgId, retailListId],
  );

  await sql(
    `insert into public.promotions (org_id, name, type, valid_from, valid_to, conditions)
     values ($1, 'Seed Promo', 'percent', now() - interval '1 day', now() + interval '1 day',
             '{"value": 5}'::jsonb)`,
    [orgId],
  );

  await sql(
    `insert into public.discount_limits (org_id, role, max_percent)
     values ($1, 'member', 5.0000)`,
    [orgId],
  );

  await sql(
    `insert into public.manual_discounts
       (org_id, branch_id, invoice_id, line_no, role, amount, reason)
     values ($1, $2, $3, 1, 'member', 1.0000, 'Seed discount')`,
    [orgId, branchId, invoiceId],
  );

  return {
    orgId,
    branchId,
    warehouseId,
    productId,
    contactId,
    accountId,
    journalId,
    journalCreatedAt,
    ledgerInId,
    ledgerInCreatedAt,
    ledgerOutId,
    ledgerOutCreatedAt,
    invoiceId,
    userId,
  };
}
