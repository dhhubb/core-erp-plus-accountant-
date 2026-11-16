/**
 * EAN-13 validation, the application mirror of `app.is_valid_ean13`.
 *
 * A barcode that is exactly 13 digits must carry a valid EAN-13 check digit. Anything else (a
 * short internal code, a 12-digit UPC, an alphanumeric SKU-as-barcode) is accepted as-is, so the
 * R1 and H5 data stays valid. A real EAN-13 is honest (ADR-0051).
 */

/** True when a 13-digit barcode carries a valid EAN-13 check digit, or it is not 13 digits. */
export function isValidEan13(barcode: string | null | undefined): boolean {
  if (barcode === null || barcode === undefined) return false;
  const value = barcode.trim();
  if (!/^[0-9]{13}$/.test(value)) return true;

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = value.charCodeAt(i) - 48;
    // 1-based odd positions count once, even positions count three times.
    sum += (i + 1) % 2 === 1 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === value.charCodeAt(12) - 48;
}

/** The EAN-13 check digit for the first 12 digits of a 13-digit code, or null if not 12 digits. */
export function ean13CheckDigit(first12: string): number | null {
  if (!/^[0-9]{12}$/.test(first12)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = first12.charCodeAt(i) - 48;
    sum += (i + 1) % 2 === 1 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Normalise a scanned barcode: trim, and treat an empty string as "no barcode". */
export function normaliseBarcode(barcode: string | null | undefined): string | null {
  const value = (barcode ?? '').trim();
  return value === '' ? null : value;
}
