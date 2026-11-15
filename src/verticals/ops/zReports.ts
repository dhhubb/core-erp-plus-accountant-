import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';

export interface ZReport {
  id: string;
  zNo: string;
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openingFloat: Decimal;
  saleCount: number;
  voidCount: number;
  grossSales: Decimal;
  taxTotal: Decimal;
  byMethod: Record<string, string>;
  byCurrency: Record<string, string>;
  vatByRate: Record<string, string>;
  createdAt: string;
}

/**
 * Close a shift. app.close_shift writes exactly one immutable z_reports row from the shift's sales
 * and tenders, then closes the shift. It is the only source a daily summary reads.
 */
export async function closeShift(
  client: PoolClient,
  input: { orgId: string; shiftId: string; closedBy?: string | null },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.close_shift($1, $2, $3) as app`,
    [input.orgId, input.shiftId, input.closedBy ?? null],
  );
  return result.rows[0]!.app;
}

function numericRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    out[key] = moneyFromSql(String(amount)).toFixed(4);
  }
  return out;
}

/** One keyset page of Z-reports on (created_at, id). */
export async function listZReports(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ reports: ZReport[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    z_no: string;
    shift_id: string;
    opened_at: Date;
    closed_at: Date;
    opening_float: string;
    sale_count: number;
    void_count: number;
    gross_sales: string;
    tax_total: string;
    by_method: unknown;
    by_currency: unknown;
    vat_by_rate: unknown;
    created_at: Date;
  }>(
    `select id, z_no, shift_id, opened_at, closed_at, opening_float::text, sale_count, void_count,
            gross_sales::text, tax_total::text, by_method, by_currency, vat_by_rate, created_at
       from public.z_reports
      where org_id = $1
        and branch_id = $2
        and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
      order by created_at desc, id desc
      limit $5`,
    [
      input.orgId,
      input.branchId,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      limit,
    ],
  );

  const reports = result.rows.map((row) => ({
    id: row.id,
    zNo: row.z_no,
    shiftId: row.shift_id,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at.toISOString(),
    openingFloat: moneyFromSql(row.opening_float),
    saleCount: row.sale_count,
    voidCount: row.void_count,
    grossSales: moneyFromSql(row.gross_sales),
    taxTotal: moneyFromSql(row.tax_total),
    byMethod: numericRecord(row.by_method),
    byCurrency: numericRecord(row.by_currency),
    vatByRate: numericRecord(row.vat_by_rate),
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { reports, nextCursor };
}
