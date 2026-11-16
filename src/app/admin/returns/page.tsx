'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/returns — create a return against an invoice, and list past returns.
 *
 * The operator types an invoice id, the page reads its returnable lines (qty sold, qty already
 * returned, the remainder) and lets them enter a quantity per line. Creating the return calls
 * app.create_return, which locks the invoice lines FOR UPDATE, checks the unreturned quantity,
 * returns stock at the original FIFO cost and posts the refund. The refund method defaults from
 * settings when left as "Use org default".
 */

interface ReturnRow {
  id: string;
  return_no: string;
  status: string;
  original_invoice_id: string;
  refund_method: string;
  total: string;
  credit_note_id: string | null;
  created_at: string;
}

interface ReturnListResponse {
  returns: ReturnRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

interface ReturnableLine {
  invoice_line_id: string;
  line_no: number;
  product_id: string;
  variant_id: string | null;
  description: string | null;
  qty_sold: string;
  qty_returned: string;
  qty_returnable: string;
  unit_price: string;
  unit_cost: string;
}

export default function ReturnsPage() {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [invoiceId, setInvoiceId] = useState('');
  const [lines, setLines] = useState<ReturnableLine[]>([]);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [refundMethod, setRefundMethod] = useState<'' | 'cash' | 'store_credit'>('');

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<ReturnListResponse>('/api/admin/returns');
      setRows(payload.returns);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<ReturnListResponse>(withCursor('/api/admin/returns', cursor));
    setRows((current) => [...current, ...payload.returns]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const loadInvoice = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const payload = await adminGet<{ lines: ReturnableLine[] }>(
        `/api/admin/invoices/${invoiceId}/returnable-lines`,
      );
      setLines(payload.lines);
      setQuantities(
        Object.fromEntries(payload.lines.map((line) => [line.line_no, line.qty_returnable])),
      );
    } catch (err) {
      setError((err as Error).message);
      setLines([]);
    }
  }, [invoiceId]);

  const create = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const chosen = lines
        .map((line) => ({ line_no: line.line_no, qty: quantities[line.line_no] ?? '0' }))
        .filter((line) => Number(line.qty) > 0);
      if (chosen.length === 0) {
        setError('enter a quantity on at least one line');
        return;
      }
      const result = await adminPost<{ return_no: string; total: string; refund_method: string }>(
        '/api/admin/returns',
        {
          original_invoice_id: invoiceId,
          lines: chosen,
          ...(refundMethod ? { refund_method: refundMethod } : {}),
        },
      );
      setNotice(`Return ${result.return_no} created; ${result.total} refunded (${result.refund_method}).`);
      setLines([]);
      setQuantities({});
      setInvoiceId('');
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [invoiceId, lines, quantities, refundMethod, loadFirstPage]);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Returns</h1>
      <OpsNav current="/admin/returns" />

      {error && (
        <p role="alert" data-testid="returns-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {notice && <p data-testid="returns-notice">{notice}</p>}

      <section style={{ margin: '12px 0' }}>
        <h2>New return</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            aria-label="Invoice id"
            placeholder="Invoice id"
            value={invoiceId}
            onChange={(event) => setInvoiceId(event.target.value)}
            style={{ minWidth: 320 }}
          />
          <button type="button" data-testid="load-invoice" onClick={() => void loadInvoice()}>
            Load lines
          </button>
          <label>
            Refund{' '}
            <select
              aria-label="Refund method"
              value={refundMethod}
              onChange={(event) =>
                setRefundMethod(event.target.value as '' | 'cash' | 'store_credit')
              }
            >
              <option value="">Use org default</option>
              <option value="cash">Cash</option>
              <option value="store_credit">Store credit</option>
            </select>
          </label>
        </div>

        {lines.length > 0 && (
          <table
            data-testid="returnable-table"
            style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}
          >
            <thead>
              <tr>
                <th align="left">Line</th>
                <th align="left">Item</th>
                <th align="right">Sold</th>
                <th align="right">Returned</th>
                <th align="right">Returnable</th>
                <th align="right">Unit price</th>
                <th align="right">Return qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.invoice_line_id}>
                  <td>{line.line_no}</td>
                  <td>{line.description ?? line.variant_id ?? line.product_id}</td>
                  <td align="right">{line.qty_sold}</td>
                  <td align="right">{line.qty_returned}</td>
                  <td align="right">{line.qty_returnable}</td>
                  <td align="right">{line.unit_price}</td>
                  <td align="right">
                    <input
                      aria-label={`Return qty line ${line.line_no}`}
                      data-testid={`return-qty-${line.line_no}`}
                      value={quantities[line.line_no] ?? ''}
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [line.line_no]: event.target.value,
                        }))
                      }
                      style={{ width: 90, textAlign: 'right' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {lines.length > 0 && (
          <button
            type="button"
            data-testid="create-return"
            onClick={() => void create()}
            style={{ marginTop: 12 }}
          >
            Create return
          </button>
        )}
      </section>

      <section>
        <h2>Past returns</h2>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <table data-testid="returns-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th align="left">Return</th>
                <th align="left">Invoice</th>
                <th align="left">Refund</th>
                <th align="right">Total</th>
                <th align="left">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`return-${row.return_no}`}>
                  <td>
                    <code>{row.return_no}</code>
                  </td>
                  <td>
                    <code>{row.original_invoice_id}</code>
                  </td>
                  <td>{row.refund_method}</td>
                  <td align="right">{row.total}</td>
                  <td>{row.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && (
          <button type="button" onClick={() => void loadMore()} style={{ marginTop: 12 }}>
            Load more
          </button>
        )}
      </section>
    </main>
  );
}
