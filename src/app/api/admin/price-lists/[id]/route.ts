import { ApiError, withAuth } from '../../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../../_shared';
import { deletePriceList, isPriceListCurrency, updatePriceList } from '@/verticals/admin';

interface PriceListBody {
  org_id?: string;
  name?: string;
  currency?: string;
  is_active?: boolean;
}

/** PATCH /api/admin/price-lists/:id — rename, change currency, or activate/deactivate. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as PriceListBody;
    assertSameOrg(claims, body.org_id);
    const currency = body.currency ?? 'USD';
    if (!isPriceListCurrency(currency)) {
      throw new ApiError(422, 'currency must be one of USD, ZAR, ZWG');
    }
    await withWriteErrors(() =>
      updatePriceList(client, {
        orgId,
        id: params.id,
        name: body.name ?? '',
        currency,
        isActive: body.is_active ?? true,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/price-lists/:id — deletes the list and its items (cascade). */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deletePriceList(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
