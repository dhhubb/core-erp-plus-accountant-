import { withAuth } from '@/app/api/_lib';
import { drainFiscalJobsOn, unreachableTransport } from '@/fiscal';

/**
 * POST /api/fiscal/drain — run one delivery pass over the branch's due jobs.
 *
 * This is the worker entry point. It is deliberately separate from the sale path: a sale only
 * queues a job (a trigger on pos_sales does that), and delivery happens here, later, under
 * backoff. This run ships the unreachable transport, which performs no network call and records
 * an 'unreachable' attempt for each due job; a real device transport is a future run.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const result = await drainFiscalJobsOn(client, unreachableTransport(), {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
    });
    return { examined: result.examined, sent: result.sent, retried: result.retried };
  });
}
