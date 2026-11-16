import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import { listLaybys } from '@/verticals/admin';
import {
  cancelLayby,
  completeLayby,
  createLayby,
  type LaybyLineInput,
} from '@/verticals/ops/laybys';

interface CreateLaybyBody {
  org_id?: string;
  contact_id: string;
  warehouse_id: string;
  due_date: string;
  currency?: string;
  tax_code?: string;
  posting_date?: string | null;
  deposit: string;
  lines: Array<{
    product_id: string;
    variant_id?: string | null;
    qty: string;
    unit_price: string;
    tax_rate_code?: string | null;
  }>;
}

interface CompleteLaybyBody {
  org_id?: string;
  action: 'complete';
  layby_id: string;
  completion_date?: string | null;
  payment?: string;
}

interface CancelLaybyBody {
  org_id?: string;
  action: 'cancel';
  layby_id: string;
  cancellation_date?: string | null;
  fee?: string | null;
}

/** GET /api/admin/laybys — keyset page of laybys with an optional ?status= filter. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status !== null && !['open', 'completed', 'cancelled'].includes(status)) {
      throw new ApiError(422, 'status must be one of open, completed, cancelled');
    }

    const page = await listLaybys(client, {
      orgId,
      branchId: claims.branchIds[0]!,
      status: status as 'open' | 'completed' | 'cancelled' | null,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });

    return {
      laybys: page.laybys.map((layby) => ({
        id: layby.id,
        layby_no: layby.laybyNo,
        status: layby.status,
        due_date: layby.dueDate,
        currency: layby.currency,
        total: layby.total.toFixed(4),
        deposit_paid: layby.depositPaid.toFixed(4),
        contact_id: layby.contactId,
        contact_name: layby.contactName,
        invoice_id: layby.invoiceId,
        is_overdue: layby.isOverdue,
        created_at: layby.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/admin/laybys — create a layby, or complete/cancel one by passing `action`. Completion
 * creates the CORE invoice and clears the deposit; cancellation posts the refund less the fee. The
 * rule lives in the R5 functions; this handler only maps the body.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as
      | CreateLaybyBody
      | CompleteLaybyBody
      | CancelLaybyBody;
    assertSameOrg(claims, body.org_id);
    const action = (body as { action?: string }).action;

    if (action === 'complete') {
      const input = body as CompleteLaybyBody;
      const result = await withWriteErrors(() =>
        completeLayby(client, {
          orgId,
          laybyId: input.layby_id,
          completionDate: input.completion_date ?? null,
          ...(input.payment !== undefined ? { payment: input.payment } : {}),
        }),
      );
      return {
        layby_id: result.laybyId,
        invoice_id: result.invoiceId,
        invoice_no: result.invoiceNo,
        deposit_applied: result.depositApplied.toFixed(4),
      };
    }

    if (action === 'cancel') {
      const input = body as CancelLaybyBody;
      const result = await withWriteErrors(() =>
        cancelLayby(client, {
          orgId,
          laybyId: input.layby_id,
          cancellationDate: input.cancellation_date ?? null,
          fee: input.fee ?? null,
        }),
      );
      return {
        layby_id: input.layby_id,
        deposit_paid: result.depositPaid.toFixed(4),
        cancellation_fee: result.cancellationFee.toFixed(4),
        refund: result.refund.toFixed(4),
        journal_id: result.journalId,
      };
    }

    if (action !== undefined) {
      throw new ApiError(422, `unknown layby action: ${action}`);
    }

    const create = body as CreateLaybyBody;
    if (!create.lines || create.lines.length === 0) {
      throw new ApiError(422, 'lines are required');
    }

    const lines: LaybyLineInput[] = create.lines.map((line) => ({
      productId: line.product_id,
      variantId: line.variant_id ?? null,
      qty: line.qty,
      unitPrice: line.unit_price,
      taxRateCode: line.tax_rate_code ?? null,
    }));

    const summary = await withWriteErrors(() =>
      createLayby(client, {
        orgId,
        branchId: claims.branchIds[0]!,
        contactId: create.contact_id,
        warehouseId: create.warehouse_id,
        dueDate: create.due_date,
        ...(create.currency !== undefined ? { currency: create.currency } : {}),
        ...(create.tax_code !== undefined ? { taxCode: create.tax_code } : {}),
        postingDate: create.posting_date ?? null,
        deposit: create.deposit,
        lines,
      }),
    );

    return {
      layby_id: summary.laybyId,
      layby_no: summary.laybyNo,
      subtotal: summary.subtotal.toFixed(4),
      tax_total: summary.taxTotal.toFixed(4),
      total: summary.total.toFixed(4),
      deposit_paid: summary.depositPaid.toFixed(4),
      deposit_journal_id: summary.depositJournalId,
    };
  });
}
