import type { PoolClient } from 'pg';
import {
  FISCAL_DEVICE_STATUSES,
  FISCAL_DEVICE_TYPES,
  FISCAL_MODES,
  type FiscalDeviceStatus,
  type FiscalDeviceType,
  type FiscalIntegration,
  type FiscalMode,
} from './types';

/**
 * The fiscal adapter. It is queue-only: the only work it does on a sale is append one job row,
 * and only when the branch mode is 'async'. There is no network call and no wait on the sale path
 * (ADR-0022). Delivery happens later, in the worker (`src/fiscal/worker.ts`).
 *
 * The sale path itself does not call this module: a trigger on `pos_sales`
 * (`app.fiscal_enqueue_on_sale`) performs the enqueue in the same transaction, so a committed sale
 * has queued its job or has none to queue. `enqueueFiscalJob` is the same operation exposed for
 * backfill and for callers that already hold the sale row; it is idempotent per sale.
 */

function assertMode(value: string): FiscalMode {
  if (!FISCAL_MODES.includes(value as FiscalMode)) {
    throw new Error(`unknown fiscal mode ${value}`);
  }
  return value as FiscalMode;
}

function assertDeviceType(value: string): FiscalDeviceType {
  if (!FISCAL_DEVICE_TYPES.includes(value as FiscalDeviceType)) {
    throw new Error(`unknown fiscal device type ${value}`);
  }
  return value as FiscalDeviceType;
}

function assertDeviceStatus(value: string): FiscalDeviceStatus {
  if (!FISCAL_DEVICE_STATUSES.includes(value as FiscalDeviceStatus)) {
    throw new Error(`unknown fiscal device status ${value}`);
  }
  return value as FiscalDeviceStatus;
}

interface RawIntegration {
  id: string;
  org_id: string;
  branch_id: string;
  device_type: string;
  mode: string;
  status: string;
  last_sync: Date | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

function toIntegration(raw: RawIntegration): FiscalIntegration {
  return {
    id: raw.id,
    orgId: raw.org_id,
    branchId: raw.branch_id,
    deviceType: assertDeviceType(raw.device_type),
    mode: assertMode(raw.mode),
    status: assertDeviceStatus(raw.status),
    lastSync: raw.last_sync ? raw.last_sync.toISOString() : null,
    payload: raw.payload,
    createdAt: raw.created_at.toISOString(),
  };
}

/** The branch's fiscal integration row, or null when the branch has none (mode is effectively none). */
export async function getFiscalIntegration(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<FiscalIntegration | null> {
  const result = await client.query<RawIntegration>(
    `select id, org_id, branch_id, device_type, mode, status, last_sync, payload, created_at
       from public.fiscal_device_integration
      where org_id = $1 and branch_id = $2`,
    [input.orgId, input.branchId],
  );
  const row = result.rows[0];
  return row ? toIntegration(row) : null;
}

/** Create or replace the branch's fiscal integration. One row per branch. */
export async function setFiscalIntegration(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    deviceType?: FiscalDeviceType;
    mode?: FiscalMode;
    status?: FiscalDeviceStatus;
    payload?: Record<string, unknown>;
  },
): Promise<FiscalIntegration> {
  const result = await client.query<RawIntegration>(
    `insert into public.fiscal_device_integration
       (org_id, branch_id, device_type, mode, status, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (org_id, branch_id) do update
       set device_type = excluded.device_type,
           mode        = excluded.mode,
           status      = excluded.status,
           payload     = excluded.payload,
           updated_at  = now()
     returning id, org_id, branch_id, device_type, mode, status, last_sync, payload, created_at`,
    [
      input.orgId,
      input.branchId,
      input.deviceType ?? 'none',
      input.mode ?? 'none',
      input.status ?? 'active',
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return toIntegration(result.rows[0]!);
}

/**
 * Queue one fiscal job for a sale. Returns the job id, or null when the branch mode is not 'async'
 * (or the branch has no integration at all). Idempotent per (org_id, sale_id): a retried sale
 * cannot queue a second job.
 */
export async function enqueueFiscalJob(
  client: PoolClient,
  input: { orgId: string; branchId: string; saleId: string; invoiceId?: string | null },
): Promise<string | null> {
  const result = await client.query<{ app: string | null }>(
    `select app.enqueue_fiscal_job($1, $2, $3, $4) as app`,
    [input.orgId, input.branchId, input.saleId, input.invoiceId ?? null],
  );
  return result.rows[0]!.app;
}

/** How many jobs are queued (not yet sent) for a branch. Read-only; used by tests and ops views. */
export async function countQueuedFiscalJobs(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n
       from public.fiscal_jobs
      where org_id = $1 and branch_id = $2 and status = 'queued'`,
    [input.orgId, input.branchId],
  );
  return Number(result.rows[0]!.n);
}
