import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { Readable } from 'node:stream';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';

export interface StockCountLineInput {
  productId: string;
  variantId?: string | null;
  countedQty: string | Decimal;
  systemQty: string | Decimal;
  unitCost: string | Decimal;
}

export interface StockCount {
  id: string;
  countNo: string;
  status: 'open' | 'closed';
  countedAt: string;
  createdAt: string;
}

/**
 * Open a stock count. app.create_stock_count snapshots nothing by itself; the caller imports the
 * counted lines with importStockCountLines.
 */
export async function createStockCount(
  client: PoolClient,
  input: { orgId: string; branchId: string; warehouseId: string; countedAt?: string | null },
): Promise<{ countId: string; countNo: string; createdAt: string }> {
  const result = await client.query<{
    app: { count_id: string; count_no: string; created_at: string };
  }>(`select app.create_stock_count($1, $2, $3, $4::date) as app`, [
    input.orgId,
    input.branchId,
    input.warehouseId,
    input.countedAt ?? null,
  ]);
  const payload = result.rows[0]!.app;
  return { countId: payload.count_id, countNo: payload.count_no, createdAt: payload.created_at };
}

/**
 * Import the counted lines with COPY FROM STDIN. A large count (tens of thousands of lines) is one
 * streamed COPY rather than N round trips, and the count_created_at carried on every row is the
 * header's created_at, so the composite foreign key holds.
 */
export async function importStockCountLines(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    countId: string;
    countCreatedAt: string;
    lines: readonly StockCountLineInput[];
  },
): Promise<number> {
  const copySql =
    `copy public.stock_count_items
       (org_id, branch_id, count_id, count_created_at, line_no, product_id, variant_id,
        counted_qty, system_qty, unit_cost) from stdin with (format csv, null '\\N')`;

  const stream = client.query(copyFrom(copySql));

  const csv = input.lines
    .map((line, index) =>
      [
        input.orgId,
        input.branchId,
        input.countId,
        input.countCreatedAt,
        String(index + 1),
        line.productId,
        line.variantId ?? '\\N',
        new Decimal(line.countedQty).toFixed(4),
        new Decimal(line.systemQty).toFixed(4),
        new Decimal(line.unitCost).toFixed(4),
      ].join(','),
    )
    .join('\n');

  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    Readable.from([`${csv}\n`]).pipe(stream);
  });

  return input.lines.length;
}

/** Close a stock count: post exactly one CORE stock adjustment (one journal) for the whole count. */
export async function closeStockCount(
  client: PoolClient,
  input: {
    orgId: string;
    countId: string;
    countCreatedAt: string;
    postingDate?: string | null;
    memo?: string | null;
  },
): Promise<{ adjustedLines: number; inventoryIncrease: Decimal; inventoryDecrease: Decimal; journalId: string | null }> {
  const result = await client.query<{
    app: {
      adjusted_lines: number;
      inventory_increase: string;
      inventory_decrease: string;
      journal_id: string | null;
    };
  }>(`select app.close_stock_count($1, $2, $3::timestamptz, $4::date, $5) as app`, [
    input.orgId,
    input.countId,
    input.countCreatedAt,
    input.postingDate ?? null,
    input.memo ?? null,
  ]);
  const payload = result.rows[0]!.app;
  return {
    adjustedLines: payload.adjusted_lines,
    inventoryIncrease: moneyFromSql(payload.inventory_increase),
    inventoryDecrease: moneyFromSql(payload.inventory_decrease),
    journalId: payload.journal_id,
  };
}

/** One keyset page of stock counts on (created_at, id). */
export async function listStockCounts(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ counts: StockCount[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    count_no: string;
    status: 'open' | 'closed';
    counted_at: Date;
    created_at: Date;
  }>(
    `select id, count_no, status, counted_at, created_at
       from public.stock_counts
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

  const counts = result.rows.map((row) => ({
    id: row.id,
    countNo: row.count_no,
    status: row.status,
    countedAt: row.counted_at.toISOString().slice(0, 10),
    createdAt: row.created_at.toISOString(),
  }));

  const last = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && last
      ? { createdAt: last.created_at.toISOString(), id: last.id }
      : null;

  return { counts, nextCursor };
}

/** A small helper so callers do not import decimal.js just to format money. */
export function formatMoney(value: Decimal | string): string {
  return money(value).toFixed(4);
}
