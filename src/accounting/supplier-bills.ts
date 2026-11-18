import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { moneyFromSql } from '../core/money';

/**
 * The accounts-payable sub-ledger write path. A bill posts Dr Expense/Inventory (subtotal),
 * Dr VAT Input (tax), Cr Accounts Payable (total); a payment posts Dr AP, Cr Bank. Both go through
 * `app.post_balanced_journal`, so the lines balance at the call site (ADR-0019).
 */

export interface SupplierBillInput {
  orgId: string;
  branchId: string;
  contactId: string;
  billNo: string;
  billDate: string;
  dueDate?: string | null;
  currency?: string;
  subtotal: string | Decimal;
  taxTotal: string | Decimal;
  expenseAccount?: string | undefined;
  taxAccount?: string | undefined;
  apAccount?: string | undefined;
}

export interface PostedSupplierBill {
  billId: string;
  billNo: string;
  total: Decimal;
}

interface PostBillResult {
  bill_id: string;
  bill_no: string;
  total: string;
}

export async function postSupplierBill(
  client: PoolClient,
  input: SupplierBillInput,
): Promise<PostedSupplierBill> {
  const result = await client.query<{ app: PostBillResult }>(
    `select app.post_supplier_bill($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12) as app`,
    [
      input.orgId,
      input.branchId,
      input.contactId,
      input.billNo,
      input.billDate,
      input.dueDate ?? null,
      input.currency ?? 'USD',
      new Decimal(input.subtotal).toFixed(4),
      new Decimal(input.taxTotal).toFixed(4),
      input.expenseAccount ?? '5000',
      input.taxAccount ?? '2200',
      input.apAccount ?? '2000',
    ],
  );
  const row = result.rows[0]!.app;
  return { billId: row.bill_id, billNo: row.bill_no, total: moneyFromSql(row.total) };
}

export async function paySupplierBill(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    billId: string;
    amount: string | Decimal;
    paymentDate: string;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.pay_supplier_bill($1, $2, $3, $4, $5::date) as app`,
    [
      input.orgId,
      input.branchId,
      input.billId,
      new Decimal(input.amount).toFixed(4),
      input.paymentDate,
    ],
  );
  return result.rows[0]!.app;
}

export interface SupplierBillRow {
  billId: string;
  billNo: string;
  contactId: string;
  billDate: string;
  dueDate: string;
  currency: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  amountPaid: Decimal;
  openBalance: Decimal;
}

/** Keyset page of supplier bills on (created_at, id), newest first. */
export async function listSupplierBills(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string | null;
    limit: number;
    cursor?: { createdAt: string; id: string } | null;
  },
): Promise<{ rows: SupplierBillRow[]; nextCursor: { createdAt: string; id: string } | null }> {
  const cursor = input.cursor ?? null;
  const result = await client.query<{
    id: string;
    bill_no: string;
    contact_id: string;
    bill_date: string;
    due_date: string;
    currency: string;
    subtotal: string;
    tax_total: string;
    total: string;
    amount_paid: string;
    open_balance: string;
    created_at: string;
  }>(
    `select id, bill_no, contact_id, bill_date::text as bill_date, due_date::text as due_date,
            currency, subtotal, tax_total, total, amount_paid,
            (total - amount_paid) as open_balance, created_at::text as created_at
       from public.supplier_bills
      where org_id = $1
        and ($2::uuid is null or branch_id = $2::uuid)
        and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
      order by created_at desc, id desc
      limit $5`,
    [input.orgId, input.branchId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit],
  );

  const rows: SupplierBillRow[] = result.rows.map((row) => ({
    billId: row.id,
    billNo: row.bill_no,
    contactId: row.contact_id,
    billDate: row.bill_date,
    dueDate: row.due_date,
    currency: row.currency,
    subtotal: moneyFromSql(row.subtotal),
    taxTotal: moneyFromSql(row.tax_total),
    total: moneyFromSql(row.total),
    amountPaid: moneyFromSql(row.amount_paid),
    openBalance: moneyFromSql(row.open_balance),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    rows.length === input.limit && last ? { createdAt: last.created_at, id: last.id } : null;

  return { rows, nextCursor };
}
