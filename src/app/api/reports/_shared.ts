import { ApiError } from '../_lib';
import type { AuthClaims } from '@/core/auth';

/**
 * The shared pieces of the report routes.
 *
 * Every report reads its figures from SQL (app.report_*). The route only resolves the period and the
 * branch, so a branch page and the cloud owner console use the same endpoint: the figures come from
 * the same functions, and the console's data is the branch's synced data (ADR-0049).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: string, field: string): string {
  if (!DATE_RE.test(value)) {
    throw new ApiError(422, `${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

/** The default period is the current calendar month. */
export function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** Parse `from`/`to` from the query string, defaulting to the current month. */
export function parsePeriod(searchParams: URLSearchParams): { from: string; to: string } {
  const defaults = currentMonth();
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const period = {
    from: from === null ? defaults.from : isoDate(from, 'from'),
    to: to === null ? defaults.to : isoDate(to, 'to'),
  };
  if (period.from > period.to) {
    throw new ApiError(422, 'from must not be after to');
  }
  return period;
}

/**
 * Resolve the branch a report reads. It defaults to the caller's first branch. An explicit
 * `branch_id` is allowed only when the token scopes it, so an owner who is a member of several
 * branches can switch between them on the console and nobody can read another branch's report.
 */
export function resolveBranchId(searchParams: URLSearchParams, claims: AuthClaims): string {
  const requested = searchParams.get('branch_id');
  const fallback = claims.branchIds[0];
  const branchId = requested ?? fallback;
  if (!branchId) {
    throw new ApiError(422, 'no branch is in scope for this request');
  }
  if (!claims.branchIds.includes(branchId)) {
    throw new ApiError(403, 'the token does not scope this branch');
  }
  return branchId;
}
