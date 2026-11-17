import { withAccountingAuth, requireOrg } from '../../_shared';
import { ApiError } from '../../../_lib';
import { journalDetail } from '@/accounting/reports';

/**
 * GET /api/accounting/journals/{id}?created_at=... — one journal and its lines.
 *
 * A journal is read by its primary key (id, created_at), because the partition key is part of the
 * key. `created_at` is required.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const journalCreatedAt = searchParams.get('created_at');
    if (!journalCreatedAt) throw new ApiError(422, 'created_at is required');

    const detail = await journalDetail(client, {
      orgId,
      journalId: context.params.id,
      journalCreatedAt,
    });
    if (!detail.journal) throw new ApiError(404, 'journal not found');

    return {
      json: {
        journal: {
          journal_id: detail.journal.journalId,
          posting_date: detail.journal.postingDate,
          source_type: detail.journal.sourceType,
          source_id: detail.journal.sourceId,
          memo: detail.journal.memo,
          currency: detail.journal.currency,
          reversal_of: detail.journal.reversalOf,
          total_debit: detail.journal.totalDebit.toFixed(4),
          created_at: detail.journal.createdAt,
        },
        lines: detail.lines.map((line) => ({
          line_no: line.lineNo,
          account_id: line.accountId,
          account_code: line.accountCode,
          account_name: line.accountName,
          description: line.description,
          debit: line.debit.toFixed(4),
          credit: line.credit.toFixed(4),
          currency: line.currency,
          exchange_rate: line.exchangeRate.toString(),
          tax_rate_id: line.taxRateId,
        })),
      },
    };
  });
}
