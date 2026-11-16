import type { PromotionInput } from '@/verticals/retail/pricing';
import { ApiError, withAuth } from '../../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../../_shared';
import {
  deactivateAdminPromotion,
  isPromotionType,
  updateAdminPromotion,
  type PromotionType,
} from '@/verticals/admin';

interface PromotionPatchBody {
  org_id?: string;
  name?: string;
  type?: string;
  valid_from?: string;
  valid_to?: string;
  priority?: number;
  stackable?: boolean;
  is_active?: boolean;
  conditions?: Record<string, unknown>;
}

/**
 * PATCH /api/admin/promotions/:id — edit a promotion. The write invalidates the promos:{org_id}
 * cache. Sending `is_active: false` deactivates it.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as PromotionPatchBody;
    assertSameOrg(claims, body.org_id);

    if (body.type !== undefined && !isPromotionType(body.type)) {
      throw new ApiError(422, 'type must be one of bogo, percent, fixed');
    }

    const patch: Partial<PromotionInput> = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type as PromotionType } : {}),
      ...(body.valid_from !== undefined ? { validFrom: new Date(body.valid_from) } : {}),
      ...(body.valid_to !== undefined ? { validTo: new Date(body.valid_to) } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.stackable !== undefined ? { stackable: body.stackable } : {}),
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
    };
    await withWriteErrors(() => updateAdminPromotion(client, orgId, params.id, patch));
    return { id: params.id };
  });
}

/** DELETE /api/admin/promotions/:id — deactivate (promotions are never hard-deleted). */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deactivateAdminPromotion(client, orgId, params.id));
    return { id: params.id, deactivated: true };
  });
}
