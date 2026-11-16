/**
 * The sync status page's data, read from app.sync_status.
 *
 * The status page shows the outbox depth, the last push and pull, and any conflicts the cloud
 * really rejected. It reads from the branch's own database, so it answers with the cloud offline.
 */

import type { PoolClient } from 'pg';

export interface SyncStatus {
  protocol_version: number;
  last_pushed_seq: string;
  last_pulled_cursor: string | null;
  cloud_status: 'unknown' | 'online' | 'offline' | 'incompatible';
  cloud_protocol_version: number | null;
  push_blocked: boolean;
  outbox_size: number;
  outbox_max_seq: string;
  conflicts: number;
  last_push_at: string | null;
  last_pull_at: string | null;
}

/** Read the status report. */
export async function syncStatus(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<SyncStatus> {
  const result = await client.query<{ status: SyncStatus }>(
    'select app.sync_status($1, $2) as status',
    [orgId, branchId],
  );
  return result.rows[0]!.status;
}

export interface SyncConflictRow {
  id: string;
  event_id: string;
  branch_seq: string | null;
  event_type: string | null;
  reason: string;
  created_at: string;
}

/** The recent conflicts, newest first, for the status page. Keyset on (created_at, id). */
export async function recentConflicts(
  client: PoolClient,
  orgId: string,
  branchId: string,
  limit = 50,
): Promise<SyncConflictRow[]> {
  const result = await client.query<SyncConflictRow>(
    `select id, event_id, branch_seq, event_type, reason, created_at
       from public.sync_conflicts
      where org_id = $1 and branch_id = $2
      order by created_at desc, id desc
      limit $3`,
    [orgId, branchId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows;
}
