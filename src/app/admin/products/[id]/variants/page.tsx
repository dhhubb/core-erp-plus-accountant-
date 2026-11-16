'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminApiError, adminGet, adminPatch, adminPost, adminDelete, withCursor } from '@/verticals/admin/client';
import { BarcodeScannerInput } from '@/verticals/admin/BarcodeScannerInput';
import { enqueueEdit } from '@/verticals/admin/outbox';

/**
 * /admin/products/[id]/variants — a product's variants.
 *
 * Each variant carries size, colour, a barcode (scanned into the field) and a planning cost. The
 * barcode field is the USB-wedge scanner input; the server rejects a 13-digit barcode with a bad
 * EAN-13 check digit and refuses a duplicate barcode. A write that cannot reach the server is
 * queued in the IndexedDB outbox, so an offline branch admin does not lose the edit.
 */

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  size: string | null;
  color: string | null;
  barcode: string | null;
  cost: string | null;
  qty_on_hand: string;
  created_at: string;
  updated_at: string;
}

interface VariantListResponse {
  variants: VariantRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

function isOffline(err: unknown): boolean {
  return !(err instanceof AdminApiError);
}

export default function VariantsPage() {
  const params = useParams<{ id: string }>();
  const productId = params.id;

  const [rows, setRows] = useState<VariantRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');
  const [barcode, setBarcode] = useState<string | null>(null);
  const [cost, setCost] = useState('');

  const path = `/api/admin/variants?product_id=${encodeURIComponent(productId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<VariantListResponse>(path);
      setRows(payload.variants);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<VariantListResponse>(withCursor(path, cursor));
    setRows((current) => [...current, ...payload.variants]);
    setCursor(payload.next_cursor);
  }, [cursor, path]);

  const create = useCallback(async () => {
    setError(null);
    setNotice(null);
    const body = {
      product_id: productId,
      name: name || null,
      size: size || null,
      color: color || null,
      barcode,
      cost: cost === '' ? null : cost,
    };
    try {
      await adminPost('/api/admin/variants', body);
      setName('');
      setSize('');
      setColor('');
      setBarcode(null);
      setCost('');
      await load();
    } catch (err) {
      if (isOffline(err)) {
        await enqueueEdit({
          editId: crypto.randomUUID(),
          method: 'POST',
          path: '/api/admin/variants',
          body,
          editedAt: new Date().toISOString(),
        });
        setNotice('Saved offline. It will sync when the connection returns.');
        return;
      }
      setError((err as Error).message);
    }
  }, [productId, name, size, color, barcode, cost, load]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await adminDelete(`/api/admin/variants/${id}`);
        await load();
      } catch (err) {
        if (isOffline(err)) {
          await enqueueEdit({
            editId: crypto.randomUUID(),
            method: 'DELETE',
            path: `/api/admin/variants/${id}`,
            body: null,
            editedAt: new Date().toISOString(),
          });
          setNotice('Delete saved offline.');
          return;
        }
        setError((err as Error).message);
      }
    },
    [load],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Variants</h1>

      {error && (
        <p role="alert" data-testid="variants-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="variants-notice" style={{ color: '#8a6d00' }}>
          {notice}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}
      >
        <input aria-label="Variant name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Size" placeholder="Size" value={size} onChange={(e) => setSize(e.target.value)} />
        <input aria-label="Colour" placeholder="Colour" value={color} onChange={(e) => setColor(e.target.value)} />
        <BarcodeScannerInput value={barcode} onSave={setBarcode} />
        <input aria-label="Cost" placeholder="Cost" value={cost} onChange={(e) => setCost(e.target.value)} />
        <button type="submit" data-testid="variant-submit">
          Add variant
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="variant-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">SKU</th>
              <th align="left">Size</th>
              <th align="left">Colour</th>
              <th align="left">Barcode</th>
              <th align="left">Cost</th>
              <th align="left">On hand</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`variant-${row.sku}`}>
                <td>
                  <code>{row.sku}</code>
                </td>
                <td>{row.size}</td>
                <td>{row.color}</td>
                <td>{row.barcode}</td>
                <td>{row.cost}</td>
                <td>{row.qty_on_hand}</td>
                <td>
                  <button type="button" onClick={() => void remove(row.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
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
