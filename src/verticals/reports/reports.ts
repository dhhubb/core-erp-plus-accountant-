import type Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import type {
  FiscalStatusTotals,
  FiscalTotals,
  LastSync,
  PeriodProfit,
  ProductProfitPage,
  ProductProfitRow,
  ProductRankPage,
  VatRow,
  ZReportPage,
  ZReportRow,
} from './types';

/**
 * The report reads. Every figure comes from SQL (app.report_*); this module only shapes the rows.
 *
 * Two sources, one rule (ADR-0046): a closed day is read from the immutable daily facts, and today
 * is read live from invoices + invoice_lines bounded by invoice_date. The SQL decides which; this
 * module never re-implements it.
 */

/** A period is inclusive of both dates. */
export interface Period {
  from: string;
  to: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
}

function num(value: unknown): string {
  return value === null || value === undefined ? '0' : String(value);
}

function productRow(row: Record<string, unknown>): ProductProfitRow {
  return {
    productId: String(row['product_id']),
    qty: moneyFromSql(num(row['qty'])),
    revenue: moneyFromSql(num(row['revenue'])),
    tax: moneyFromSql(num(row['tax'])),
    cogs: moneyFromSql(num(row['cogs'])),
    profit: moneyFromSql(num(row['profit'])),
  };
}

function moneyRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    out[key] = moneyFromSql(String(amount)).toFixed(4);
  }
  return out;
}

function decimalRecord(value: unknown): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const [key, amount] of Object.entries(moneyRecord(value))) {
    out[key] = moneyFromSql(amount);
  }
  return out;
}

function fiscalTotals(value: unknown): FiscalTotals {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    count: Number(record['count'] ?? 0),
    amount: moneyFromSql(num(record['amount'])),
  };
}

function fiscalStatus(value: unknown): FiscalStatusTotals {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    sent: fiscalTotals(record['sent']),
    pending: fiscalTotals(record['pending']),
    failed: fiscalTotals(record['failed']),
  };
}

/** Profit by product for the period. Keyset on product_id. */
export async function profitByProduct(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    period: Period;
    limit?: number;
    afterProductId?: string | null;
  },
): Promise<ProductProfitPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{ r: { rows: Record<string, unknown>[]; next_after_product_id: string | null } }>(
    'select app.report_profit_by_product($1, $2, $3::date, $4::date, $5, $6) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to, limit, input.afterProductId ?? null],
  );
  const payload = result.rows[0]!.r;
  const rows = payload.rows.map(productRow);
  const next = payload.next_after_product_id;
  return {
    rows,
    nextCursor: rows.length === limit && next ? { afterProductId: next } : null,
  };
}

/** Best sellers (ascending = false) or slow movers (ascending = true). Keyset on (qty, product_id). */
export async function productRanking(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    period: Period;
    ascending: boolean;
    limit?: number;
    afterQty?: string | null;
    afterProductId?: string | null;
  },
): Promise<ProductRankPage> {
  const limit = clampLimit(input.limit);
  const fn = input.ascending ? 'app.report_slow_movers' : 'app.report_best_sellers';
  const result = await client.query<{
    r: {
      rows: Record<string, unknown>[];
      next_after_qty: string | null;
      next_after_product_id: string | null;
    };
  }>(`select ${fn}($1, $2, $3::date, $4::date, $5, $6, $7) as r`, [
    input.orgId,
    input.branchId,
    input.period.from,
    input.period.to,
    limit,
    input.afterQty ?? null,
    input.afterProductId ?? null,
  ]);
  const payload = result.rows[0]!.r;
  const rows = payload.rows.map(productRow);
  const nextQty = payload.next_after_qty;
  const nextId = payload.next_after_product_id;
  return {
    rows,
    nextCursor:
      rows.length === limit && nextQty !== null && nextId !== null
        ? { afterQty: moneyFromSql(nextQty), afterProductId: nextId }
        : null,
  };
}

/** The VAT report: sales split by the VAT rate each line used, for the ZIMRA return. */
export async function vatReport(
  client: PoolClient,
  input: { orgId: string; branchId: string; period: Period },
): Promise<VatRow[]> {
  const result = await client.query<{ r: Record<string, unknown>[] }>(
    'select app.report_vat($1, $2, $3::date, $4::date) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );
  return result.rows[0]!.r.map((row) => ({
    taxRate: moneyFromSql(num(row['tax_rate'])),
    net: moneyFromSql(num(row['net'])),
    tax: moneyFromSql(num(row['tax'])),
    gross: moneyFromSql(num(row['gross'])),
    lineCount: Number(row['line_count'] ?? 0),
  }));
}

/** A keyset page of Z-reports, each with its fiscal totals. */
export async function zReports(
  client: PoolClient,
  input: { orgId: string; branchId: string; limit?: number; cursor?: PageCursor | null },
): Promise<ZReportPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{
    r: {
      rows: Record<string, unknown>[];
      next_after_created_at: string | null;
      next_after_id: string | null;
    };
  }>('select app.report_z_reports($1, $2, $3, $4::timestamptz, $5) as r', [
    input.orgId,
    input.branchId,
    limit,
    input.cursor?.createdAt ?? null,
    input.cursor?.id ?? null,
  ]);
  const payload = result.rows[0]!.r;
  const rows: ZReportRow[] = payload.rows.map((row) => ({
    id: String(row['id']),
    zNo: String(row['z_no']),
    shiftId: String(row['shift_id']),
    openedAt: String(row['opened_at']),
    closedAt: String(row['closed_at']),
    openingFloat: moneyFromSql(num(row['opening_float'])),
    saleCount: Number(row['sale_count'] ?? 0),
    voidCount: Number(row['void_count'] ?? 0),
    grossSales: moneyFromSql(num(row['gross_sales'])),
    taxTotal: moneyFromSql(num(row['tax_total'])),
    byMethod: decimalRecord(row['by_method']),
    byCurrency: decimalRecord(row['by_currency']),
    vatByRate: decimalRecord(row['vat_by_rate']),
    fiscal: fiscalStatus(row['fiscal']),
    createdAt: String(row['created_at']),
  }));
  const nextAt = payload.next_after_created_at;
  const nextId = payload.next_after_id;
  return {
    rows,
    nextCursor: rows.length === limit && nextAt && nextId ? { createdAt: nextAt, id: nextId } : null,
  };
}

/** GL revenue minus cost of goods sold for the period. The profit report must equal this. */
export async function glPeriodProfit(
  client: PoolClient,
  input: { orgId: string; branchId: string; period: Period },
): Promise<PeriodProfit> {
  const result = await client.query<{ r: Record<string, unknown> }>(
    'select app.report_gl_period_profit($1, $2, $3::date, $4::date) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );
  const row = result.rows[0]!.r;
  return {
    revenue: moneyFromSql(num(row['revenue'])),
    cogs: moneyFromSql(num(row['cogs'])),
    profit: moneyFromSql(num(row['profit'])),
  };
}

/** When the branch last synced. The owner console always shows this. */
export async function lastSync(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<LastSync> {
  const result = await client.query<{ r: Record<string, unknown> }>(
    'select app.report_last_sync($1, $2) as r',
    [input.orgId, input.branchId],
  );
  const row = result.rows[0]!.r;
  const contact = row['last_cloud_contact_at'];
  const ingest = row['last_ingest_at'];
  return {
    lastCloudContactAt: contact === null || contact === undefined ? null : String(contact),
    lastIngestAt: ingest === null || ingest === undefined ? null : String(ingest),
    lastPushedSeq: String(row['last_pushed_seq'] ?? '0'),
    outboxSize: Number(row['outbox_size'] ?? 0),
  };
}
