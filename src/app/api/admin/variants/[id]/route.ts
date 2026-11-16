import { withAuth } from '../../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../../_shared';
import { deleteVariant, updateVariant } from '@/verticals/admin';

interface VariantBody {
  org_id?: string;
  name?: string | null;
  size?: string | null;
  color?: string | null;
  barcode?: string | null;
  cost?: string | number | null;
}

/** PATCH /api/admin/variants/:id — update size, colour, barcode and cost. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as VariantBody;
    assertSameOrg(claims, body.org_id);
    await withWriteErrors(() =>
      updateVariant(client, {
        orgId,
        id: params.id,
        name: body.name ?? null,
        size: body.size ?? null,
        color: body.color ?? null,
        barcode: body.barcode ?? null,
        cost: body.cost ?? null,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/variants/:id — refuse while the variant has stock history or batches. */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deleteVariant(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
