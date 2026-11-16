import { NextResponse } from 'next/server';
import { claimsFromAuthorizationHeader, withUserContext, type AuthClaims } from '@/core/auth';
import { isBranchMode } from '@/branch/config';
import { recentConflicts, syncStatus } from '@/sync/status';

/**
 * GET /api/branch/sync/status — the branch's sync status page's data.
 *
 * Reads from the branch's own database, so it answers with the cloud offline: the outbox depth, the
 * last push and pull, the cloud observation, and any conflicts the cloud really rejected. Newest
 * conflicts come with it (keyset, limit 50) so the page needs one request.
 */
export async function GET(request: Request): Promise<NextResponse> {
  let claims: AuthClaims | null = null;
  try {
    claims = claimsFromAuthorizationHeader(request.headers.get('authorization'));
  } catch {
    claims = null;
  }

  if (!claims?.orgId || claims.branchIds.length === 0) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const orgId = claims.orgId;
  const branchId = claims.branchIds[0]!;

  try {
    const payload = await withUserContext(claims, async (client) => {
      const status = await syncStatus(client, orgId, branchId);
      const conflicts = await recentConflicts(client, orgId, branchId, 50);
      return { mode: isBranchMode() ? 'branch' : 'cloud', ...status, recent_conflicts: conflicts };
    });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
