import { withAccountingAuth, parsePeriod, resolveBranchId, requireOrg, wantsCsv } from '../_shared';
import { changesInEquity } from '@/accounting/reports';
import { equityCsv } from '@/accounting/export';

/** GET /api/accounting/changes-in-equity — the movement in equity over a period. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims, searchParams }) => {
    const orgId = requireOrg(claims);
    const period = parsePeriod(searchParams);
    const branchId = resolveBranchId(searchParams, claims);

    const report = await changesInEquity(client, { orgId, branchId, period });

    if (wantsCsv(searchParams)) {
      return {
        csv: equityCsv(report),
        filename: `changes-in-equity-${period.from}-to-${period.to}.csv`,
      };
    }

    return {
      json: {
        period,
        branch_id: branchId,
        rows: report.rows.map((row) => ({
          kind: row.kind,
          code: row.code,
          name: row.name,
          opening: row.opening.toFixed(4),
          movement: row.movement.toFixed(4),
          closing: row.closing.toFixed(4),
        })),
        opening_equity: report.openingEquity.toFixed(4),
        profit_for_period: report.profitForPeriod.toFixed(4),
        other_movements: report.otherMovements.toFixed(4),
        closing_equity: report.closingEquity.toFixed(4),
      },
    };
  });
}
