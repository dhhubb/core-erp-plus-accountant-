import { ApiError, parseCursor, parseLimit, withAuth } from '../../../../_lib';
import { requireOrg, withWriteErrors } from '../../../_shared';
import { assignGroupMembers, listGroupMembers } from '@/verticals/admin';

/** GET /api/admin/customer-groups/:id/members — keyset page of the group's contacts. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const url = new URL(request.url);
    const page = await listGroupMembers(client, {
      orgId,
      groupId: params.id,
      limit: parseLimit(url.searchParams),
      cursor: parseCursor(url.searchParams),
    });
    return {
      members: page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}

interface AssignBody {
  org_id?: string;
  contact_ids?: string[];
  assign?: boolean;
}

/** POST /api/admin/customer-groups/:id/members — assign (or unassign) contacts to the group. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as AssignBody;
    if (!Array.isArray(body.contact_ids) || body.contact_ids.length === 0) {
      throw new ApiError(422, 'contact_ids must be a non-empty array');
    }
    const changed = await withWriteErrors(() =>
      assignGroupMembers(client, {
        orgId,
        groupId: params.id,
        contactIds: body.contact_ids!,
        assign: body.assign ?? true,
      }),
    );
    return { group_id: params.id, changed };
  });
}
