import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { money } from '../core/money';

export interface ReceiptInput {
  orgId: string;
  branchId: string;
  warehouseId: string;
  productId: string;
  variantId?: string | null;
  qty: string | Decimal;
  unitCost: string | Decimal;
  postingDate: string;
}

/** Inbound stock layer plus journal (Dr Inventory, Cr Accounts Payable), in one transaction. */
export async function postReceipt(client: PoolClient, input: ReceiptInput): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.post_receipt($1, $2, $3, $4, $5, $6, $7, $8::date) as app`,
    [
      input.orgId,
      input.branchId,
      input.warehouseId,
      input.productId,
      input.variantId ?? null,
      new Decimal(input.qty).toFixed(4),
      new Decimal(input.unitCost).toFixed(4),
      input.postingDate,
    ],
  );
  return result.rows[0]!.app;
}

export interface AdjustmentInput {
  orgId: string;
  branchId: string;
  warehouseId: string;
  productId: string;
  variantId?: string | null;
  qty: string | Decimal;
  unitCost: string | Decimal;
  postingDate: string;
  memo?: string;
}

/** Signed stock adjustment. Ledger rows and a balanced journal in one transaction. */
export async function postStockAdjustment(
  client: PoolClient,
  input: AdjustmentInput,
): Promise<string> {
  const result = await client.query<{ app: string }>(
    `select app.post_stock_adjustment($1, $2, $3, $4, $5, $6, $7, $8::date, $9) as app`,
    [
      input.orgId,
      input.branchId,
      input.warehouseId,
      input.productId,
      input.variantId ?? null,
      new Decimal(input.qty).toFixed(4),
      new Decimal(input.unitCost).toFixed(4),
      input.postingDate,
      input.memo ?? 'Stock adjustment',
    ],
  );
  return result.rows[0]!.app;
}

/** On-hand quantity and value for one warehouse/product. */
export async function stockOnHand(
  client: PoolClient,
  input: { orgId: string; warehouseId: string; productId: string; variantId?: string | null },
): Promise<{ qty: Decimal; value: Decimal }> {
  const result = await client.query<{ qty: string; value: string }>(
    `select qty::text, value::text
       from public.stock_balances
      where org_id = $1 and warehouse_id = $2 and product_id = $3
        and variant_id is not distinct from $4`,
    [input.orgId, input.warehouseId, input.productId, input.variantId ?? null],
  );
  const row = result.rows[0];
  return {
    qty: money(row?.qty ?? '0'),
    value: money(row?.value ?? '0'),
  };
}
