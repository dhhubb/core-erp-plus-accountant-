import { ApiError, withAuth } from '@/app/api/_lib';
import { updateImportRow } from '@/verticals/import/jobs';

interface UpdateRowBody {
  data: Record<string, string>;
}

/**
 * PATCH /api/import/rows/:id — fix one staged row's data and revalidate it.
 * The wizard revalidates the job afterwards so the commit gate reflects the fix.
 */
export async function PATCH(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as UpdateRowBody;
    if (!body.data || typeof body.data !== 'object') {
      throw new ApiError(422, 'data must be an object');
    }

    const row = await updateImportRow(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      rowId: context.params.id,
      data: body.data,
    });

    return {
      row_id: row.row_id,
      row_no: row.row_no,
      status: row.status,
      data: row.data,
      errors: row.errors,
    };
  });
}
