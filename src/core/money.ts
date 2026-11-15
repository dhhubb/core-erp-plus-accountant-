import Decimal from 'decimal.js';

/**
 * Money is NUMERIC(19,4) in Postgres. In TypeScript it is always a decimal, never a number.
 */
export const MONEY_SCALE = 4;

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;

export function money(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/** Serialise money for a NUMERIC(19,4) column. Always a fixed-scale string. */
export function moneyToSql(value: Decimal.Value): string {
  return money(value).toFixed(MONEY_SCALE);
}

/** Parse a NUMERIC value returned by pg (pg returns numeric as string to preserve precision). */
export function moneyFromSql(value: string | null): Decimal {
  return money(value ?? '0');
}

export function sumMoney(values: readonly Decimal.Value[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(money(value)), new Decimal(0));
}

export function isZero(value: Decimal.Value): boolean {
  return new Decimal(value).isZero();
}
