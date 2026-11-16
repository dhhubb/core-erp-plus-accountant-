import { ApiError, withAuth } from '@/app/api/_lib';
import { createImportJob, stageImportRows } from '@/verticals/import/jobs';
import { IMPORT_KINDS, validateMapping, type ColumnMapping, type ImportKind } from '@/verticals/import/mapping';

interface CreateJobBody {
  kind: ImportKind;
  source_name?: string | null;
  mapping: ColumnMapping;
  /** The first chunk of already-parsed rows, mapped to our fields in the browser. */
  rows?: Array<Record<string, string>>;
}

/**
 * POST /api/import/jobs — open a migration job and stage its first chunk.
 * The job, its mapping and the first COPY happen in one transaction, so a failed create leaves
 * nothing behind.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CreateJobBody;

    if (!IMPORT_KINDS.includes(body.kind)) {
      throw new ApiError(422, `unknown import kind: ${body.kind}`);
    }
    const mappingErrors = validateMapping(body.kind, body.mapping ?? {});
    if (mappingErrors.length > 0) {
      throw new ApiError(422, mappingErrors.join('; '));
    }

    const orgId = claims.orgId!;
    const branchId = claims.branchIds[0]!;

    const job = await createImportJob(client, {
      orgId,
      branchId,
      kind: body.kind,
      sourceName: body.source_name ?? null,
      mapping: body.mapping,
    });

    const staged = await stageImportRows(client, {
      orgId,
      branchId,
      jobId: job.jobId,
      kind: body.kind,
      mapping: body.mapping,
      rows: body.rows ?? [],
    });

    return { job_id: job.jobId, kind: job.kind, status: job.status, staged_rows: staged };
  });
}
