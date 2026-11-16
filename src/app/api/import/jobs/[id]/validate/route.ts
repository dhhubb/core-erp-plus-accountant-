import { withAuth } from '@/app/api/_lib';
import { validateImportJob } from '@/verticals/import/jobs';

/**
 * POST /api/import/jobs/:id/validate — validate every staged row in SQL.
 * Returns the counts; per-row errors are read from GET /api/import/jobs/:id/rows.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const validation = await validateImportJob(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: context.params.id,
    });
    return {
      job_id: validation.jobId,
      status: validation.status,
      total_rows: validation.totalRows,
      invalid_rows: validation.invalidRows,
      skipped_rows: validation.skippedRows,
    };
  });
}
