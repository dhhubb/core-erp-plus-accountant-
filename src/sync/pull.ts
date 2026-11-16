/**
 * The pull worker: cloud -> branch.
 *
 * The branch fetches the cloud's master-data changes after its stored cursor, in change_seq order,
 * and applies them to its local mirror (public.branch_master_data) through app.sync_apply_pull.
 * The cursor only moves forward: applying a stale batch cannot rewind it (the SQL function uses
 * greatest()).
 *
 * Pulls are idempotent: re-applying a change_seq overwrites the mirror row with the same values and
 * re-sets the same cursor.
 */

import type { PoolClient } from 'pg';
import { SYNC_PULL_BATCH_SIZE } from './config';
import { isRetryable, retryDelayMs } from './retry';
import type { MasterDataChange } from './types';

/** How a pull reaches the cloud. Injectable so the worker can be tested without a live cloud. */
export type PullDeliver = (sinceSeq: string) => Promise<{ changes: MasterDataChange[] }>;

export interface PullOutcome {
  /** The cursor after this tick (the highest change_seq applied). */
  cursor: string;
  applied: number;
  idle: boolean;
  retryAtMs: number | null;
}

export interface PullContext {
  client: PoolClient;
  orgId: string;
  branchId: string;
  sinceSeq: string;
  deliver: PullDeliver;
  random?: () => number;
  attempt?: number;
}

/** Read the stored pull cursor. */
export async function storedCursor(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<string> {
  const result = await client.query<{ cursor: string | null }>(
    `select s ->> 'last_pulled_cursor' as cursor
       from (select app.branch_sync_state($1, $2) as s) t`,
    [orgId, branchId],
  );
  return result.rows[0]?.cursor ?? '0';
}

/** Run one pull tick and apply the batch. */
export async function pullOnce(ctx: PullContext): Promise<PullOutcome> {
  const idle: PullOutcome = { cursor: ctx.sinceSeq, applied: 0, idle: true, retryAtMs: null };

  let response: { changes: MasterDataChange[] };
  try {
    response = await ctx.deliver(ctx.sinceSeq);
  } catch (error) {
    if (isRetryable(error)) {
      const attempt = (ctx.attempt ?? 0) + 1;
      return { ...idle, retryAtMs: Date.now() + retryDelayMs(attempt, ctx.random) };
    }
    throw error;
  }

  const changes = response.changes ?? [];
  if (changes.length === 0) return idle;

  // Apply in change_seq order. The SQL function sorts again and advances the cursor with greatest(),
  // so out-of-order delivery cannot rewind it.
  const sorted = [...changes].sort((a, b) => compareSeq(a.change_seq, b.change_seq));
  const result = await ctx.client.query<{ app: { applied: number; cursor: number | string } }>(
    'select app.sync_apply_pull($1, $2, $3::jsonb) as app',
    [ctx.orgId, ctx.branchId, JSON.stringify(sorted)],
  );
  const applied = result.rows[0]!.app;

  return {
    cursor: String(applied.cursor ?? ctx.sinceSeq),
    applied: applied.applied ?? 0,
    idle: false,
    retryAtMs: null,
  };
}

/** Compare two bigint-as-string sequence numbers without losing precision. */
export function compareSeq(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export { SYNC_PULL_BATCH_SIZE };
