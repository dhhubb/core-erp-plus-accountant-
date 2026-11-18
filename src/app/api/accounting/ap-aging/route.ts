import { withAccountingAuth, parseAsOf, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { apAging } from '@/accounting/reports';
import { agingCsv } from '@/accounting/export';

/** GET /api/accounting/ap-aging — open supplier bills aged by supplier as of a date. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const asOf = parseAsOf(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await apAging(client, { orgId, branchId, asOf });

    if (wantsCsv(searchParams)) {
      return { csv: agingCsv(report), filename: `ap-aging-${asOf}.csv` };
    }

    const row = (item: typeof report.totals) => ({
      contact_id: item.contactId,
      contact_name: item.contactName,
      current: item.current.toFixed(4),
      days_1_30: item.days1To30.toFixed(4),
      days_31_60: item.days31To60.toFixed(4),
      days_61_90: item.days61To90.toFixed(4),
      over_90: item.over90.toFixed(4),
      total: item.total.toFixed(4),
    });

    return {
      json: {
        as_of: asOf,
        branch_id: branchId,
        rows: report.rows.map(row),
        totals: row(report.totals),
        control_account: report.controlAccount.toFixed(4),
        reconciles: report.reconciles,
      },
    };
  });
}
