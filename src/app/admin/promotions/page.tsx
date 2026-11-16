'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPatch, adminPost, withCursor } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';
import { PROMOTION_TYPES } from '@/verticals/admin/types';

/**
 * /admin/promotions — the promotions the till applies, by priority.
 *
 * The list is a keyset page (created_at, id) filtered by is_active and type. Priority decides the
 * order promotions apply in; the row's up/down buttons call the reorder endpoint, which assigns
 * priority by position and invalidates the promos:{org_id} cache so the next sale re-reads it.
 */

interface PromotionRow {
  id: string;
  name: string;
  type: string;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  priority: number;
  stackable: boolean;
  conditions: Record<string, unknown>;
  created_at: string;
}

interface PromotionResponse {
  promotions: PromotionRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

function toLocalInput(value: string): string {
  return value.slice(0, 16);
}

export default function PromotionsPage() {
  const [rows, setRows] = useState<PromotionRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  const [name, setName] = useState('');
  const [type, setType] = useState<string>('percent');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [value, setValue] = useState('');

  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (activeFilter) params.set('is_active', activeFilter);
    if (typeFilter) params.set('type', typeFilter);
    const text = params.toString();
    return text ? `?${text}` : '';
  }, [activeFilter, typeFilter]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<PromotionResponse>(`/api/admin/promotions${query()}`);
      setRows(payload.promotions);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<PromotionResponse>(
      withCursor(`/api/admin/promotions${query()}`, cursor),
    );
    setRows((current) => [...current, ...payload.promotions]);
    setCursor(payload.next_cursor);
  }, [cursor, query]);

  const create = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const conditions = value === '' ? {} : { value: Number(value) };
      await adminPost('/api/admin/promotions', {
        name,
        type,
        valid_from: new Date(validFrom).toISOString(),
        valid_to: new Date(validTo).toISOString(),
        priority: rows.length + 1,
        conditions,
      });
      setName('');
      setValue('');
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name, type, validFrom, validTo, value, rows.length, loadFirstPage]);

  const toggleActive = useCallback(
    async (row: PromotionRow) => {
      setError(null);
      try {
        await adminPatch(`/api/admin/promotions/${row.id}`, { is_active: !row.is_active });
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const deactivate = useCallback(
    async (row: PromotionRow) => {
      setError(null);
      try {
        await adminDelete(`/api/admin/promotions/${row.id}`);
        setStatus(`Deactivated ${row.name}`);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const move = useCallback(
    async (index: number, delta: number) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const ordered = rows.map((row) => row.id);
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved!);
      setError(null);
      try {
        await adminPost('/api/admin/promotions', { action: 'reorder', ordered_ids: ordered });
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [rows, loadFirstPage],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Promotions</h1>
      <PricingNav current="/admin/promotions" />

      {error && (
        <p role="alert" data-testid="promotions-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {status && <p data-testid="promotions-status">{status}</p>}

      <section style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0' }}>
        <select
          aria-label="Filter by active"
          value={activeFilter}
          onChange={(event) => setActiveFilter(event.target.value)}
        >
          <option value="">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
        <select
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">All types</option>
          {PROMOTION_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}
      >
        <input
          aria-label="New promotion name"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select aria-label="Promotion type" value={type} onChange={(event) => setType(event.target.value)}>
          {PROMOTION_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <label>
          From
          <input
            type="datetime-local"
            aria-label="Valid from"
            value={validFrom}
            onChange={(event) => setValidFrom(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            aria-label="Valid to"
            value={validTo}
            onChange={(event) => setValidTo(event.target.value)}
          />
        </label>
        <input
          aria-label="Condition value"
          placeholder="value"
          style={{ width: 72 }}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" data-testid="promotion-submit">
          Add promotion
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="promotion-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="right">Priority</th>
              <th align="left">Name</th>
              <th align="left">Type</th>
              <th align="left">Window</th>
              <th align="left">Active</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} data-testid={`promotion-${row.id}`}>
                <td align="right">
                  <button type="button" aria-label={`Move ${row.name} up`} onClick={() => void move(index, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${row.name} down`} onClick={() => void move(index, 1)}>
                    ↓
                  </button>
                  {row.priority}
                </td>
                <td>{row.name}</td>
                <td>{row.type}</td>
                <td>
                  {toLocalInput(row.valid_from)} → {toLocalInput(row.valid_to)}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Active ${row.name}`}
                    checked={row.is_active}
                    onChange={() => void toggleActive(row)}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => void deactivate(row)}>
                    Deactivate
                  </button>
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
