import { ApiError, withAuth } from '../../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../../_shared';
import { deleteProduct, isProductUnit, updateProduct, type ProductUnit } from '@/verticals/admin';

interface ProductBody {
  org_id?: string;
  name?: string;
  category_id?: string | null;
  unit?: string;
  is_weighable?: boolean;
  is_active?: boolean;
}

function parseUnit(value: string | undefined): ProductUnit {
  if (value === undefined) return 'each';
  if (!isProductUnit(value)) {
    throw new ApiError(422, 'unit must be one of each, kg, g, l, ml, pack');
  }
  return value;
}

/** PATCH /api/admin/products/:id — update name, category, unit, weighable and active flags. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as ProductBody;
    assertSameOrg(claims, body.org_id);
    const isWeighable = body.is_weighable ?? false;
    const unit = parseUnit(body.unit);
    if (isWeighable && unit === 'each') {
      throw new ApiError(422, 'a weighable product must use a measure unit (kg, g, l or ml)');
    }
    await withWriteErrors(() =>
      updateProduct(client, {
        orgId,
        id: params.id,
        name: body.name ?? '',
        categoryId: body.category_id ?? null,
        unit,
        isWeighable,
        isActive: body.is_active ?? true,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/products/:id — refuse while the product has stock history. */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deleteProduct(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
