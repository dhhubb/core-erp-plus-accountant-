import { withAuth, ApiError } from '@/app/api/_lib';
import { resolveCart } from '@/verticals/retail/pricing';

interface PriceBody {
  group_id?: string | null;
  at_time?: string;
  items?: Array<{ variant_id: string; qty: string | number }>;
}

/**
 * POST /api/pos/price — resolve a whole cart's prices in one round trip.
 * Precedence (price list, then promotions) is enforced in SQL. Thin handler: parse, call once.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as PriceBody;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new ApiError(422, 'items must be a non-empty array');
    }

    const atTime = body.at_time ? new Date(body.at_time) : new Date();
    if (Number.isNaN(atTime.getTime())) {
      throw new ApiError(422, 'at_time is not a valid timestamp');
    }

    const lines = await resolveCart({
      client,
      orgId: claims.orgId!,
      groupId: body.group_id ?? null,
      atTime,
      items: body.items.map((item) => ({ variantId: item.variant_id, qty: item.qty })),
    });

    return {
      at_time: atTime.toISOString(),
      currency: lines[0]?.currency ?? 'USD',
      lines: lines.map((line) => ({
        variant_id: line.variantId,
        qty: line.qty.toFixed(4),
        list_price: line.listPrice.toFixed(4),
        unit_price: line.unitPrice.toFixed(4),
        discount: line.discount.toFixed(4),
        line_total: line.lineTotal.toFixed(4),
        source_price_list_id: line.source.priceListId,
        source_promotion_id: line.source.promotionId,
      })),
    };
  });
}
