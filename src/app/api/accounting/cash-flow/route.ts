import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { cashFlow } from '@/accounting/reports';
import { cashFlowCsv } from '@/accounting/export';

/** GET /api/accounting/cash-flow — the indirect-method statement of cash flows for a period. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await cashFlow(client, { orgId, branchId, period });

    if (wantsCsv(searchParams)) {
      return {
        csv: cashFlowCsv(report),
        filename: `cash-flow-${period.from}-to-${period.to}.csv`,
      };
    }

    const section = (activity: string, amount: typeof report.operating) => ({
      amount: amount.toFixed(4),
      lines: report.rows
        .filter((row) => row.activity === activity)
        .map((row) => ({
          code: row.code,
          name: row.name,
          amount: row.amount.toFixed(4),
        })),
    });

    return {
      json: {
        period,
        branch_id: branchId,
        opening_cash: report.openingCash.toFixed(4),
        closing_cash: report.closingCash.toFixed(4),
        net_change: report.netChange.toFixed(4),
        operating: section('operating', report.operating),
        investing: section('investing', report.investing),
        financing: section('financing', report.financing),
        reconciles: report.reconciles,
      },
    };
  });
}
