import { ApiError, withAuth } from '../../_lib';
import { requireOrg, withWriteErrors } from '../_shared';
import { pricePreview } from '@/verticals/admin';

interface PreviewBody {
  org_id?: string;
  variant_id?: string;
  group_id?: string | null;
  at_time?: string;
  role?: string | null;
  qty?: string;
  manual_discount?: string | null;
  reason?: string | null;
}

/**
 * POST /api/admin/pricing-preview — the live price preview.
 *
 * Calls app.get_price (so the console and the till cannot drift) and returns the precedence
 * breakdown: 1. price list (group, else retail) 2. promotion by priority 3. manual discount with
 * the role's limit. A manual discount above the role's limit, or one with no reason, is a 422.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as PreviewBody;
    if (!body.variant_id) throw new ApiError(422, 'variant_id is required');

    const preview = await withWriteErrors(() =>
      pricePreview(client, {
        orgId,
        variantId: body.variant_id!,
        groupId: body.group_id ?? null,
        atTime: body.at_time ? new Date(body.at_time) : new Date(),
        role: body.role ?? null,
        qty: body.qty ?? 1,
        manualDiscount: body.manual_discount ?? null,
        reason: body.reason ?? null,
      }),
    );

    if (preview === null) throw new ApiError(404, 'variant not found');

    return {
      variant_id: preview.variantId,
      currency: preview.currency,
      list_price: preview.listPrice.toFixed(4),
      unit_price: preview.unitPrice.toFixed(4),
      discount: preview.discount.toFixed(4),
      source_price_list_id: preview.sourcePriceListId,
      source_price_list_name: preview.sourcePriceListName,
      source_price_list_kind: preview.sourcePriceListKind,
      source_promotion_id: preview.sourcePromotionId,
      source_promotion_name: preview.sourcePromotionName,
      manual_discount: preview.manualDiscount.toFixed(4),
      manual_max_amount: preview.manualMaxAmount.toFixed(4),
      effective_price: preview.effectivePrice.toFixed(4),
      steps: preview.steps.map((step) => ({
        step: step.step,
        name: step.name,
        detail: step.detail,
        amount: step.amount.toFixed(4),
        source_id: step.sourceId,
        limit: step.limit === null ? null : step.limit.toFixed(4),
      })),
    };
  });
}
