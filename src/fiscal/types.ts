/**
 * Fiscal integration adapter — shared types.
 *
 * The adapter is queue-only. A sale appends at most one job row; a worker delivers jobs later.
 * There is no blocking mode in this run (ADR-0022): whether ZIMRA requires printing at the moment
 * of sale is an open item, so the mode is only 'none' or 'async'.
 */

/** Per-branch integration mode. 'blocking' is deliberately absent (ADR-0022). */
export const FISCAL_MODES = ['none', 'async'] as const;
export type FiscalMode = (typeof FISCAL_MODES)[number];

/** Device kinds. 'none' means no device is configured for the branch. */
export const FISCAL_DEVICE_TYPES = ['none', 'zimra_fdms', 'generic_http'] as const;
export type FiscalDeviceType = (typeof FISCAL_DEVICE_TYPES)[number];

/** Device operational state. */
export const FISCAL_DEVICE_STATUSES = ['active', 'inactive', 'error'] as const;
export type FiscalDeviceStatus = (typeof FISCAL_DEVICE_STATUSES)[number];

/** What a delivery attempt concluded. */
export const FISCAL_ATTEMPT_OUTCOMES = ['sent', 'failed', 'unreachable'] as const;
export type FiscalAttemptOutcome = (typeof FISCAL_ATTEMPT_OUTCOMES)[number];

export interface FiscalIntegration {
  id: string;
  orgId: string;
  branchId: string;
  deviceType: FiscalDeviceType;
  mode: FiscalMode;
  status: FiscalDeviceStatus;
  lastSync: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** A queued job as the worker sees it. */
export interface FiscalJob {
  jobId: string;
  saleId: string;
  invoiceId: string | null;
  /** How many delivery attempts have already been recorded. */
  attempts: number;
  /** When the backoff allows the next attempt. */
  nextAttemptAt: string;
  payload: Record<string, unknown>;
}

/** The result of one delivery attempt, as returned by a transport. */
export interface FiscalSendResult {
  outcome: FiscalAttemptOutcome;
  error?: string | null;
}

/**
 * A device transport. The worker depends on this interface, never on a specific device, so the
 * queue can be exercised with an unreachable transport without any network call.
 */
export interface FiscalTransport {
  send(job: FiscalJob): Promise<FiscalSendResult>;
}
