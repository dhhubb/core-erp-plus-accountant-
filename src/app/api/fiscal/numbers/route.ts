import { withAuth } from '@/app/api/_lib';
import {
  cloudBlockFetcher,
  ensureNextBlock,
  numberBlockStatus,
  storeNumberBlock,
  type IssuedBlock,
} from '@/fiscal';
import { cloudUrl } from '@/branch/config';
import { branchSyncToken } from '@/sync/config';

interface RequestBody {
  /** The block the cloud issued, when the branch fetched it out of band. */
  block?: IssuedBlock;
  series_code?: string;
}

/**
 * GET /api/fiscal/numbers — the branch's current number-block state (remaining, bounds, exhausted).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const seriesCode = url.searchParams.get('series_code') ?? 'INVOICE';
    const status = await numberBlockStatus(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      seriesCode,
    });
    return { status };
  });
}

/**
 * POST /api/fiscal/numbers — request the next block before the current one runs out.
 *
 * With a `block` in the body (the branch already fetched it) the block is stored directly. Without
 * one, the branch fetches the next block from the cloud when the current block is low. When the
 * cloud is unreachable the request succeeds and reports the current status: the branch keeps selling
 * from its current block until it really runs out.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const orgId = claims.orgId!;
    const branchId = claims.branchIds[0]!;
    const seriesCode = body.series_code ?? 'INVOICE';

    if (body.block) {
      const status = await storeNumberBlock(client, {
        orgId,
        branchId,
        block: body.block,
        seriesCode,
      });
      return { status, requested: true };
    }

    const url = cloudUrl();
    const token = branchSyncToken();
    if (!url || !token) {
      const status = await numberBlockStatus(client, { orgId, branchId, seriesCode });
      return { status, requested: false };
    }

    const result = await ensureNextBlock(
      client,
      cloudBlockFetcher({ cloudUrl: url, token, branchId, seriesCode }),
      { orgId, branchId, seriesCode },
    );
    return { status: result.status, requested: result.requested };
  });
}
