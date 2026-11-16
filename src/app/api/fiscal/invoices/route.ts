import { parseCursor, parseLimit, withAuth } from '@/app/api/_lib';
import { fiscalSummary, listFiscalQueue } from '@/fiscal';

/**
 * GET /api/fiscal/invoices — the branch's fiscal queue for the admin page (/settings/fiscal).
 * Keyset on (created_at, id), default 50, maximum 100, never OFFSET. Includes the counts by status.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);
    const orgId = claims.orgId!;
    const branchId = claims.branchIds[0]!;

    const page = await listFiscalQueue(client, { orgId, branchId, limit, cursor });
    const summary = await fiscalSummary(client, { orgId, branchId });

    return {
      summary,
      invoices: page.rows.map((row) => ({
        id: row.id,
        invoice_id: row.invoiceId,
        invoice_no: row.invoiceNo,
        status: row.status,
        attempts: row.attempts,
        last_error: row.lastError,
        fdms_response: row.fdmsResponse,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
