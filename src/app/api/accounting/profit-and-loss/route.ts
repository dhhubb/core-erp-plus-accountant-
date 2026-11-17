import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { profitAndLoss } from '@/accounting/reports';
import { profitAndLossCsv } from '@/accounting/export';

/** GET /api/accounting/profit-and-loss — revenue, cost of sales, gross and net profit. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await profitAndLoss(client, { orgId, branchId, period });

    if (wantsCsv(searchParams)) {
      return {
        csv: profitAndLossCsv(report),
        filename: `profit-and-loss-${period.from}-to-${period.to}.csv`,
      };
    }

    return {
      json: {
        period,
        branch_id: branchId,
        revenue: report.revenue.map((line) => ({
          code: line.code,
          name: line.name,
          amount: line.amount.toFixed(4),
        })),
        cost_of_sales: report.costOfSales.map((line) => ({
          code: line.code,
          name: line.name,
          amount: line.amount.toFixed(4),
        })),
        operating_expenses: report.operatingExpenses.map((line) => ({
          code: line.code,
          name: line.name,
          amount: line.amount.toFixed(4),
        })),
        total_revenue: report.totalRevenue.toFixed(4),
        total_cost_of_sales: report.totalCostOfSales.toFixed(4),
        gross_profit: report.grossProfit.toFixed(4),
        total_operating_expenses: report.totalOperatingExpenses.toFixed(4),
        net_profit: report.netProfit.toFixed(4),
      },
    };
  });
}
