import { ApiError, parseCursor, parseLimit, withAuth } from '../_lib';
import {
  cancelLayby,
  completeLayby,
  createLayby,
  listLaybys,
  type LaybyLineInput,
} from '@/verticals/ops/laybys';

interface CreateLaybyBody {
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
  action: 'complete';
  layby_id: string;
  completion_date?: string | null;
  payment?: string;
}

interface CancelLaybyBody {
  action: 'cancel';
  layby_id: string;
  cancellation_date?: string | null;
  fee?: string | null;
}

/**
 * GET /api/laybys — keyset page on (created_at, id). Optional ?status= filter.
 * POST /api/laybys — create a layby, or complete/cancel one by passing `action`.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listLaybys(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      status: url.searchParams.get('status'),
      limit,
      cursor,
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
        cancellation_fee: layby.cancellationFee.toFixed(4),
        invoice_id: layby.invoiceId,
        created_at: layby.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CreateLaybyBody | CompleteLaybyBody | CancelLaybyBody;
    const action = (body as { action?: string }).action;

    if (action === 'complete') {
      const input = body as CompleteLaybyBody;
      const result = await completeLayby(client, {
        orgId: claims.orgId!,
        laybyId: input.layby_id,
        completionDate: input.completion_date ?? null,
        ...(input.payment !== undefined ? { payment: input.payment } : {}),
      });
      return {
        layby_id: result.laybyId,
        invoice_id: result.invoiceId,
        invoice_no: result.invoiceNo,
        deposit_applied: result.depositApplied.toFixed(4),
      };
    }

    if (action === 'cancel') {
      const input = body as CancelLaybyBody;
      const result = await cancelLayby(client, {
        orgId: claims.orgId!,
        laybyId: input.layby_id,
        cancellationDate: input.cancellation_date ?? null,
        fee: input.fee ?? null,
      });
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

    const summary = await createLayby(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      contactId: create.contact_id,
      warehouseId: create.warehouse_id,
      dueDate: create.due_date,
      ...(create.currency !== undefined ? { currency: create.currency } : {}),
      ...(create.tax_code !== undefined ? { taxCode: create.tax_code } : {}),
      postingDate: create.posting_date ?? null,
      deposit: create.deposit,
      lines,
    });

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
