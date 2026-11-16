import { withAuth } from '../../../_lib';
import { requireOrg, assertSameOrg, withWriteErrors } from '../../_shared';
import { deleteBatch, updateBatch } from '@/verticals/admin';

interface BatchBody {
  org_id?: string;
  batch_no?: string;
  expiry_date?: string | null;
}

/** PATCH /api/admin/batches/:id — update a batch number or expiry date. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as BatchBody;
    assertSameOrg(claims, body.org_id);
    await withWriteErrors(() =>
      updateBatch(client, {
        orgId,
        id: params.id,
        batchNo: body.batch_no ?? '',
        expiryDate: body.expiry_date ?? null,
      }),
    );
    return { id: params.id };
  });
}

/** DELETE /api/admin/batches/:id — remove a batch. */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    await withWriteErrors(() => deleteBatch(client, { orgId, id: params.id }));
    return { id: params.id, deleted: true };
  });
}
