import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { ApiError, jsonError, toErrorResponse } from '../_lib';
import { claimsFromAuthorizationHeader, withUserContext, type AuthClaims } from '@/core/auth';
import { parsePeriod, resolveBranchId } from '../reports/_shared';
import { toCsv, type CsvTable } from '@/accounting/export';

/**
 * The shared pieces of the accountant routes. Each report reads its figures from one `app.report_*`
 * function, so the console page and any export use the same numbers (ADR-0065).
 */

export { parsePeriod, resolveBranchId };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as an ISO date, in UTC, so a report default is stable across time zones. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse an `as_of` date, defaulting to today. */
export function parseAsOf(searchParams: URLSearchParams): string {
  const value = searchParams.get('as_of');
  if (value === null) return today();
  if (!DATE_RE.test(value)) throw new ApiError(422, 'as_of must be an ISO date (YYYY-MM-DD)');
  return value;
}

/** True when the caller asked for a CSV download. */
export function wantsCsv(searchParams: URLSearchParams): boolean {
  return searchParams.get('format') === 'csv';
}

function csvResponse(table: CsvTable, filename: string): NextResponse {
  return new NextResponse(toCsv(table), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Resolve the caller's tenant claims and run fn as that user. fn returns either a JSON body or a
 * CSV table (when `format=csv`). A CSV table is serialised with an attachment header; anything else
 * is JSON.
 */
export async function withAccountingAuth(
  request: Request,
  fn: (ctx: {
    client: PoolClient;
    claims: AuthClaims;
    searchParams: URLSearchParams;
  }) => Promise<{ json: unknown } | { csv: CsvTable; filename: string }>,
): Promise<NextResponse> {
  try {
    const claims = claimsFromAuthorizationHeader(request.headers.get('authorization'));
    const searchParams = new URL(request.url).searchParams;
    const result = await withUserContext(claims, (client) =>
      fn({ client, claims, searchParams }),
    );
    if ('csv' in result) return csvResponse(result.csv, result.filename);
    return NextResponse.json(result.json);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** The org id, or a 422 when the token has no membership. */
export function requireOrg(claims: AuthClaims): string {
  if (!claims.orgId) throw new ApiError(422, 'no organisation is in scope for this request');
  return claims.orgId;
}

export { jsonError };
