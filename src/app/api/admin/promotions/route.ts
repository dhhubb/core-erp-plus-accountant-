import { ApiError, parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import type { PromotionInput } from '@/verticals/retail/pricing';
import {
  createAdminPromotion,
  isPromotionType,
  listPromotions,
  reorderPromotions,
  type PromotionType,
} from '@/verticals/admin';

interface PromotionBody {
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

interface ReorderBody {
  action: 'reorder';
  org_id?: string;
  ordered_ids?: string[];
}

function parseType(value: string | undefined): PromotionType {
  if (value === undefined || !isPromotionType(value)) {
    throw new ApiError(422, 'type must be one of bogo, percent, fixed');
  }
  return value;
}

/**
 * GET /api/admin/promotions — keyset page (created_at, id). Filters: is_active, type.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const activeRaw = url.searchParams.get('is_active');
    const typeRaw = url.searchParams.get('type');
    const page = await listPromotions(client, {
      orgId,
      isActive: activeRaw === null ? null : activeRaw === 'true',
      type: typeRaw === null ? null : parseType(typeRaw),
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      promotions: page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        valid_from: row.validFrom,
        valid_to: row.validTo,
        is_active: row.isActive,
        priority: row.priority,
        stackable: row.stackable,
        conditions: row.conditions,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/**
 * POST /api/admin/promotions — create a promotion, or reorder by priority (action=reorder).
 * Every write invalidates the promos:{org_id} cache via the R2 module.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as PromotionBody | ReorderBody;
    assertSameOrg(claims, body.org_id);

    if ((body as ReorderBody).action === 'reorder') {
      const input = body as ReorderBody;
      if (!Array.isArray(input.ordered_ids) || input.ordered_ids.length === 0) {
        throw new ApiError(422, 'ordered_ids must be a non-empty array');
      }
      const changed = await withWriteErrors(() =>
        reorderPromotions(client, orgId, input.ordered_ids!),
      );
      return { changed };
    }

    const create = body as PromotionBody;
    if (!create.valid_from || !create.valid_to) {
      throw new ApiError(422, 'valid_from and valid_to are required');
    }
    const input: PromotionInput = {
      name: create.name ?? '',
      type: parseType(create.type),
      validFrom: new Date(create.valid_from),
      validTo: new Date(create.valid_to),
      ...(create.priority !== undefined ? { priority: create.priority } : {}),
      ...(create.stackable !== undefined ? { stackable: create.stackable } : {}),
      ...(create.is_active !== undefined ? { isActive: create.is_active } : {}),
      ...(create.conditions !== undefined ? { conditions: create.conditions } : {}),
    };
    const id = await withWriteErrors(() => createAdminPromotion(client, orgId, input));
    return { id };
  });
}
