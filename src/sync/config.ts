/**
 * Sync engine configuration (H2).
 *
 * The branch pushes its outbox and pulls master-data changes. These knobs are the batch sizes and
 * the retry budget; the protocol version lives in `src/branch/config.ts` and is checked before
 * every push.
 */

/** The most events one push may carry. The brief caps a push batch at 500. */
export const SYNC_PUSH_BATCH_SIZE = 500;

/** The most master-data changes one pull may carry. */
export const SYNC_PULL_BATCH_SIZE = 500;

/** How long a push/pull request may take before the branch treats the cloud as unreachable. */
export function syncTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SYNC_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

/** The branch's sync credential (a bearer token carrying the branch's org and branch id). */
export function branchSyncToken(): string | null {
  const token = process.env.BRANCH_SYNC_TOKEN;
  return token && token.trim() !== '' ? token.trim() : null;
}

/** The org and branch this branch server syncs for. */
export function branchIdentity(): { orgId: string | null; branchId: string | null } {
  return {
    orgId: process.env.BRANCH_ORG_ID?.trim() || null,
    branchId: process.env.BRANCH_ID?.trim() || null,
  };
}
