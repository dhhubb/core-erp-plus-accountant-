import { withAuth } from '../../_lib';
import { lastSync } from '@/verticals/reports';
import { resolveBranchId } from '../_shared';

/**
 * GET /api/reports/last-sync — when the branch last synced.
 *
 * The owner console always shows this, so a figure that looks stale is explained: it is the branch's
 * synced data, as of the time shown (ADR-0049).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const branchId = resolveBranchId(url.searchParams, claims);

    const sync = await lastSync(client, { orgId: claims.orgId!, branchId });

    return {
      branch_id: branchId,
      last_cloud_contact_at: sync.lastCloudContactAt,
      last_ingest_at: sync.lastIngestAt,
      last_pushed_seq: sync.lastPushedSeq,
      outbox_size: sync.outboxSize,
    };
  });
}
