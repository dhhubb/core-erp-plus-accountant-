import { withAccountingAuth, parseAsOf, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { balanceSheet } from '@/accounting/reports';
import { balanceSheetCsv } from '@/accounting/export';

/** GET /api/accounting/balance-sheet — assets, liabilities and equity as of a date. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const asOf = parseAsOf(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await balanceSheet(client, { orgId, branchId, asOf });

    if (wantsCsv(searchParams)) {
      return { csv: balanceSheetCsv(report), filename: `balance-sheet-${asOf}.csv` };
    }

    const lines = (rows: typeof report.equity) =>
      rows.map((line) => ({
        code: line.code,
        name: line.name,
        amount: line.amount.toFixed(4),
      }));

    return {
      json: {
        as_of: asOf,
        branch_id: branchId,
        assets: {
          current: lines(report.assets.current),
          non_current: lines(report.assets.nonCurrent),
          total: report.totalAssets.toFixed(4),
        },
        liabilities: {
          current: lines(report.liabilities.current),
          non_current: lines(report.liabilities.nonCurrent),
          total: report.totalLiabilities.toFixed(4),
        },
        equity: {
          accounts: lines(report.equity),
          total: report.totalEquity.toFixed(4),
        },
        difference: report.difference.toFixed(4),
        balanced: report.balanced,
      },
    };
  });
}
