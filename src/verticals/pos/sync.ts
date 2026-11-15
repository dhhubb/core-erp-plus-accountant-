/**
 * The till's sync loop.
 *
 * Batches up to 50 queued sales per request (the server's cap). Only one sync request is ever in
 * flight per till, so two ticks cannot deliver the same sale twice. An entry is removed only when
 * the server reports it committed or duplicate; anything else stays queued and is retried with
 * exponential backoff and jitter (see outbox.backoffDelay).
 */

import { apiFetch } from './api';
import {
  listPending,
  markAttempt,
  removeSale,
  toSyncPayload,
  type OutboxSale,
} from './outbox';

export const SYNC_BATCH_SIZE = 50;

export type SyncOutcome = 'committed' | 'duplicate' | 'exception';

export interface SyncSaleResult {
  client_sale_id: string;
  outcome: SyncOutcome;
  receipt: unknown;
  exceptions: Array<{ kind: string; detail: unknown }>;
}

export interface SyncReport {
  results: SyncSaleResult[];
  /** Entries that were accepted (committed or duplicate) and removed from the outbox. */
  cleared: number;
  /** Entries that are still queued. */
  remaining: number;
}

/** The wire payload for one queued sale. */
export type SyncSalePayload = ReturnType<typeof toSyncPayload>;

/** How a batch reaches the server. Injectable so the loop can be tested without a live server. */
export type SyncDeliver = (sales: SyncSalePayload[]) => Promise<{ results: SyncSaleResult[] }>;

let inFlight = false;

export function syncInFlight(): boolean {
  return inFlight;
}

const defaultDeliver: SyncDeliver = async (sales) => {
  const response = await apiFetch('/api/pos/sync', {
    method: 'POST',
    body: JSON.stringify({ sales }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `sync failed (${response.status})`);
  }
  return (await response.json()) as { results: SyncSaleResult[] };
};

/** Deliver one batch. Returns null when there is nothing to do or a request is already running. */
export async function syncOnce(deliver: SyncDeliver = defaultDeliver): Promise<SyncReport | null> {
  if (inFlight) return null;
  const pending = await listPending();
  if (pending.length === 0) return null;

  const batch = pending.slice(0, SYNC_BATCH_SIZE);
  inFlight = true;
  try {
    const payload = await deliver(batch.map(toSyncPayload));
    let cleared = 0;
    for (const result of payload.results) {
      if (result.outcome === 'committed' || result.outcome === 'duplicate') {
        await removeSale(result.client_sale_id);
        cleared += 1;
      } else {
        await markAttempt(result.client_sale_id, exceptionMessage(result));
      }
    }
    return { results: payload.results, cleared, remaining: (await listPending()).length };
  } catch (error) {
    await markBatchFailed(batch, (error as Error).message);
    return { results: [], cleared: 0, remaining: (await listPending()).length };
  } finally {
    inFlight = false;
  }
}

async function markBatchFailed(batch: readonly OutboxSale[], message: string): Promise<void> {
  for (const sale of batch) {
    await markAttempt(sale.clientSaleId, message);
  }
}

function exceptionMessage(result: SyncSaleResult): string {
  const first = result.exceptions[0];
  if (!first) return 'server reported an exception';
  const detail = first.detail as { reason?: string } | null;
  return detail?.reason ?? first.kind;
}
