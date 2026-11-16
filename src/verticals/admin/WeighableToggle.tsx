'use client';

import { useEffect } from 'react';
import { WEIGHABLE_UNITS, type ProductUnit } from './types';

/**
 * The weighable toggle for a product.
 *
 * When on, the product is sold by weight or volume: the unit is forced to a measure unit (kg, g,
 * l or ml, never `each`) and the quantity input accepts a NUMERIC(19,4) decimal. When off, the
 * product is sold in whole units and the unit is `each`.
 *
 * The component owns both the flag and the unit together, so the two can never disagree (the SQL
 * `products_weighable_unit_check` enforces the same rule).
 */
export interface WeighableToggleProps {
  isWeighable: boolean;
  unit: ProductUnit;
  onChange: (next: { isWeighable: boolean; unit: ProductUnit }) => void;
  /** A test seam: renders the quantity input so a test can assert its step/precision. */
  quantity?: string;
  onQuantityChange?: (quantity: string) => void;
}

export function WeighableToggle({
  isWeighable,
  unit,
  onChange,
  quantity,
  onQuantityChange,
}: WeighableToggleProps) {
  // Keep the unit consistent with the flag whenever it is toggled on.
  useEffect(() => {
    if (isWeighable && unit === 'each') {
      onChange({ isWeighable: true, unit: 'kg' });
    }
    if (!isWeighable && unit !== 'each') {
      onChange({ isWeighable: false, unit: 'each' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWeighable]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input
          type="checkbox"
          data-testid="weighable-toggle"
          checked={isWeighable}
          onChange={(event) => {
            const next = event.target.checked;
            onChange({ isWeighable: next, unit: next ? (unit === 'each' ? 'kg' : unit) : 'each' });
          }}
        />
        Weighable
      </label>

      <select
        data-testid="unit-select"
        aria-label="Unit"
        value={unit}
        onChange={(event) => onChange({ isWeighable, unit: event.target.value as ProductUnit })}
      >
        {(isWeighable ? WEIGHABLE_UNITS : (['each', 'pack'] as const)).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      {quantity !== undefined && onQuantityChange && (
        <input
          type="text"
          inputMode="decimal"
          data-testid="quantity-input"
          aria-label="Quantity"
          value={quantity}
          placeholder={isWeighable ? '0.0000' : '1'}
          onChange={(event) => onQuantityChange(event.target.value)}
          style={{ width: 96 }}
        />
      )}
    </span>
  );
}
