import Decimal from 'decimal.js';

/** Quantities are NUMERIC(19,4). Weighable items carry a decimal; everything else is whole units. */
export const QUANTITY_SCALE = 4;

export class QuantityError extends Error {}

/**
 * Normalise a till quantity to a NUMERIC(19,4) string.
 *
 * A weighable product (sold by kg, g, l, ml) accepts a decimal quantity, for example 0.750 kg.
 * A product sold by the unit accepts a positive whole number only. Either way the value must be
 * greater than zero.
 */
export function normaliseQuantity(isWeighable: boolean, qty: Decimal.Value): string {
  let value: Decimal;
  try {
    value = new Decimal(qty);
  } catch {
    throw new QuantityError(`quantity is not a number: ${String(qty)}`);
  }

  if (!value.isFinite()) {
    throw new QuantityError('quantity must be a finite number');
  }
  if (value.lte(0)) {
    throw new QuantityError('quantity must be greater than zero');
  }
  if (!isWeighable && !value.isInteger()) {
    throw new QuantityError('this product is sold in whole units only');
  }

  const rounded = value.toDecimalPlaces(QUANTITY_SCALE, Decimal.ROUND_HALF_UP);
  if (rounded.lte(0)) {
    throw new QuantityError('quantity rounds to zero at four decimal places');
  }
  return rounded.toFixed(QUANTITY_SCALE);
}
