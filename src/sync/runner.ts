/**
 * The branch sync runner: the loop that keeps the branch and the cloud in step.
 *
 * One tick pushes the outbox and then pulls master-data changes. The runner holds the backoff state
 * across ticks, so a retryable failure backs off (exponential, jittered, capped at 5 minutes) and a
 * success resets the counter. The push is gated on the protocol version: a mismatch blocks the push
 * (ADR-0025) so a branch cannot write a shape the cloud does not understand.
 *
 * The runner never throws out of a tick: a tick is a best-effort unit. The caller (a timer, or the
 * branch server) decides when to run the next one.
 */

import type { PoolClient } from 'pg';
import { cloudUrl } from '@/branch/config';
import { deliverPull, deliverPush } from './client';
import { pullOnce, storedCursor } from './pull';
import { pushOnce } from './push';
import { syncTimeoutMs } from './config';

export interface SyncTickResult {
  pushed: number;
  applied: number;
  duplicates: number;
  conflicts: number;
  pulled: number;
  cursor: string;
  pushBlocked: boolean;
  /** When set, the next tick should wait until this time (a retryable failure). */
  retryAtMs: number | null;
  error: string | null;
}

export interface RunnerState {
  pushAttempt: number;
  pullAttempt: number;
}

export function newRunnerState(): RunnerState {
  return { pushAttempt: 0, pullAttempt: 0 };
}

export interface RunnerOptions {
  client: PoolClient;
  orgId: string;
  branchId: string;
  state: RunnerState;
  /** True when the branch must refuse to push (protocol mismatch). */
  pushBlocked?: boolean;
  cloud?: string | null;
  random?: () => number;
  /** Injectable for tests; defaults to the real HTTP transport. */
  deliverPushFn?: typeof deliverPush;
  deliverPullFn?: typeof deliverPull;
}

/** Run one push + pull tick. */
export async function runSyncTick(options: RunnerOptions): Promise<SyncTickResult> {
  const cloud = options.cloud ?? cloudUrl();
  const random = options.random ?? Math.random;
  const pushFn = options.deliverPushFn ?? deliverPush;
  const pullFn = options.deliverPullFn ?? deliverPull;

  const result: SyncTickResult = {
    pushed: 0,
    applied: 0,
    duplicates: 0,
    conflicts: 0,
    pulled: 0,
    cursor: await storedCursor(options.client, options.orgId, options.branchId),
    pushBlocked: options.pushBlocked ?? false,
    retryAtMs: null,
    error: null,
  };

  if (result.pushBlocked) {
    // The cloud is incompatible: do not push. Pull is safe (it only reads master data).
    return result;
  }

  try {
    const push = await pushOnce({
      client: options.client,
      orgId: options.orgId,
      branchId: options.branchId,
      attempt: options.state.pushAttempt,
      random,
      deliver: (events) => pushFn(cloud, options.orgId, options.branchId, events),
    });
    result.pushed = push.sent;
    result.applied = push.applied;
    result.duplicates = push.duplicates;
    result.conflicts = push.rejected.length;
    if (push.retryAtMs) {
      options.state.pushAttempt += 1;
      result.retryAtMs = push.retryAtMs;
    } else {
      options.state.pushAttempt = 0;
    }
  } catch (error) {
    result.error = (error as Error).message;
  }

  try {
    const pull = await pullOnce({
      client: options.client,
      orgId: options.orgId,
      branchId: options.branchId,
      sinceSeq: result.cursor,
      attempt: options.state.pullAttempt,
      random,
      deliver: (sinceSeq) => pullFn(cloud, options.orgId, options.branchId, sinceSeq),
    });
    result.pulled = pull.applied;
    result.cursor = pull.cursor;
    if (pull.retryAtMs) {
      options.state.pullAttempt += 1;
      result.retryAtMs = result.retryAtMs ?? pull.retryAtMs;
    } else {
      options.state.pullAttempt = 0;
    }
  } catch (error) {
    result.error = result.error ?? (error as Error).message;
  }

  return result;
}

export { syncTimeoutMs };
