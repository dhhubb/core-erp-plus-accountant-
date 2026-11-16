'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPost, adminPatch, withCursor } from '@/verticals/admin/client';
import { expiryTone, type ExpiryTone } from '@/verticals/admin/expiry';

/**
 * /admin/batches — product batches with an expiry countdown.
 *
 * A batch belongs to a variant and carries a batch number and an expiry date. The row is coloured
 * by days to expiry: red when expired, amber within 30 days, otherwise neutral. The list is a
 * keyset page (created_at, id).
 */

interface BatchRow {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  batch_no: string;
  expiry_date: string | null;
  days_to_expiry: number | null;
  created_at: string;
}

interface BatchListResponse {
  batches: BatchRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

const TONE_COLOR: Record<ExpiryTone, string> = {
  expired: '#c0392b',
  soon: '#b9770e',
  ok: '#1a7f37',
  none: '#666',
};

export default function BatchesPage() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [variantId, setVariantId] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<BatchListResponse>('/api/admin/batches');
      setRows(payload.batches);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<BatchListResponse>(withCursor('/api/admin/batches', cursor));
    setRows((current) => [...current, ...payload.batches]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const create = useCallback(async () => {
    setError(null);
    try {
      await adminPost('/api/admin/batches', {
        variant_id: variantId,
        batch_no: batchNo,
        expiry_date: expiryDate === '' ? null : expiryDate,
      });
      setBatchNo('');
      setExpiryDate('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [variantId, batchNo, expiryDate, load]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await adminDelete(`/api/admin/batches/${id}`);
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );

  const rename = useCallback(
    async (row: BatchRow) => {
      setError(null);
      const next = window.prompt('Batch number', row.batch_no);
      if (next === null) return;
      try {
        await adminPatch(`/api/admin/batches/${row.id}`, {
          batch_no: next,
          expiry_date: row.expiry_date,
        });
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Batches</h1>

      {error && (
        <p role="alert" data-testid="batches-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}
      >
        <input
          aria-label="Variant id"
          placeholder="Variant id"
          value={variantId}
          onChange={(event) => setVariantId(event.target.value)}
        />
        <input
          aria-label="Batch number"
          placeholder="Batch number"
          value={batchNo}
          onChange={(event) => setBatchNo(event.target.value)}
        />
        <input
          type="date"
          aria-label="Expiry date"
          value={expiryDate}
          onChange={(event) => setExpiryDate(event.target.value)}
        />
        <button type="submit" data-testid="batch-submit">
          Add batch
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="batch-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Product</th>
              <th align="left">Variant</th>
              <th align="left">Batch</th>
              <th align="left">Expiry</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = expiryTone(row.days_to_expiry);
              return (
                <tr key={row.id} data-testid={`batch-${row.batch_no}`}>
                  <td>{row.product_name}</td>
                  <td>{row.variant_name}</td>
                  <td>{row.batch_no}</td>
                  <td data-testid={`expiry-${row.batch_no}`} style={{ color: TONE_COLOR[tone] }}>
                    {row.expiry_date ?? '—'}
                    {row.days_to_expiry !== null && (
                      <span style={{ marginLeft: 6, fontSize: 12 }}>
                        ({row.days_to_expiry} days)
                      </span>
                    )}
                  </td>
                  <td>
                    <button type="button" onClick={() => void rename(row)}>
                      Edit
                    </button>
                    <button type="button" style={{ marginLeft: 4 }} onClick={() => void remove(row.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {cursor && (
        <button type="button" data-testid="load-more" onClick={() => void loadMore()} style={{ marginTop: 12 }}>
          Load more
        </button>
      )}
    </main>
  );
}
