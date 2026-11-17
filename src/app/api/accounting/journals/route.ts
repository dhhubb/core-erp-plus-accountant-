import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg } from '../_shared';
import { parseLimit, parseCursor } from '../../_lib';
import { journalList } from '@/accounting/reports';

/**
 * GET /api/accounting/journals — a keyset page of journals in a period, optionally filtered by
 * `source_type`. Keyset on (created_at, id), never OFFSET.
 */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);
    const sourceType = searchParams.get('source_type');
    const limit = parseLimit(searchParams);
    const cursor = parseCursor(searchParams);

    const page = await journalList(client, {
      orgId,
      branchId,
      period,
      sourceType,
      limit,
      cursor,
    });

    return {
      json: {
        period,
        branch_id: branchId,
        rows: page.rows.map((row) => ({
          journal_id: row.journalId,
          posting_date: row.postingDate,
          source_type: row.sourceType,
          source_id: row.sourceId,
          memo: row.memo,
          currency: row.currency,
          reversal_of: row.reversalOf,
          line_count: row.lineCount,
          total_debit: row.totalDebit.toFixed(4),
          created_at: row.createdAt,
        })),
        next_cursor: page.nextCursor
          ? { after_created_at: page.nextCursor.createdAt, after_id: page.nextCursor.id }
          : null,
      },
    };
  });
}
