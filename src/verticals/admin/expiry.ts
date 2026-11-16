/**
 * Expiry colouring for a batch. Pure, so the page and a test share one rule.
 */
export type ExpiryTone = 'expired' | 'soon' | 'ok' | 'none';

/** The colour band for a batch by its days to expiry. Amber within 30 days, red when expired. */
export function expiryTone(days: number | null): ExpiryTone {
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 30) return 'soon';
  return 'ok';
}

/** Days from an ISO date (YYYY-MM-DD) to today, or null when there is no date. */
export function daysToExpiry(expiryDate: string | null, today: Date = new Date()): number | null {
  if (expiryDate === null || expiryDate === '') return null;
  const target = Date.parse(`${expiryDate}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - base) / 86_400_000);
}
