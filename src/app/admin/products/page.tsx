'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { filtersToQuery, useProductFilters } from '@/verticals/admin/filters';
import { WeighableToggle } from '@/verticals/admin/WeighableToggle';
import type { CategoryNode, ProductUnit } from '@/verticals/admin/types';

/**
 * /admin/products — the product list and create form.
 *
 * The list is a keyset page (created_at, id): "Load more" asks for the next page with the cursor
 * the previous page returned, never an offset. The filters (category, weighable, search) live in a
 * Zustand store and are re-applied by the server. The SKU is assigned by SQL from the number
 * series, so the form never asks for one.
 */

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  unit: ProductUnit;
  is_weighable: boolean;
  is_active: boolean;
  variant_count: number;
  created_at: string;
  updated_at: string;
}

interface ProductListResponse {
  products: ProductRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

export default function ProductsPage() {
  const filters = useProductFilters();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [isWeighable, setIsWeighable] = useState(false);
  const [unit, setUnit] = useState<ProductUnit>('each');

  useEffect(() => {
    void adminGet<{ categories: CategoryNode[] }>('/api/admin/categories')
      .then((payload) => setCategories(payload.categories))
      .catch((err: Error) => setError(err.message));
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = filtersToQuery({
        categoryId: filters.categoryId,
        isWeighable: filters.isWeighable,
        query: filters.query,
      });
      const payload = await adminGet<ProductListResponse>(
        `/api/admin/products${query ? `?${query}` : ''}`,
      );
      setRows(payload.products);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters.categoryId, filters.isWeighable, filters.query]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const query = filtersToQuery({
      categoryId: filters.categoryId,
      isWeighable: filters.isWeighable,
      query: filters.query,
    });
    const path = `/api/admin/products${query ? `?${query}` : ''}`;
    const payload = await adminGet<ProductListResponse>(withCursor(path, cursor));
    setRows((current) => [...current, ...payload.products]);
    setCursor(payload.next_cursor);
  }, [cursor, filters.categoryId, filters.isWeighable, filters.query]);

  const create = useCallback(async () => {
    setError(null);
    try {
      await adminPost('/api/admin/products', {
        name,
        category_id: categoryId,
        unit,
        is_weighable: isWeighable,
      });
      setName('');
      setCategoryId(null);
      setIsWeighable(false);
      setUnit('each');
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name, categoryId, unit, isWeighable, loadFirstPage]);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Products</h1>

      {error && (
        <p role="alert" data-testid="products-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <section style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <input
          aria-label="Search products"
          placeholder="Search"
          value={filters.query}
          onChange={(event) => filters.setQuery(event.target.value)}
        />
        <select
          aria-label="Filter by category"
          value={filters.categoryId ?? ''}
          onChange={(event) => filters.setCategoryId(event.target.value || null)}
        >
          <option value="">All categories</option>
          {categories.map((node) => (
            <option key={node.id} value={node.id}>
              {node.path}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            aria-label="Weighable only"
            checked={filters.isWeighable === true}
            onChange={(event) => filters.setIsWeighable(event.target.checked ? true : null)}
          />
          Weighable only
        </label>
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}
      >
        <input
          aria-label="New product name"
          placeholder="New product name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="New product category"
          value={categoryId ?? ''}
          onChange={(event) => setCategoryId(event.target.value || null)}
        >
          <option value="">— no category —</option>
          {categories.map((node) => (
            <option key={node.id} value={node.id}>
              {node.path}
            </option>
          ))}
        </select>
        <WeighableToggle
          isWeighable={isWeighable}
          unit={unit}
          onChange={({ isWeighable: nextWeighable, unit: nextUnit }) => {
            setIsWeighable(nextWeighable);
            setUnit(nextUnit);
          }}
        />
        <button type="submit" data-testid="product-submit">
          Add product
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="product-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">SKU</th>
              <th align="left">Name</th>
              <th align="left">Unit</th>
              <th align="left">Variants</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`product-${row.sku}`}>
                <td>
                  <code>{row.sku}</code>
                </td>
                <td>{row.name}</td>
                <td>{row.unit}</td>
                <td>{row.variant_count}</td>
                <td>
                  <Link href={`/admin/products/${row.id}/variants`}>Variants</Link>
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
