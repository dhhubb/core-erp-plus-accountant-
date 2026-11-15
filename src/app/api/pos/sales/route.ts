import Decimal from 'decimal.js';
import { ApiError, RateLimitedError, jsonError, parseCursor, parseLimit, withAuth } from '@/app/api/_lib';
import {
  createPosSale,
  listPosSales,
  TENDER_CURRENCIES,
  TENDER_METHODS,
  type PosSaleLineInput,
  type PosTenderInput,
} from '@/verticals/pos/sales';
import { checkLiveSaleLimit, redisCounterStore } from '@/verticals/pos/rateLimit';

interface SaleBody {
  warehouse_id: string;
  shift_id?: string | null;
  client_sale_id: string;
  contact_id?: string | null;
  sale_date?: string | null;
  tax_code?: string | null;
  lines: Array<{
    barcode?: string | null;
    variant_id?: string | null;
    qty: string | number;
    unit_price?: string | number | null;
  }>;
  tenders: Array<{
    method: string;
    currency: string;
    amount_tendered: string | number;
  }>;
}

function serialise(receipt: Awaited<ReturnType<typeof createPosSale>>) {
  return {
    sale_id: receipt.saleId,
    invoice_id: receipt.invoiceId,
    invoice_no: receipt.invoiceNo,
    currency: receipt.currency,
    subtotal: receipt.subtotal.toFixed(4),
    tax_total: receipt.taxTotal.toFixed(4),
    total: receipt.total.toFixed(4),
    change_total: receipt.changeTotal.toFixed(4),
    lines: receipt.lines.map((line) => ({
      line_no: line.lineNo,
      description: line.description,
      qty: line.qty.toFixed(4),
      unit_price: line.unitPrice.toFixed(4),
      line_subtotal: line.lineSubtotal.toFixed(4),
      line_tax: line.lineTax.toFixed(4),
      line_total: line.lineTotal.toFixed(4),
      tax_rate: line.taxRate.toFixed(6),
    })),
    payments: receipt.payments.map((payment) => ({
      method: payment.method,
      currency: payment.currency,
      amount_tendered: payment.amountTendered.toFixed(4),
      amount_applied: payment.amountApplied.toFixed(4),
      rate: payment.rate.toString(),
      base_amount: payment.baseAmount.toFixed(4),
      change_given: payment.changeGiven.toFixed(4),
    })),
  };
}

/** POST /api/pos/sales — ring a sale: CORE invoice + one CORE payment per tender, one transaction. */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    // Live sales are rate limited per cashier (30/minute). The sync endpoint is exempt, because it
    // carries a backlog of already-completed sales. Counters live in Redis and never in the ledger.
    const limit = await checkLiveSaleLimit(redisCounterStore(), {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      cashierId: claims.sub,
    });
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfter);
    }

    const body = (await request.json()) as SaleBody;

    if (!body.client_sale_id) {
      throw new ApiError(422, 'client_sale_id is required');
    }
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new ApiError(422, 'lines must be a non-empty array');
    }
    if (!Array.isArray(body.tenders) || body.tenders.length === 0) {
      throw new ApiError(422, 'tenders must be a non-empty array');
    }

    const lines: PosSaleLineInput[] = body.lines.map((line) => ({
      barcode: line.barcode ?? null,
      variantId: line.variant_id ?? null,
      qty: new Decimal(line.qty),
      unitPrice: line.unit_price === null || line.unit_price === undefined
        ? null
        : new Decimal(line.unit_price),
    }));

    const tenders: PosTenderInput[] = body.tenders.map((tender) => {
      if (!TENDER_METHODS.includes(tender.method as (typeof TENDER_METHODS)[number])) {
        throw new ApiError(422, `unknown tender method ${tender.method}`);
      }
      if (!TENDER_CURRENCIES.includes(tender.currency as (typeof TENDER_CURRENCIES)[number])) {
        throw new ApiError(422, `unsupported tender currency ${tender.currency}`);
      }
      return {
        method: tender.method as PosTenderInput['method'],
        currency: tender.currency as PosTenderInput['currency'],
        amountTendered: new Decimal(tender.amount_tendered),
      };
    });

    const receipt = await createPosSale(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      warehouseId: body.warehouse_id,
      shiftId: body.shift_id ?? null,
      clientSaleId: body.client_sale_id,
      lines,
      tenders,
      contactId: body.contact_id ?? null,
      saleDate: body.sale_date ?? null,
      taxCode: body.tax_code ?? null,
    });

    return serialise(receipt);
  });
}

/** GET /api/pos/sales — keyset page on (created_at, id). Default 50, maximum 100. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listPosSales(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      shiftId: url.searchParams.get('shift_id'),
      limit,
      cursor,
    });

    return {
      sales: page.sales.map((sale) => ({
        id: sale.id,
        shift_id: sale.shiftId,
        invoice_id: sale.invoiceId,
        client_sale_id: sale.clientSaleId,
        status: sale.status,
        cashier_id: sale.cashierId,
        created_at: sale.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
