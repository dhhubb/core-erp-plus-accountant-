import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { trialBalance } from '@/accounting/reports';
import { trialBalanceCsv } from '@/accounting/export';

/**
 * GET /api/accounting/trial-balance — the six-column trial balance for a period.
 *
 * `include_zero=1` keeps accounts with no movement. `format=csv` downloads it.
 */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);
    const includeZero = searchParams.get('include_zero') === '1';

    const rows = await trialBalance(client, { orgId, branchId, period, includeZero });

    if (wantsCsv(searchParams)) {
      return {
        csv: trialBalanceCsv(rows),
        filename: `trial-balance-${period.from}-to-${period.to}.csv`,
      };
    }

    return {
      json: {
        period,
        branch_id: branchId,
        rows: rows.map((row) => ({
          code: row.code,
          name: row.name,
          account_type: row.accountType,
          section: row.section,
          opening: row.opening.toFixed(4),
          debit: row.debit.toFixed(4),
          credit: row.credit.toFixed(4),
          closing: row.closing.toFixed(4),
        })),
      },
    };
  });
}
