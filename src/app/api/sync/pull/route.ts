import { ApiError, withAuth } from '@/app/api/_lib';

/**
 * POST /api/sync/pull — the cloud side of the branch pull.
 *
 * Returns the master-data changes after the branch's cursor, in change_seq order. The branch
 * applies them to its local mirror and stores the highest change_seq as its new cursor. change_seq
 * is per org and monotonic, so "after the cursor" is exact and gap-free.
 */

const MAX_PULL_BATCH = 500;

interface PullBody {
  org_id?: string;
  branch_id?: string;
  since_seq?: string | number | null;
  limit?: number;
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as PullBody;

    const orgId = claims.orgId;
    const branchId = body.branch_id ?? claims.branchIds[0] ?? null;
    if (!orgId) throw new ApiError(401, 'unauthorized');
    if (!branchId) throw new ApiError(422, 'branch_id is required');
    if (body.org_id && body.org_id !== orgId) {
      throw new ApiError(403, 'the token does not scope this org');
    }
    if (!claims.branchIds.includes(branchId)) {
      throw new ApiError(403, 'the token does not scope this branch');
    }

    const sinceSeq = body.since_seq ?? '0';
    const limit = Math.min(Math.max(body.limit ?? MAX_PULL_BATCH, 1), MAX_PULL_BATCH);

    const result = await client.query<{ app: Array<Record<string, unknown>> }>(
      'select app.sync_pull_batch($1, $2, $3, $4) as app',
      [orgId, branchId, sinceSeq, limit],
    );

    const changes = result.rows[0]!.app ?? [];
    const cursor = changes.length > 0 ? String(changes[changes.length - 1]!.change_seq) : null;

    return { changes, cursor };
  });
}
