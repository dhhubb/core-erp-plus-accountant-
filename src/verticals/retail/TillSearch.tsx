'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { debounce, SEARCH_DEBOUNCE_MS } from './debounce';
import type { ProductSearchRow } from './products';

interface ApiResult {
  query: string;
  limit: number;
  results: Array<{
    product_id: string;
    variant_id: string;
    product_name: string;
    variant_name: string;
    sku: string;
    barcode: string | null;
    category_id: string | null;
    unit: string;
    is_weighable: boolean;
    match_type: 'barcode' | 'name';
    score: number;
  }>;
}

export interface TillSearchProps {
  /** Bearer token for the caller's org. The route scopes results by RLS. */
  accessToken: string;
  onSelect?: (row: ProductSearchRow) => void;
}

/**
 * Till search box. Types are debounced by SEARCH_DEBOUNCE_MS, so one request goes out after the
 * cashier stops typing. Nothing is fetched on mount: the catalogue is never loaded up front.
 */
export function TillSearch({ accessToken, onSelect }: TillSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSearchRow[]>([]);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (value: string) => {
      if (value.trim() === '') {
        setResults([]);
        return;
      }
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      setPending(true);
      try {
        const response = await fetch(`/api/pos/search?q=${encodeURIComponent(value)}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: next.signal,
        });
        if (!response.ok) throw new Error(`search failed: ${response.status}`);
        const body = (await response.json()) as ApiResult;
        setResults(
          body.results.map((row) => ({
            productId: row.product_id,
            variantId: row.variant_id,
            productName: row.product_name,
            variantName: row.variant_name,
            sku: row.sku,
            barcode: row.barcode,
            categoryId: row.category_id,
            unit: row.unit,
            isWeighable: row.is_weighable,
            matchType: row.match_type,
            score: row.score,
          })),
        );
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setResults([]);
      } finally {
        setPending(false);
      }
    },
    [accessToken],
  );

  const debouncedSearch = useMemo(() => debounce(runSearch, SEARCH_DEBOUNCE_MS), [runSearch]);

  useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

  return (
    <div className="till-search">
      <label htmlFor="till-search-input">Search products</label>
      <input
        id="till-search-input"
        type="search"
        value={query}
        autoComplete="off"
        placeholder="Scan a barcode or type a name"
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          debouncedSearch(value);
        }}
      />
      {pending ? <p role="status">Searching…</p> : null}
      <ul>
        {results.map((row) => (
          <li key={row.variantId}>
            <button type="button" onClick={() => onSelect?.(row)}>
              {row.productName}
              {row.variantName ? ` — ${row.variantName}` : ''}
              {row.isWeighable ? ' (weighable)' : ''}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
