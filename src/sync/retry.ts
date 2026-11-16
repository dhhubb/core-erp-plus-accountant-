/**
 * Retry policy for the sync engine (H2).
 *
 * A network failure (the cloud is unreachable, a request times out, a 5xx) is never a conflict: the
 * branch retries it forever with exponential backoff and full jitter, capped at 5 minutes. Only a
 * REJECTION from the cloud — a 4xx that names the event — is a conflict.
 */

/** Backoff cap: 5 minutes. */
export const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

/** The first backoff step. */
export const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Exponential backoff with full jitter. `attempt` is 1 for the first retry. Jitter is applied so
 * that many branches coming back after an outage do not retry in lockstep.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (safeAttempt - 1));
  // Full jitter: a uniform draw in [0, exponential].
  return Math.floor(random() * exponential);
}

/**
 * A network/transport failure. The branch retries these forever; they are never recorded as
 * conflicts.
 */
export class SyncNetworkError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'SyncNetworkError';
  }
}

/** A 5xx or an unexpected server condition: retryable, not a conflict. */
export class SyncServerError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'SyncServerError';
  }
}

/**
 * The cloud refused the batch. `rejects` names the events the cloud will never accept, so the
 * branch logs them as conflicts and acks past them instead of retrying forever.
 */
export class SyncRejectionError extends Error {
  readonly retryable = false;
  readonly rejects: import('./types').SyncReject[];

  constructor(message: string, rejects: import('./types').SyncReject[]) {
    super(message);
    this.name = 'SyncRejectionError';
    this.rejects = rejects;
  }
}

/** A conflict the branch records, after the cloud really rejected an event. */
export interface SyncConflict {
  eventId: string;
  branchSeq: number;
  eventType: string;
  reason: string;
  detail: Record<string, unknown>;
}

/** True when the error is one the branch should retry (never a conflict). */
export function isRetryable(error: unknown): boolean {
  return (error as { retryable?: boolean })?.retryable === true;
}
