import { ApiError, withAuth } from '@/app/api/_lib';

/**
 * POST /api/sync/push — the cloud side of the branch push.
 *
 * The branch sends a batch of outbox events, in sequence order. The whole batch runs in ONE
 * transaction under the branch's tenant context, and each event applies in its own subtransaction,
 * so a rejected event does not roll back the rest. An event is applied at most once: the inbox's
 * unique (org_id, event_id) is the dedupe key.
 *
 * The branch's token scopes the push: an event may only be pushed for the org and branch the token
 * names. A body naming another org or branch is rejected.
 */

const MAX_PUSH_BATCH = 500;

interface PushBody {
  org_id?: string;
  branch_id?: string;
  events?: Array<{
    seq: string | number;
    event_id: string;
    event_type: string;
    payload?: Record<string, unknown>;
  }>;
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as PushBody;

    if (!Array.isArray(body.events)) {
      throw new ApiError(422, 'events must be an array');
    }
    if (body.events.length > MAX_PUSH_BATCH) {
      throw new ApiError(422, `a push batch may carry at most ${MAX_PUSH_BATCH} events`);
    }

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

    const result = await client.query<{ app: Record<string, unknown> }>(
      'select app.sync_push_result($1, $2, $3::jsonb) as app',
      [orgId, branchId, JSON.stringify(body.events)],
    );

    return result.rows[0]!.app;
  });
}
