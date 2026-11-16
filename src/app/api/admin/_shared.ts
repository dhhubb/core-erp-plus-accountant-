import { ApiError } from '../_lib';
import type { AuthClaims } from '@/core/auth';

/**
 * The shared pieces of the admin routes.
 *
 * Every admin read/write runs as the caller, so RLS scopes the rows. These helpers only resolve the
 * org the token names and refuse a body that names another org, so an admin cannot act on a tenant
 * the token does not scope (test 27, ADR-0052).
 */

/** The org the token is scoped to, or a 403 when the token carries none. */
export function requireOrg(claims: AuthClaims): string {
  if (!claims.orgId) {
    throw new ApiError(403, 'the token does not scope an organisation');
  }
  return claims.orgId;
}

/** Refuse a body naming an org the token does not scope. */
export function assertSameOrg(claims: AuthClaims, orgId: string | undefined): void {
  if (orgId !== undefined && orgId !== claims.orgId) {
    throw new ApiError(403, 'the token does not scope this org');
  }
}

/**
 * Run an admin write and translate a client-side SQL error into a 422.
 *
 * A duplicate barcode (the partial unique index on product_variants) or a duplicate slug/SKU is a
 * client error, not a server fault. So is a value the SQL guards reject: a barcode that fails the
 * EAN-13 check digit, or a weighable product in `each` (SQLSTATE 22023). The database is the source
 * of truth for the constraint, so the route does not pre-check; it just reports the conflict.
 */
export async function withWriteErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      throw new ApiError(422, 'that value already exists for this org');
    }
    if (code === '22023') {
      throw new ApiError(422, (error as Error).message);
    }
    throw error;
  }
}
