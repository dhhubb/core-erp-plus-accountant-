/**
 * The branch outbox, read and written through the SQL functions the migration defines.
 *
 * The outbox is append-only and ordered by `seq`, a bigserial. The events are written by triggers
 * on the source tables (pos_sales, stock_ledger, payments, credit_notes), so they are part of the
 * same transaction as the fact they record: a rolled-back sale leaves no event. This module only
 * reads them for the push worker and acks the prefix the cloud confirmed.
 */

import type { PoolClient } from 'pg';
import type { SyncEventType, SyncOutboxEvent } from './types';

/** The next unacked events, in sequence order. */
export async function pendingEvents(
  client: PoolClient,
  orgId: string,
  branchId: string,
  limit: number,
): Promise<SyncOutboxEvent[]> {
  const result = await client.query<{ batch: SyncOutboxEvent[] }>(
    'select app.sync_outbox_batch($1, $2, $3) as batch',
    [orgId, branchId, limit],
  );
  return result.rows[0]?.batch ?? [];
}

/** Mark every event up to and including `upToSeq` acknowledged. Returns how many rows changed. */
export async function ackUpTo(
  client: PoolClient,
  orgId: string,
  branchId: string,
  upToSeq: string,
): Promise<number> {
  const result = await client.query<{ app: number }>(
    'select app.sync_outbox_ack($1, $2, $3) as app',
    [orgId, branchId, upToSeq],
  );
  return result.rows[0]?.app ?? 0;
}

/** The number of unacked events. */
export async function outboxSize(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<number> {
  const result = await client.query<{ app: string }>(
    'select app.sync_outbox_size($1, $2) as app',
    [orgId, branchId],
  );
  return Number(result.rows[0]?.app ?? 0);
}

/** The highest sequence number the branch holds. */
export async function outboxMaxSeq(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.sync_outbox_max_seq($1, $2) as app',
    [orgId, branchId],
  );
  return result.rows[0]?.app ?? '0';
}

/** Append an event by hand (used by tests and by a manual correction path). Idempotent per event id. */
export async function enqueueEvent(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    eventId: string;
    eventType: SyncEventType;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.sync_outbox_enqueue($1, $2, $3, $4, $5::jsonb) as app',
    [input.orgId, input.branchId, input.eventId, input.eventType, JSON.stringify(input.payload)],
  );
  return result.rows[0]!.app;
}
