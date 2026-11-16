'use client';

import { create } from 'zustand';
import { EMPTY_PRODUCT_FILTERS, type ProductFilters } from './types';

/**
 * The admin product filters. Zustand keeps them so the list, the create form and the search box
 * share one source of truth without prop-drilling, and the filters survive a client navigation.
 */
interface ProductFilterState extends ProductFilters {
  setCategoryId: (categoryId: string | null) => void;
  setIsWeighable: (isWeighable: boolean | null) => void;
  setQuery: (query: string) => void;
  reset: () => void;
}

export const useProductFilters = create<ProductFilterState>((set) => ({
  ...EMPTY_PRODUCT_FILTERS,
  setCategoryId: (categoryId) => set({ categoryId }),
  setIsWeighable: (isWeighable) => set({ isWeighable }),
  setQuery: (query) => set({ query }),
  reset: () => set({ ...EMPTY_PRODUCT_FILTERS }),
}));

/** Serialise the filters into the query string the list endpoint reads. */
export function filtersToQuery(filters: ProductFilters): string {
  const params = new URLSearchParams();
  if (filters.categoryId) params.set('category_id', filters.categoryId);
  if (filters.isWeighable !== null) params.set('is_weighable', String(filters.isWeighable));
  if (filters.query.trim() !== '') params.set('q', filters.query.trim());
  return params.toString();
}
