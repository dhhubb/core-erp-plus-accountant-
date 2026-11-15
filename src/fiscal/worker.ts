import type { PoolClient } from 'pg';
import { getPool } from '@/core/db';
import { applyUserContext, type AuthClaims } from '@/core/auth';
import type { FiscalJob, FiscalTransport } from './types';

/**
 * The fiscal worker. It runs off the sale path: it reads the queued jobs whose backoff has
 * elapsed, asks the transport to deliver each one, and appends one `fiscal_job_attempts` row per
 * attempt. The job row is never updated (ADR-0022); a 'sent' attempt is what marks a job done.
 *
 * Backoff lives in SQL (`app.fiscal_jobs_due`), so the worker and the database agree on when a job
 * is next due. A transport that cannot reach the device reports 'unreachable', and the job simply
 * becomes due again later — it is never dropped and never blocks anything else.
 */

export interface FiscalDrainOptions {
  orgId: string;
  branchId: string;
  /** Claims the drain runs under. Delivery reads only, so a branch member's claims suffice. */
  claims: AuthClaims;
  now?: Date;
  limit?: number;
  baseSeconds?: number;
  maxSeconds?: number;
}

export interface FiscalDrainResult {
  /** Jobs examined this pass. */
  examined: number;
  /** Jobs the transport reported as 'sent'. */
  sent: number;
  /** Jobs that could not be delivered this pass (still queued, retried later). */
  retried: number;
}

interface RawDueJob {
  job_id: string;
  sale_id: string;
  invoice_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date;
}

function toJob(raw: RawDueJob): FiscalJob {
  return {
    jobId: raw.job_id,
    saleId: raw.sale_id,
    invoiceId: raw.invoice_id,
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at.toISOString(),
    payload: raw.payload,
  };
}

/** The queued, due jobs for a branch, oldest first. Read-only. */
export async function dueFiscalJobs(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    now?: Date;
    limit?: number;
    baseSeconds?: number;
    maxSeconds?: number;
  },
): Promise<FiscalJob[]> {
  const result = await client.query<RawDueJob>(
    `select job_id, sale_id, invoice_id, payload, attempts, next_attempt_at
       from app.fiscal_jobs_due($1, $2, $3::timestamptz, $4, $5, $6)`,
    [
      input.orgId,
      input.branchId,
      (input.now ?? new Date()).toISOString(),
      input.limit ?? 50,
      input.baseSeconds ?? 30,
      input.maxSeconds ?? 3600,
    ],
  );
  return result.rows.map(toJob);
}

/**
 * Drain the due jobs once on an open connection. Each job gets one delivery attempt; the attempt
 * row is appended through `app.record_fiscal_attempt`, so an attempt is recorded even when the
 * device is unreachable. The caller owns the transaction.
 */
export async function drainFiscalJobsOn(
  client: PoolClient,
  transport: FiscalTransport,
  options: Omit<FiscalDrainOptions, 'claims'>,
): Promise<FiscalDrainResult> {
  const jobs = await dueFiscalJobs(client, {
    orgId: options.orgId,
    branchId: options.branchId,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.baseSeconds !== undefined ? { baseSeconds: options.baseSeconds } : {}),
    ...(options.maxSeconds !== undefined ? { maxSeconds: options.maxSeconds } : {}),
  });

  let sent = 0;
  let retried = 0;
  for (const job of jobs) {
    const result = await transport.send(job);
    await client.query(`select app.record_fiscal_attempt($1, $2, $3, $4, $5) as app`, [
      options.orgId,
      options.branchId,
      job.jobId,
      result.outcome,
      result.error ?? null,
    ]);
    if (result.outcome === 'sent') {
      sent += 1;
    } else {
      retried += 1;
    }
  }

  return { examined: jobs.length, sent, retried };
}

/**
 * Drain the due jobs once in its own transaction, under the given claims. This is the entry point
 * for a cron or a standalone worker; a request path calls `drainFiscalJobsOn` with its own client.
 */
export async function drainFiscalJobs(
  transport: FiscalTransport,
  options: FiscalDrainOptions,
): Promise<FiscalDrainResult> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await applyUserContext(client, options.claims);
    const result = await drainFiscalJobsOn(client, transport, options);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A transport for a device that cannot be reached. It performs no network call: it reports
 * 'unreachable' every time. This is what the tests use to prove the sale path never depends on the
 * device, and what a real deployment falls back to while a device is down.
 */
export function unreachableTransport(error = 'device unreachable'): FiscalTransport {
  return {
    async send(): Promise<{ outcome: 'unreachable'; error: string }> {
      return { outcome: 'unreachable', error };
    },
  };
}
