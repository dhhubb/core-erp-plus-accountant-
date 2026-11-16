import { ApiError, withAuth } from '@/app/api/_lib';
import { getImportMapping, saveImportMapping } from '@/verticals/import/jobs';
import { IMPORT_KINDS, type ColumnMapping, type ImportKind } from '@/verticals/import/mapping';

/**
 * GET /api/import/mappings?kind= — the shop's saved column mapping, or an empty object.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const kind = new URL(request.url).searchParams.get('kind') as ImportKind | null;
    if (!kind || !IMPORT_KINDS.includes(kind)) {
      throw new ApiError(422, 'kind must be products, customers or opening_stock');
    }
    const mapping = await getImportMapping(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      kind,
    });
    return { kind, mapping };
  });
}

/**
 * PUT /api/import/mappings — save the shop's column mapping so the next run reuses it.
 */
export async function PUT(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as { kind: ImportKind; mapping: ColumnMapping };
    if (!IMPORT_KINDS.includes(body.kind)) {
      throw new ApiError(422, 'kind must be products, customers or opening_stock');
    }
    const saved = await saveImportMapping(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      kind: body.kind,
      mapping: body.mapping ?? {},
    });
    return { kind: body.kind, mapping: saved };
  });
}
