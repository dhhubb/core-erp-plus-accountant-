/**
 * The push worker: branch -> cloud.
 *
 * One batch is read from the outbox in sequence order, sent to the cloud, and acked only when the
 * cloud confirms it. The rules:
 *
 *   * Only ONE push is ever in flight per branch, so two ticks cannot deliver the same batch twice.
 *   * A batch is acked up to the highest sequence the cloud applied. A gap is never acked: the
 *     unacked events are re-pushed next tick, and the cloud dedupes them by event id.
 *   * A network failure is retried forever with exponential backoff and jitter (never a conflict).
 *   * A real rejection (a 4xx naming events) is recorded as a conflict, and the branch acks past
 *     the rejected event so it can make progress; the rest of the batch is unaffected.
 */

import type { PoolClient } from 'pg';
import { SYNC_PUSH_BATCH_SIZE, syncTimeoutMs } from './config';
import { ackUpTo, outboxMaxSeq, pendingEvents } from './outbox';
import {
  SyncNetworkError,
  SyncRejectionError,
  SyncServerError,
  isRetryable,
  retryDelayMs,
} from './retry';
import type { PushResponse, SyncReject } from './types';

/** How a batch reaches the cloud. Injectable so the worker can be tested without a live cloud. */
export type PushDeliver = (events: import('./types').SyncOutboxEvent[]) => Promise<PushResponse>;

export interface PushOutcome {
  /** The highest sequence the cloud applied and the branch acked. '0' when nothing was sent. */
  ackedSeq: string;
  sent: number;
  applied: number;
  duplicates: number;
  /** Events the cloud refused, now recorded as conflicts. */
  rejected: SyncReject[];
  /** True when there was nothing to push. */
  idle: boolean;
  /** When the next attempt should run, after a retryable failure. Null on success. */
  retryAtMs: number | null;
}

let inFlight = false;

/** True while a push is running, so a caller can skip a tick. */
export function pushInFlight(): boolean {
  return inFlight;
}

export interface PushContext {
  client: PoolClient;
  orgId: string;
  branchId: string;
  deliver: PushDeliver;
  /** Injected for deterministic tests; defaults to Math.random. */
  random?: () => number;
  /** The attempt number for backoff; the caller keeps this across ticks. */
  attempt?: number;
}

/**
 * Run one push tick. Returns the outcome. On a retryable failure it returns `retryAtMs` and the
 * caller should wait before the next tick; the unacked events stay in the outbox.
 */
export async function pushOnce(ctx: PushContext): Promise<PushOutcome> {
  const idle: PushOutcome = {
    ackedSeq: '0',
    sent: 0,
    applied: 0,
    duplicates: 0,
    rejected: [],
    idle: true,
    retryAtMs: null,
  };

  if (inFlight) return idle;
  const events = await pendingEvents(ctx.client, ctx.orgId, ctx.branchId, SYNC_PUSH_BATCH_SIZE);
  if (events.length === 0) return idle;

  inFlight = true;
  try {
    const response = await ctx.deliver(events);
    const rejected = response.rejects ?? [];

    // Ack up to the highest sequence the cloud applied. A rejected event stops the ack there, so
    // the branch records the conflict and re-pushes from the rejection on the next tick.
    let ackTo = response.highest_seq ?? '0';
    if (rejected.length > 0) {
      const firstRejectedSeq = firstRejectedSeqOf(events, rejected);
      if (firstRejectedSeq !== null) {
        ackTo = highestSeqBelow(events, firstRejectedSeq);
        for (const reject of rejected) {
          await recordConflict(ctx, events, reject);
        }
      }
    }

    const acked = ackTo !== '0' ? await ackUpTo(ctx.client, ctx.orgId, ctx.branchId, ackTo) : 0;

    return {
      ackedSeq: acked > 0 ? ackTo : '0',
      sent: events.length,
      applied: response.applied ?? 0,
      duplicates: response.duplicates ?? 0,
      rejected,
      idle: false,
      retryAtMs: null,
    };
  } catch (error) {
    if (error instanceof SyncRejectionError) {
      // Should be rare: the cloud returns rejects inside a 200. Handled for completeness.
      const ackTo = highestSeqBelow(events, firstRejectedSeqOf(events, error.rejects) ?? '0');
      if (ackTo !== '0') await ackUpTo(ctx.client, ctx.orgId, ctx.branchId, ackTo);
      for (const reject of error.rejects) await recordConflict(ctx, events, reject);
      return { ...idle, idle: false, sent: events.length, rejected: error.rejects, ackedSeq: ackTo };
    }
    if (isRetryable(error)) {
      const attempt = (ctx.attempt ?? 0) + 1;
      return {
        ...idle,
        idle: false,
        sent: events.length,
        retryAtMs: Date.now() + retryDelayMs(attempt, ctx.random),
      };
    }
    throw error;
  } finally {
    inFlight = false;
  }
}

async function recordConflict(
  ctx: PushContext,
  events: import('./types').SyncOutboxEvent[],
  reject: SyncReject,
): Promise<void> {
  const event = events.find((candidate) => candidate.event_id === reject.event_id);
  await ctx.client.query(
    'select app.sync_record_conflict($1, $2, $3, $4, $5, $6, $7::jsonb)',
    [
      ctx.orgId,
      ctx.branchId,
      reject.event_id,
      event ? event.seq : '0',
      event ? event.event_type : 'unknown',
      reject.reason,
      JSON.stringify({}),
    ],
  );
}

function firstRejectedSeqOf(
  events: import('./types').SyncOutboxEvent[],
  rejects: SyncReject[],
): string | null {
  const ids = new Set(rejects.map((reject) => reject.event_id));
  const first = events.find((event) => ids.has(event.event_id));
  return first ? first.seq : null;
}

/** The highest sequence in `events` strictly below `seq`. '0' when none is below. */
function highestSeqBelow(events: import('./types').SyncOutboxEvent[], seq: string): string {
  let best = '0';
  for (const event of events) {
    if (compareSeq(event.seq, seq) < 0 && compareSeq(event.seq, best) > 0) {
      best = event.seq;
    }
  }
  return best;
}

/** Compare two bigint-as-string sequence numbers without losing precision. */
export function compareSeq(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export { SyncNetworkError, SyncServerError, SyncRejectionError };
export { outboxMaxSeq };
export { syncTimeoutMs };
