import { parseCursor, parseLimit, withAuth } from '../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../_shared';
import { createCustomerGroup, listCustomerGroups } from '@/verticals/admin';

interface CustomerGroupBody {
  org_id?: string;
  name?: string;
  price_list_id?: string | null;
}

/** GET /api/admin/customer-groups — keyset page of groups (created_at, id) with member counts. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listCustomerGroups(client, {
      orgId,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      customer_groups: page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        price_list_id: row.priceListId,
        price_list_name: row.priceListName,
        member_count: row.memberCount,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

/** POST /api/admin/customer-groups — create a group, optionally mapped to a price list. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as CustomerGroupBody;
    assertSameOrg(claims, body.org_id);
    const id = await withWriteErrors(() =>
      createCustomerGroup(client, {
        orgId,
        name: body.name ?? '',
        priceListId: body.price_list_id ?? null,
      }),
    );
    return { id };
  });
}
