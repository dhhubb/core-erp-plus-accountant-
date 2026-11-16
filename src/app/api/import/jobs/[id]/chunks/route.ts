import { ApiError, withAuth } from '@/app/api/_lib';
import { loadImportChunk } from '@/verticals/import/jobs';

interface ChunkBody {
  start_row_no: number;
  rows: Array<Record<string, string>>;
}

/**
 * POST /api/import/jobs/:id/chunks — stage one more chunk of rows with COPY.
 * The browser sends the file in chunks so a 5,000-row file is not one request.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as ChunkBody;
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      throw new ApiError(422, 'rows must be a non-empty array');
    }
    if (!Number.isInteger(body.start_row_no) || body.start_row_no < 1) {
      throw new ApiError(422, 'start_row_no must be a positive integer');
    }

    const staged = await loadImportChunk(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: context.params.id,
      startRowNo: body.start_row_no,
      rows: body.rows,
    });

    return { job_id: context.params.id, staged_rows: staged };
  });
}
