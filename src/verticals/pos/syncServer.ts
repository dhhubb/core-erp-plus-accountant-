import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { applyUserContext, type AuthClaims } from '@/core/auth';
import { getPool } from '@/core/db';

/**
 * Server side of the sync endpoint. Each sale runs in its own transaction on its own pooled
 * connection, under the caller's tenant context (RLS applies exactly as on any request path), so a
 * failure in one sale cannot roll back the rest of the batch. A sale that cannot post is reported
 * as an `exception`; its row in pos_sync_exceptions is written by app.sync_pos_sale in the same
 * transaction, so it survives.
 */

export interface SyncSaleInput {
  clientSaleId: string;
  shiftId: string | null;
  warehouseId: string;
  soldAt: string | null;
  taxCode: string | null;
  lines: Array<{
    barcode: string | null;
    variantId: string | null;
    qty: string | number;
    unitPrice: string | number | null;
  }>;
  tenders: Array<{ method: string; currency: string; amountTendered: string | number }>;
}

export interface SyncSaleResult {
  client_sale_id: string;
  outcome: 'committed' | 'duplicate' | 'exception';
  receipt: unknown;
  exceptions: Array<{ kind: string; detail: unknown }>;
}

interface RawSyncResult {
  outcome: 'committed' | 'duplicate' | 'exception';
  receipt: unknown;
  exceptions: Array<{ kind: string; detail: unknown }>;
}

function jsonLines(sale: SyncSaleInput): string {
  return JSON.stringify(
    sale.lines.map((line) => ({
      barcode: line.barcode,
      variant_id: line.variantId,
      qty: new Decimal(line.qty).toFixed(4),
      unit_price: line.unitPrice === null ? null : new Decimal(line.unitPrice).toFixed(4),
    })),
  );
}

function jsonTenders(sale: SyncSaleInput): string {
  return JSON.stringify(
    sale.tenders.map((tender) => ({
      method: tender.method,
      currency: tender.currency,
      amount_tendered: new Decimal(tender.amountTendered).toFixed(4),
    })),
  );
}

/**
 * Deliver one sale in its own transaction. A malformed sale is caught here so the batch continues;
 * app.sync_pos_sale has already written the `rejected` exception row before it raised, and that row
 * is committed in the same transaction.
 */
async function syncOneSale(
  claims: AuthClaims,
  orgId: string,
  branchId: string,
  sale: SyncSaleInput,
): Promise<SyncSaleResult> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await applyUserContext(client, claims);
    const result = await client.query<{ app: RawSyncResult }>(
      `select app.sync_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, null, null,
              $8::timestamptz, $9) as app`,
      [
        orgId,
        branchId,
        sale.warehouseId,
        sale.shiftId,
        sale.clientSaleId,
        jsonLines(sale),
        jsonTenders(sale),
        sale.soldAt,
        sale.taxCode ?? 'VAT15',
      ],
    );
    await client.query('commit');
    const raw = result.rows[0]!.app;
    return {
      client_sale_id: sale.clientSaleId,
      outcome: raw.outcome,
      receipt: raw.receipt,
      exceptions: raw.exceptions,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      client_sale_id: sale.clientSaleId,
      outcome: 'exception',
      receipt: null,
      exceptions: [{ kind: 'rejected', detail: { reason: (error as Error).message } }],
    };
  } finally {
    client.release();
  }
}

/** Deliver every sale in the batch, one transaction each. Results preserve the input order. */
export async function syncPosSales(
  context: { orgId: string; branchId: string; userId: string },
  sales: readonly SyncSaleInput[],
): Promise<SyncSaleResult[]> {
  const claims: AuthClaims = {
    sub: context.userId,
    orgId: context.orgId,
    branchIds: [context.branchId],
    role: 'authenticated',
  };

  // Sequential: the batch is a backlog, and serialising keeps stock locks in a predictable order.
  const results: SyncSaleResult[] = [];
  for (const sale of sales) {
    results.push(await syncOneSale(claims, context.orgId, context.branchId, sale));
  }
  return results;
}

export type { PoolClient };
