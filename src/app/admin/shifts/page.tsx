'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/shifts — the till shifts and their Z-reports.
 *
 * The list is a keyset page (created_at, id) with a status filter. Closing a shift through the
 * console calls app.close_shift, which writes one immutable Z-report and closes the shift. The
 * Z-report is shown read-only inline (it is never updated).
 */

type ShiftStatus = 'open' | 'closed';

interface ShiftRow {
  id: string;
  till_id: string;
  status: ShiftStatus;
  opening_float: string;
  opened_at: string;
  closed_at: string | null;
  z_report_id: string | null;
  z_no: string | null;
  created_at: string;
}

interface ShiftListResponse {
  shifts: ShiftRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

interface ZReport {
  id: string;
  z_no: string;
  sale_count: number;
  void_count: number;
  gross_sales: string;
  tax_total: string;
  by_method: Record<string, string>;
  vat_by_rate: Record<string, string>;
}

export default function ShiftsPage() {
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [status, setStatus] = useState<ShiftStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ZReport | null>(null);
  const [loading, setLoading] = useState(true);

  const path = status ? `/api/admin/shifts?status=${status}` : '/api/admin/shifts';

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<ShiftListResponse>(path);
      setRows(payload.shifts);
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
    const payload = await adminGet<ShiftListResponse>(withCursor(path, cursor));
    setRows((current) => [...current, ...payload.shifts]);
    setCursor(payload.next_cursor);
  }, [cursor, path]);

  const close = useCallback(
    async (shiftId: string) => {
      setError(null);
      try {
        const result = await adminPost<{ z_report_id: string }>('/api/admin/shifts', {
          shift_id: shiftId,
        });
        setReport(await adminGet<ZReport>(`/api/admin/z-reports/${result.z_report_id}`));
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const view = useCallback(async (zReportId: string) => {
    setError(null);
    try {
      setReport(await adminGet<ZReport>(`/api/admin/z-reports/${zReportId}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Shifts &amp; Z-reports</h1>
      <OpsNav current="/admin/shifts" />

      {error && (
        <p role="alert" data-testid="shifts-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <section style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <label>
          Status{' '}
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ShiftStatus | '')}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </section>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="shift-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Till</th>
              <th align="left">Status</th>
              <th align="right">Opening float</th>
              <th align="left">Opened</th>
              <th align="left">Z-report</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`shift-${row.id}`}>
                <td>{row.till_id}</td>
                <td>{row.status}</td>
                <td align="right">{row.opening_float}</td>
                <td>{row.opened_at}</td>
                <td>{row.z_no ?? '—'}</td>
                <td style={{ display: 'flex', gap: 8 }}>
                  {row.status === 'open' && (
                    <button
                      type="button"
                      data-testid={`close-shift-${row.id}`}
                      onClick={() => void close(row.id)}
                    >
                      Close shift
                    </button>
                  )}
                  {row.z_report_id && (
                    <button type="button" onClick={() => void view(row.z_report_id!)}>
                      View Z
                    </button>
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

      {report && (
        <section data-testid="z-report" style={{ marginTop: 24 }}>
          <h2>Z-report {report.z_no}</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
            <dt>Sales</dt>
            <dd>{report.sale_count}</dd>
            <dt>Voids</dt>
            <dd>{report.void_count}</dd>
            <dt>Gross sales</dt>
            <dd>{report.gross_sales}</dd>
            <dt>VAT</dt>
            <dd>{report.tax_total}</dd>
            <dt>By method</dt>
            <dd>
              {Object.entries(report.by_method)
                .map(([key, amount]) => `${key}: ${amount}`)
                .join(', ') || '—'}
            </dd>
            <dt>VAT by rate</dt>
            <dd>
              {Object.entries(report.vat_by_rate)
                .map(([key, amount]) => `${key}: ${amount}`)
                .join(', ') || '—'}
            </dd>
          </dl>
        </section>
      )}
    </main>
  );
}
