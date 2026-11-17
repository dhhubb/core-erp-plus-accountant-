import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { vatReturn } from '@/accounting/reports';
import { vatCsv } from '@/accounting/export';

/** GET /api/accounting/vat-return — output VAT less input VAT for a period, by rate. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await vatReturn(client, { orgId, branchId, period });

    if (wantsCsv(searchParams)) {
      return {
        csv: vatCsv(report),
        filename: `vat-return-${period.from}-to-${period.to}.csv`,
      };
    }

    return {
      json: {
        period,
        branch_id: branchId,
        rows: report.rows.map((row) => ({
          bucket: row.bucket,
          tax_rate: row.taxRate.toFixed(6),
          net: row.net.toFixed(4),
          tax: row.tax.toFixed(4),
          gross: row.gross.toFixed(4),
        })),
        output_vat: report.outputVat.toFixed(4),
        input_vat: report.inputVat.toFixed(4),
        net_vat: report.netVat.toFixed(4),
      },
    };
  });
}
