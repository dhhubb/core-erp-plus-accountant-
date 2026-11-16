import { withAuth } from '../../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../../_shared';
import { deleteCustomerGroup, updateCustomerGroup } from '@/verticals/admin';

interface CustomerGroupBody {
  org_id?: string;
  name?: string;
  price_list_id?: string | null;
}

/** PATCH /api/admin/customer-groups/:id — rename or re-map the group's price list. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CustomerGroupBody;
    assertSameOrg(claims, body.org_id);
    await withWriteErrors(() =>
      updateCustomerGroup(client, {
        orgId,
        id: params.id,
        name: body.name ?? '',
        priceListId: body.price_list_id ?? null,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/customer-groups/:id — members fall back to the retail list (group_id set null). */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deleteCustomerGroup(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
