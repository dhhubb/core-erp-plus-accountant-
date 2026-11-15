import { parseLimit, withAuth } from '@/app/api/_lib';
import { dueFiscalJobs } from '@/fiscal';

/**
 * GET /api/fiscal/jobs — the branch's queued, due fiscal jobs, oldest first. Read-only: the queue
 * is append-only, so this never claims or mutates a job. Keyset by (created_at, id) in SQL.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);

    const jobs = await dueFiscalJobs(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      limit,
    });

    return {
      jobs: jobs.map((job) => ({
        job_id: job.jobId,
        sale_id: job.saleId,
        invoice_id: job.invoiceId,
        attempts: job.attempts,
        next_attempt_at: job.nextAttemptAt,
      })),
    };
  });
}
