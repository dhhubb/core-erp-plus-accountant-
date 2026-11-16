import { withAuth } from '../../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../../_shared';
import { deleteCategory, updateCategory } from '@/verticals/admin';

interface CategoryBody {
  org_id?: string;
  name?: string;
  slug?: string;
  parent_id?: string | null;
}

/** PATCH /api/admin/categories/:id — rename, re-slug, or re-nest (rejects a cycle). */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CategoryBody;
    assertSameOrg(claims, body.org_id);
    await withWriteErrors(() =>
      updateCategory(client, {
        orgId,
        id: params.id,
        name: body.name ?? '',
        slug: body.slug ?? '',
        parentId: body.parent_id ?? null,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/categories/:id — refuse while it has children or products. */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deleteCategory(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
