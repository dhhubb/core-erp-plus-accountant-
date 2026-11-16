import { withAuth } from '@/app/api/_lib';
import { commitImportJob } from '@/verticals/import/jobs';

interface CommitBody {
  posting_date?: string | null;
}

/**
 * POST /api/import/jobs/:id/commit — apply the whole job in one transaction.
 * Blocked while any row is invalid; a failure part-way through rolls the whole job back.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json().catch(() => ({}))) as CommitBody;
    const result = await commitImportJob(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: context.params.id,
      postingDate: body.posting_date ?? null,
    });
    return {
      job_id: result.jobId,
      status: result.status,
      kind: result.kind,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      committed_rows: result.committedRows,
      journal_id: result.journalId,
      total_value: result.totalValue.toFixed(4),
    };
  });
}
