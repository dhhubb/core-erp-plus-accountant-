import { withAccountingAuth, resolveBranchId, requireOrg } from '../_shared';
import { parseLimit, parseCursor, ApiError } from '../../_lib';
import { listSupplierBills, postSupplierBill } from '@/accounting/supplier-bills';

interface BillBody {
  contact_id?: string;
  bill_no?: string;
  bill_date?: string;
  due_date?: string | null;
  currency?: string;
  subtotal?: string;
  tax_total?: string;
  expense_account?: string;
  tax_account?: string;
  ap_account?: string;
}

/** GET /api/accounting/supplier-bills — a keyset page of the AP sub-ledger. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const branchId = resolveBranchId(searchParams, claims);
    const limit = parseLimit(searchParams);
    const cursor = parseCursor(searchParams);

    const page = await listSupplierBills(client, { orgId, branchId, limit, cursor });

    return {
      json: {
        rows: page.rows.map((row) => ({
          bill_id: row.billId,
          bill_no: row.billNo,
          contact_id: row.contactId,
          bill_date: row.billDate,
          due_date: row.dueDate,
          currency: row.currency,
          subtotal: row.subtotal.toFixed(4),
          tax_total: row.taxTotal.toFixed(4),
          total: row.total.toFixed(4),
          amount_paid: row.amountPaid.toFixed(4),
          open_balance: row.openBalance.toFixed(4),
        })),
        next_cursor: page.nextCursor
          ? { after_created_at: page.nextCursor.createdAt, after_id: page.nextCursor.id }
          : null,
      },
    };
  });
}

/** POST /api/accounting/supplier-bills — record a supplier bill (Dr Expense/VAT, Cr AP). */
export async function POST(request: Request) {
  return withAccountingAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const branchId = claims.branchIds[0];
    if (!branchId) throw new ApiError(422, 'no branch is in scope for this request');
    const body = (await request.json()) as BillBody;

    if (!body.contact_id) throw new ApiError(422, 'contact_id is required');
    if (!body.bill_no) throw new ApiError(422, 'bill_no is required');
    if (!body.bill_date) throw new ApiError(422, 'bill_date is required');
    if (body.subtotal === undefined) throw new ApiError(422, 'subtotal is required');

    const bill = await postSupplierBill(client, {
      orgId,
      branchId,
      contactId: body.contact_id,
      billNo: body.bill_no,
      billDate: body.bill_date,
      dueDate: body.due_date ?? null,
      currency: body.currency ?? 'USD',
      subtotal: body.subtotal,
      taxTotal: body.tax_total ?? '0',
      expenseAccount: body.expense_account,
      taxAccount: body.tax_account,
      apAccount: body.ap_account,
    });

    return {
      json: {
        bill_id: bill.billId,
        bill_no: bill.billNo,
        total: bill.total.toFixed(4),
      },
    };
  });
}
