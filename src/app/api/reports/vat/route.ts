import { withAuth } from '../../_lib';
import { vatReport } from '@/verticals/reports';
import { parsePeriod, resolveBranchId } from '../_shared';

/**
 * GET /api/reports/vat — sales split by VAT rate for a period, for the ZIMRA return.
 *
 * It reads invoice_lines directly, so its per-rate totals equal the Z-report's `vat_by_rate` (the
 * Z-report reads the same lines).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const period = parsePeriod(url.searchParams);
    const branchId = resolveBranchId(url.searchParams, claims);

    const rows = await vatReport(client, { orgId: claims.orgId!, branchId, period });

    return {
      period,
      rows: rows.map((row) => ({
        tax_rate: row.taxRate.toFixed(6),
        net: row.net.toFixed(4),
        tax: row.tax.toFixed(4),
        gross: row.gross.toFixed(4),
        line_count: row.lineCount,
      })),
    };
  });
}
