import { ApiError, parseLimit, withAuth } from '@/app/api/_lib';
import { listImportRows } from '@/verticals/import/jobs';

/**
 * GET /api/import/jobs/:id/rows — the staged rows and their per-row errors, ordered by row number
 * and paged by row number (never OFFSET). This is what the wizard lists and edits.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const afterRaw = url.searchParams.get('after_row_no');
    const afterRowNo = afterRaw === null ? 0 : Number.parseInt(afterRaw, 10);
    if (!Number.isFinite(afterRowNo) || afterRowNo < 0) {
      throw new ApiError(422, 'after_row_no must be a non-negative integer');
    }

    const page = await listImportRows(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: context.params.id,
      limit,
      afterRowNo,
    });

    return { job_id: context.params.id, rows: page.rows, next_after_row_no: page.next_after_row_no };
  });
}
