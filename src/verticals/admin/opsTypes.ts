import type Decimal from 'decimal.js';

/**
 * Types for the A3 admin operations console (laybys, returns, shifts/Z-reports, stocktake). They are
 * the shapes the route handlers return and the pages consume. Money is a Decimal (never a number).
 */

export type LaybyStatus = 'open' | 'completed' | 'cancelled';

export interface LaybyListRow {
  id: string;
  laybyNo: string;
  status: LaybyStatus;
  dueDate: string;
  currency: string;
  total: Decimal;
  depositPaid: Decimal;
  contactId: string;
  contactName: string | null;
  invoiceId: string | null;
  isOverdue: boolean;
  createdAt: string;
}

export interface LaybyReservationRow {
  id: string;
  productId: string;
  variantId: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  unitCost: Decimal;
  status: string;
}

export interface LaybyDetail {
  id: string;
  laybyNo: string;
  status: LaybyStatus;
  dueDate: string;
  currency: string;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  depositPaid: Decimal;
  cancellationFee: Decimal;
  invoiceId: string | null;
  isOverdue: boolean;
  createdAt: string;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  reservations: LaybyReservationRow[];
}

export interface ReturnListRow {
  id: string;
  returnNo: string;
  status: string;
  originalInvoiceId: string;
  refundMethod: string;
  total: Decimal;
  creditNoteId: string | null;
  createdAt: string;
}

export interface ReturnableLine {
  invoiceLineId: string;
  lineNo: number;
  productId: string;
  variantId: string | null;
  description: string | null;
  qtySold: Decimal;
  qtyReturned: Decimal;
  qtyReturnable: Decimal;
  unitPrice: Decimal;
  unitCost: Decimal;
}

export type ShiftStatus = 'open' | 'closed';

export interface ShiftListRow {
  id: string;
  tillId: string;
  status: ShiftStatus;
  openingFloat: Decimal;
  openedAt: string;
  closedAt: string | null;
  zReportId: string | null;
  zNo: string | null;
  createdAt: string;
}

export interface ZReport {
  id: string;
  zNo: string;
  branchId: string;
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openingFloat: Decimal;
  saleCount: number;
  voidCount: number;
  grossSales: Decimal;
  taxTotal: Decimal;
  byMethod: Record<string, Decimal>;
  byCurrency: Record<string, Decimal>;
  vatByRate: Record<string, Decimal>;
  createdAt: string;
}

export interface StockCountListRow {
  id: string;
  countNo: string;
  status: 'open' | 'closed';
  warehouseId: string;
  countedAt: string;
  lineCount: number;
  closedAt: string | null;
  journalId: string | null;
  createdAt: string;
}

export interface StockCountDetail {
  id: string;
  countNo: string;
  status: 'open' | 'closed';
  warehouseId: string;
  countedAt: string;
  closedAt: string | null;
  journalId: string | null;
  createdAt: string;
  lineCount: number;
  varianceLines: number;
  inventoryIncrease: Decimal;
  inventoryDecrease: Decimal;
}

export interface StockCountSnapshotRow {
  productId: string;
  variantId: string | null;
  systemQty: Decimal;
  unitCost: Decimal;
}

/** The refund methods a return may use. The setting decides the default; the console may override. */
export const REFUND_METHODS = ['cash', 'store_credit'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export function isRefundMethod(value: unknown): value is RefundMethod {
  return value === 'cash' || value === 'store_credit';
}
