import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg } from '../_shared';
import { parseLimit, ApiError } from '../../_lib';
import { generalLedger } from '@/accounting/reports';

/**
 * GET /api/accounting/general-ledger — the ledger for one account over a period, keyset on
 * (posting_date, created_at, id). The account must be one the caller can see.
 */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);
    const accountId = searchParams.get('account_id');
    if (!accountId) throw new ApiError(422, 'account_id is required');
    const limit = parseLimit(searchParams);

    const afterDate = searchParams.get('after_date');
    const afterCreatedAt = searchParams.get('after_created_at');
    const afterId = searchParams.get('after_id');
    const cursor =
      afterDate && afterCreatedAt && afterId ? { afterDate, afterCreatedAt, afterId } : null;

    const page = await generalLedger(client, {
      orgId,
      branchId,
      accountId,
      period,
      limit,
      cursor,
    });

    return {
      json: {
        account_id: page.accountId,
        period,
        branch_id: branchId,
        opening_balance: page.openingBalance.toFixed(4),
        closing_balance: page.closingBalance.toFixed(4),
        rows: page.rows.map((row) => ({
          line_id: row.lineId,
          posting_date: row.postingDate,
          created_at: row.createdAt,
          journal_id: row.journalId,
          journal_created_at: row.journalCreatedAt,
          source_type: row.sourceType,
          journal_memo: row.journalMemo,
          description: row.description,
          debit: row.debit.toFixed(4),
          credit: row.credit.toFixed(4),
          running_balance: row.runningBalance.toFixed(4),
        })),
        next_cursor: page.nextCursor
          ? {
              after_date: page.nextCursor.afterDate,
              after_created_at: page.nextCursor.afterCreatedAt,
              after_id: page.nextCursor.afterId,
            }
          : null,
      },
    };
  });
}
