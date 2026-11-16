import { ApiError, withAuth } from '@/app/api/_lib';
import { issueNumberBlock } from '@/fiscal';

interface ClaimBody {
  branch_id?: string;
  series_code?: string;
  size?: number;
}

/**
 * POST /api/branch/numbers/claim — CLOUD side. Reserve the next invoice-number block for a branch.
 *
 * The branch calls this BEFORE its current block runs out. The block is carved from the org's number
 * series under a FOR UPDATE lock, so two branches can never be issued the same number. The branch
 * stores the block it receives and takes its numbers from it while offline.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as ClaimBody;
    // A branch claims for a branch it is a member of; the claim's org comes from the token.
    const branchId = body.branch_id ?? claims.branchIds[0];
    if (!branchId) {
      throw new ApiError(422, 'branch_id is required');
    }
    if (!claims.branchIds.includes(branchId)) {
      throw new ApiError(403, 'not a member of that branch');
    }

    const block = await issueNumberBlock(client, {
      orgId: claims.orgId!,
      branchId,
      ...(body.series_code !== undefined ? { seriesCode: body.series_code } : {}),
      ...(body.size !== undefined ? { size: body.size } : {}),
    });

    return { block };
  });
}
