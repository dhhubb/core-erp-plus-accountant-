import { createInvoice, listInvoices, type InvoiceLineInput } from '@/core/sales';
import { parseCursor, parseLimit, withAuth } from '../_lib';

interface CreateInvoiceBody {
  contact_id?: string | null;
  invoice_date: string;
  currency?: string;
  lines: Array<{
    product_id: string;
    variant_id?: string | null;
    warehouse_id: string;
    qty: string;
    unit_price: string;
    discount?: string;
    tax_rate_code?: string | null;
    description?: string | null;
  }>;
}

/** POST /api/invoices — create an invoice (stock, lines and journal, all or nothing). */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as CreateInvoiceBody;
    const lines: InvoiceLineInput[] = body.lines.map((line) => ({
      productId: line.product_id,
      variantId: line.variant_id ?? null,
      warehouseId: line.warehouse_id,
      qty: line.qty,
      unitPrice: line.unit_price,
      ...(line.discount !== undefined ? { discount: line.discount } : {}),
      taxRateCode: line.tax_rate_code ?? null,
      description: line.description ?? null,
    }));

    const summary = await createInvoice(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      contactId: body.contact_id ?? null,
      invoiceDate: body.invoice_date,
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      lines,
    });

    return {
      invoice_id: summary.invoiceId,
      invoice_no: summary.invoiceNo,
      subtotal: summary.subtotal.toFixed(4),
      tax_total: summary.taxTotal.toFixed(4),
      total: summary.total.toFixed(4),
    };
  });
}

/** GET /api/invoices — keyset page on (created_at, id). */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    const page = await listInvoices(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      limit,
      cursor,
    });

    return {
      invoices: page.invoices.map((invoice) => ({
        id: invoice.id,
        invoice_no: invoice.invoiceNo,
        invoice_date: invoice.invoiceDate,
        currency: invoice.currency,
        subtotal: invoice.subtotal.toFixed(4),
        tax_total: invoice.taxTotal.toFixed(4),
        total: invoice.total.toFixed(4),
        amount_paid: invoice.amountPaid.toFixed(4),
        created_at: invoice.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
