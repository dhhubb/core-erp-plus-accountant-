'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';
import { PRICE_LIST_CURRENCIES, PRICE_LIST_KINDS } from '@/verticals/admin/types';

/**
 * /admin/price-lists — the org's price lists (retail / wholesale, each in USD, ZAR or ZWG).
 *
 * The list is a keyset page on (created_at, id): "Load more" asks for the next page with the cursor
 * the previous page returned, never an offset. R2 allows at most one retail and one wholesale list
 * per org, so creating a kind that already exists is a 422 the page shows inline.
 */

interface PriceListRow {
  id: string;
  name: string;
  kind: string;
  currency: string;
  is_active: boolean;
  item_count: number;
  created_at: string;
}

interface PriceListResponse {
  price_lists: PriceListRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

export default function PriceListsPage() {
  const [rows, setRows] = useState<PriceListRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('retail');
  const [currency, setCurrency] = useState<string>('USD');

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<PriceListResponse>('/api/admin/price-lists');
      setRows(payload.price_lists);
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
    const payload = await adminGet<PriceListResponse>(
      withCursor('/api/admin/price-lists', cursor),
    );
    setRows((current) => [...current, ...payload.price_lists]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const create = useCallback(async () => {
    setError(null);
    try {
      await adminPost('/api/admin/price-lists', { name, kind, currency });
      setName('');
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name, kind, currency, loadFirstPage]);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Price lists</h1>
      <PricingNav current="/admin/price-lists" />

      {error && (
        <p role="alert" data-testid="price-lists-error" style={{ color: '#c0392b' }}>
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
          aria-label="New price list name"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="Price list kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          {PRICE_LIST_KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Price list currency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        >
          {PRICE_LIST_CURRENCIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit" data-testid="price-list-submit">
          Add price list
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="price-list-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Kind</th>
              <th align="left">Currency</th>
              <th align="left">Items</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`price-list-${row.id}`}>
                <td>{row.name}</td>
                <td>{row.kind}</td>
                <td>{row.currency}</td>
                <td>{row.item_count}</td>
                <td>
                  <Link href={`/admin/price-lists/${row.id}/items`}>Items</Link>
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
