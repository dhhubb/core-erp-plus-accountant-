import { NextResponse } from 'next/server';
import { withUserContext, type AuthClaims } from '@/core/auth';
import { ApiError, jsonError, toErrorResponse } from '@/app/api/_lib';
import { isBranchMode } from '@/branch/config';
import { signInWithPin } from '@/branch/session';

/**
 * POST /api/branch/login — cashier PIN sign-in.
 *
 * The branch verifies the PIN locally and mints a branch access token, so sign-in works with the
 * internet off. This is the branch replacement for Supabase Auth (decision 1): no cloud call is
 * made. The org and branch come from the request body (the till knows its branch) or, failing that,
 * the branch's own environment.
 *
 * A wrong PIN returns 200 with `ok: false` and the lockout state, so the till can show "wrong PIN"
 * or "locked" without treating it as a transport error.
 */

interface LoginBody {
  org_id?: string;
  branch_id?: string;
  cashier_id: string;
  pin: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBranchMode()) {
    return jsonError(404, 'branch login is only available in branch mode');
  }

  try {
    const body = (await request.json()) as LoginBody;
    const orgId = body.org_id ?? process.env.BRANCH_ORG_ID;
    const branchId = body.branch_id ?? process.env.BRANCH_ID;

    if (!body.cashier_id) throw new ApiError(422, 'cashier_id is required');
    if (!body.pin) throw new ApiError(422, 'pin is required');
    if (!orgId) throw new ApiError(422, 'org_id is required');
    if (!branchId) throw new ApiError(422, 'branch_id is required');

    // The PIN check runs as a normal authenticated transaction (RLS on), not as the superuser, so a
    // cashier's PIN can only ever be checked against their own branch's row.
    const claims: AuthClaims = {
      sub: body.cashier_id,
      orgId,
      branchIds: [branchId],
      role: 'authenticated',
    };

    const { result, session } = await withUserContext(claims, (client) =>
      signInWithPin(client, { orgId, branchId, cashierId: body.cashier_id, pin: body.pin }),
    );

    return NextResponse.json({
      ok: result.ok,
      locked: result.locked,
      failed_attempts: result.failedAttempts,
      locked_until: result.lockedUntil,
      is_manager: result.isManager,
      token: session?.token ?? null,
      expires_at: session?.expiresAt ?? null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
