import type Decimal from 'decimal.js';
import type { PageCursor } from '@/core/sales';

/** The product units the admin may pick. `each` is the only unit a non-weighable product uses. */
export const PRODUCT_UNITS = ['each', 'kg', 'g', 'l', 'ml', 'pack'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/** The units a weighable product may use (a measure unit, never `each`). */
export const WEIGHABLE_UNITS: readonly ProductUnit[] = ['kg', 'g', 'l', 'ml'];

export function isProductUnit(value: string): value is ProductUnit {
  return (PRODUCT_UNITS as readonly string[]).includes(value);
}

/** A node of the category tree. `path` is the name path, depth-first ordered. */
export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  depth: number;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  categoryId: string | null;
  unit: ProductUnit;
  isWeighable: boolean;
  isActive: boolean;
  variantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductPage {
  rows: ProductRow[];
  nextCursor: PageCursor | null;
}

/** A till-style search hit for the admin (exact barcode first, then a name match), max 50. */
export interface AdminSearchRow {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  categoryId: string | null;
  unit: ProductUnit;
  isWeighable: boolean;
  matchType: 'barcode' | 'name';
  score: number;
}

export interface VariantRow {
  id: string;
  productId: string;
  sku: string;
  name: string;
  size: string | null;
  color: string | null;
  barcode: string | null;
  cost: Decimal | null;
  qtyOnHand: Decimal;
  createdAt: string;
  updatedAt: string;
}

export interface VariantPage {
  rows: VariantRow[];
  nextCursor: PageCursor | null;
}

export interface BatchRow {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  batchNo: string;
  expiryDate: string | null;
  daysToExpiry: number | null;
  createdAt: string;
}

export interface BatchPage {
  rows: BatchRow[];
  nextCursor: PageCursor | null;
}

/** The product filters the admin list holds. Zustand keeps them; the server re-applies them. */
export interface ProductFilters {
  categoryId: string | null;
  isWeighable: boolean | null;
  query: string;
}

export const EMPTY_PRODUCT_FILTERS: ProductFilters = {
  categoryId: null,
  isWeighable: null,
  query: '',
};

// ---------------------------------------------------------------------------
// A2: pricing console types
// ---------------------------------------------------------------------------

export const PRICE_LIST_KINDS = ['retail', 'wholesale'] as const;
export type PriceListKind = (typeof PRICE_LIST_KINDS)[number];

export function isPriceListKind(value: string): value is PriceListKind {
  return (PRICE_LIST_KINDS as readonly string[]).includes(value);
}

export const PRICE_LIST_CURRENCIES = ['USD', 'ZAR', 'ZWG'] as const;
export type PriceListCurrency = (typeof PRICE_LIST_CURRENCIES)[number];

export function isPriceListCurrency(value: string): value is PriceListCurrency {
  return (PRICE_LIST_CURRENCIES as readonly string[]).includes(value);
}

export const PROMOTION_TYPES = ['bogo', 'percent', 'fixed'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export function isPromotionType(value: string): value is PromotionType {
  return (PROMOTION_TYPES as readonly string[]).includes(value);
}

export interface PriceListRow {
  id: string;
  name: string;
  kind: PriceListKind;
  currency: string;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PriceListItemRow {
  id: string;
  priceListId: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  price: Decimal;
  cost: Decimal | null;
  margin: Decimal | null;
  marginPercent: Decimal | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerGroupRow {
  id: string;
  name: string;
  priceListId: string | null;
  priceListName: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export interface PromotionRow {
  id: string;
  name: string;
  type: PromotionType;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  priority: number;
  stackable: boolean;
  conditions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One line of the precedence breakdown shown on /admin/pricing-preview. */
export interface PricePreviewStep {
  step: number;
  name: string;
  detail: string;
  amount: Decimal;
  sourceId: string | null;
  limit: Decimal | null;
}

export interface PricePreview {
  variantId: string;
  currency: string;
  listPrice: Decimal;
  unitPrice: Decimal;
  discount: Decimal;
  sourcePriceListId: string | null;
  sourcePriceListName: string | null;
  sourcePriceListKind: string | null;
  sourcePromotionId: string | null;
  sourcePromotionName: string | null;
  manualDiscount: Decimal;
  manualMaxAmount: Decimal;
  effectivePrice: Decimal;
  steps: PricePreviewStep[];
}
