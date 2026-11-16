import type { PoolClient } from 'pg';
import { NextResponse } from 'next/server';
import { ApiError, jsonError, toErrorResponse } from '@/app/api/_lib';
import { withUserContext, type AuthClaims } from '@/core/auth';
import { isBranchMode } from '@/branch/config';
import { authenticateDevice, createDeviceRegistration, registerDevice } from '@/branch/device';

/**
 * Device registration (decision 12).
 *
 * POST /api/branch/devices with `action`:
 *   create   — an admin mints a one-time code for a till.
 *   register — a till redeems the code once and receives a device token.
 *   verify   — verify a device token.
 *
 * Only hashes are stored; the raw code and the raw token exist only in the responses.
 */

interface DeviceBody {
  action: 'create' | 'register' | 'verify';
  org_id?: string;
  branch_id?: string;
  till_id?: string;
  code?: string;
  token?: string;
  label?: string | null;
  ttl_hours?: number;
}

function scopeFrom(body: DeviceBody, claims: AuthClaims | null): { orgId: string; branchId: string } {
  const orgId = body.org_id ?? claims?.orgId ?? process.env.BRANCH_ORG_ID ?? null;
  const branchId = body.branch_id ?? claims?.branchIds[0] ?? process.env.BRANCH_ID ?? null;
  if (!orgId) throw new ApiError(422, 'org_id is required');
  if (!branchId) throw new ApiError(422, 'branch_id is required');
  return { orgId, branchId };
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isBranchMode()) {
    return jsonError(404, 'device registration is only available in branch mode');
  }
  try {
    const body = (await request.json()) as DeviceBody;
    const { orgId, branchId } = scopeFrom(body, null);

    if (body.action === 'create') {
      if (!body.till_id) throw new ApiError(422, 'till_id is required');
      const code = await withAdminContext(orgId, branchId, (client) =>
        createDeviceRegistration(client, {
          orgId,
          branchId,
          tillId: body.till_id!,
          ...(body.ttl_hours !== undefined ? { ttlHours: body.ttl_hours } : {}),
        }),
      );
      // The raw code is returned exactly once. Only its hash is stored.
      return NextResponse.json({ code });
    }

    if (body.action === 'register') {
      if (!body.code) throw new ApiError(422, 'code is required');
      const token = await withAdminContext(orgId, branchId, (client) =>
        registerDevice(client, {
          orgId,
          branchId,
          code: body.code!,
          label: body.label ?? null,
        }),
      );
      return NextResponse.json({ token });
    }

    if (body.action === 'verify') {
      if (!body.token) throw new ApiError(422, 'token is required');
      const id = await withAdminContext(orgId, branchId, (client) =>
        authenticateDevice(client, { orgId, branchId, token: body.token! }),
      );
      return NextResponse.json({ ok: true, registration_id: id });
    }

    throw new ApiError(422, `unknown action ${body.action}`);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Run a device operation as the branch's own tenant. Device registration happens before a till has
 * a token, so the branch applies its own org/branch context (RLS stays on; this is not a bypass).
 */
async function withAdminContext<T>(
  orgId: string,
  branchId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const claims: AuthClaims = { sub: orgId, orgId, branchIds: [branchId], role: 'service_role' };
  return withUserContext(claims, fn);
}
