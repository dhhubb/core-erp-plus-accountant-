import { withAuth } from '../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../_shared';
import { categoryTree, createCategory } from '@/verticals/admin';

interface CategoryBody {
  org_id?: string;
  name?: string;
  slug?: string;
  parent_id?: string | null;
}

/** GET /api/admin/categories — the org's category tree, depth-first ordered. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const nodes = await categoryTree(client, orgId);
    return { categories: nodes };
  });
}

/** POST /api/admin/categories — create a category, optionally nested under a parent. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CategoryBody;
    assertSameOrg(claims, body.org_id);
    const id = await withWriteErrors(() =>
      createCategory(client, {
        orgId,
        name: body.name ?? '',
        slug: body.slug ?? '',
        parentId: body.parent_id ?? null,
      }),
    );
    return { id };
  });
}
