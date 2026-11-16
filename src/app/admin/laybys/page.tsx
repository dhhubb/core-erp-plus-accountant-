'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/laybys — the layby list with a status filter.
 *
 * The list is a keyset page (created_at, id); "Load more" asks for the next page with the cursor the
 * previous page returned, never an offset. A due date in the past is shown in red. Complete creates
 * the CORE invoice and clears the deposit; cancel posts the refund less the fee (the fee defaults
 * from settings on the server). Both actions call the same SQL the till uses.
 */

type LaybyStatus = 'open' | 'completed' | 'cancelled';

interface LaybyRow {
  id: string;
  layby_no: string;
  status: LaybyStatus;
  due_date: string;
  currency: string;
  total: string;
  deposit_paid: string;
  contact_id: string;
  contact_name: string | null;
  invoice_id: string | null;
  is_overdue: boolean;
  created_at: string;
}

interface LaybyListResponse {
  laybys: LaybyRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

export default function LaybysPage() {
  const [rows, setRows] = useState<LaybyRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [status, setStatus] = useState<LaybyStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const path = status ? `/api/admin/laybys?status=${status}` : '/api/admin/laybys';

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<LaybyListResponse>(path);
      setRows(payload.laybys);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<LaybyListResponse>(withCursor(path, cursor));
    setRows((current) => [...current, ...payload.laybys]);
    setCursor(payload.next_cursor);
  }, [cursor, path]);

  const complete = useCallback(
    async (laybyId: string) => {
      setError(null);
      setNotice(null);
      try {
        const result = await adminPost<{ invoice_no: string; deposit_applied: string }>(
          '/api/admin/laybys',
          { action: 'complete', layby_id: laybyId, payment: '0' },
        );
        setNotice(`Invoice ${result.invoice_no} created; deposit ${result.deposit_applied} applied.`);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const cancel = useCallback(
    async (laybyId: string) => {
      setError(null);
      setNotice(null);
      try {
        const result = await adminPost<{ refund: string; cancellation_fee: string }>(
          '/api/admin/laybys',
          { action: 'cancel', layby_id: laybyId },
        );
        setNotice(`Cancelled; refunded ${result.refund} (fee ${result.cancellation_fee}).`);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Laybys</h1>
      <OpsNav current="/admin/laybys" />

      {error && (
        <p role="alert" data-testid="laybys-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {notice && <p data-testid="laybys-notice">{notice}</p>}

      <section style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <label>
          Status{' '}
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as LaybyStatus | '')}
          >
            <option value="">All</option>
            <option value="open">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </section>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="layby-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Layby</th>
              <th align="left">Customer</th>
              <th align="left">Status</th>
              <th align="left">Due</th>
              <th align="right">Total</th>
              <th align="right">Deposit</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`layby-${row.layby_no}`}>
                <td>
                  <Link href={`/admin/laybys/${row.id}`}>{row.layby_no}</Link>
                </td>
                <td>{row.contact_name ?? '—'}</td>
                <td>{row.status}</td>
                <td
                  data-testid={`layby-due-${row.layby_no}`}
                  style={row.is_overdue ? { color: '#c0392b', fontWeight: 700 } : undefined}
                >
                  {row.due_date}
                  {row.is_overdue ? ' (overdue)' : ''}
                </td>
                <td align="right">
                  {row.total} {row.currency}
                </td>
                <td align="right">{row.deposit_paid}</td>
                <td>
                  {row.status === 'open' && (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        data-testid={`layby-complete-${row.layby_no}`}
                        onClick={() => void complete(row.id)}
                      >
                        Complete
                      </button>
                      <button
                        type="button"
                        data-testid={`layby-cancel-${row.layby_no}`}
                        onClick={() => void cancel(row.id)}
                      >
                        Cancel
                      </button>
                    </span>
                  )}
                </td>
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
    </main>
  );
}
