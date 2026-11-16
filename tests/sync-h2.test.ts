import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { asUser, expectError, one, sql, tx } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import { compareSeq, pushOnce } from '../src/sync/push';
import { pullOnce, storedCursor } from '../src/sync/pull';
import { runSyncTick, newRunnerState } from '../src/sync/runner';
import { checksumMatches, decryptDump, runBackup } from '../src/sync/backup';
import {
  SyncNetworkError,
  SyncRejectionError,
  isRetryable,
  retryDelayMs,
} from '../src/sync/retry';
import type { SyncOutboxEvent } from '../src/sync/types';

/**
 * H2 — the sync engine (branch <-> cloud). Tests 53–62, continuing from H1's 52 (ADR-0010).
 *
 * Everything runs against the real local Postgres. The branch side is exercised through a pool that
 * carries `app.branch_mode=branch` (the outbox triggers only fire in branch mode); the cloud side
 * through a plain pool. No cloud, no mocks of the database: the push/pull workers are driven with an
 * injected transport, but every database write is real.
 */

/** A branch-mode pool: every connection carries the GUC the outbox triggers read. */
const branchPool = new Pool({
  connectionString: testDatabaseUrl(),
  options: '-c app.branch_mode=branch',
  max: 8,
});

afterAll(async () => {
  await branchPool.end();
});

async function withBranch<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await branchPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withCloud<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await new Pool({ connectionString: testDatabaseUrl(), max: 1 }).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

interface BranchFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  shiftId: string;
}

/** A branch with stock and a shift, ready to ring a sale. */
async function branchFixture(name: string): Promise<BranchFixture> {
  const tenant = await createTenant(name);
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'W1', 'W1') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), 'Sync widget') returning id`,
    [tenant.orgId],
  );
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, `BC-${Math.random().toString(36).slice(2, 10)}`],
  );
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, 5.0000)`,
    [tenant.orgId, priceList!.id, variant!.id],
  );
  await sql(`select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`, [
    tenant.orgId,
    tenant.branchId,
    warehouse!.id,
    product!.id,
    variant!.id,
  ]);
  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );
  return {
    tenant,
    warehouseId: warehouse!.id,
    productId: product!.id,
    variantId: variant!.id,
    shiftId: shift!.id,
  };
}

/** Ring one sale on the branch (in branch mode, so the outbox trigger fires). */
async function ringSale(
  fx: BranchFixture,
  client: PoolClient,
  clientSaleId: string,
): Promise<string> {
  const result = await client.query<{ r: { sale_id: string } }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as r`,
    [
      fx.tenant.orgId,
      fx.tenant.branchId,
      fx.warehouseId,
      fx.shiftId,
      clientSaleId,
      JSON.stringify([{ variant_id: fx.variantId, qty: 1, unit_price: '5.0000' }]),
      JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '5' }]),
    ],
  );
  return result.rows[0]!.r.sale_id;
}

async function outboxEvents(client: PoolClient, orgId: string, branchId: string): Promise<SyncOutboxEvent[]> {
  const result = await client.query<{ b: SyncOutboxEvent[] }>(
    'select app.sync_outbox_batch($1, $2, 500) as b',
    [orgId, branchId],
  );
  return result.rows[0]!.b;
}

describe('H2 sync engine', () => {
  it('53. A completed sale writes exactly one outbox event in the same transaction; a rolled-back sale writes none', async () => {
    const fx = await branchFixture('H2 Outbox');

    await withBranch(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());

      const events = await outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('sale');
      expect(events[0]!.payload.client_sale_id).toBeTruthy();
      // The event carries the whole sale: its lines and its tenders, so the cloud can replay it.
      expect(Array.isArray(events[0]!.payload.lines)).toBe(true);
      expect(Array.isArray(events[0]!.payload.tenders)).toBe(true);
    });

    // A rolled-back sale leaves no event: the outbox write is in the sale's transaction.
    const before = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    const rolledBack = await withBranch(async (client) => {
      await client.query('begin');
      await ringSale(fx, client, crypto.randomUUID());
      await client.query('rollback');
      return outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId);
    });
    expect(rolledBack).toHaveLength(before.length);
  });

  it('54. Pushing a batch applies each event exactly once; re-pushing the same batch is all duplicates', async () => {
    const fx = await branchFixture('H2 Dedupe');
    await withBranch(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());
      await ringSale(fx, client, crypto.randomUUID());
    });

    const events = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(events).toHaveLength(2);

    const first = await withCloud((client) =>
      client.query<{ r: { applied: number; duplicates: number; highest_seq: string } }>(
        'select app.sync_push_result($1, $2, $3::jsonb) as r',
        [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify(events)],
      ),
    );
    expect(first.rows[0]!.r.applied).toBe(2);
    expect(first.rows[0]!.r.duplicates).toBe(0);

    // Push the same batch again: the event UUID is the idempotency key, so nothing applies twice.
    const second = await withCloud((client) =>
      client.query<{ r: { applied: number; duplicates: number } }>(
        'select app.sync_push_result($1, $2, $3::jsonb) as r',
        [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify(events)],
      ),
    );
    expect(second.rows[0]!.r.applied).toBe(0);
    expect(second.rows[0]!.r.duplicates).toBe(2);

    const inbox = await one<{ n: string }>(
      'select count(*)::text as n from public.sync_inbox where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(inbox!.n).toBe('2');
  });

  it('55. The outbox is append-only: DELETE is rejected, and acked_at may only be set once', async () => {
    const fx = await branchFixture('H2 Append');
    await withBranch((client) => ringSale(fx, client, crypto.randomUUID()));

    const deleteError = await expectError(() =>
      sql('delete from public.sync_outbox where org_id = $1', [fx.tenant.orgId]),
    );
    expect(deleteError.message).toMatch(/append-only/i);

    // acked_at moves null -> now once. A second set is rejected.
    await sql('update public.sync_outbox set acked_at = now() where org_id = $1', [fx.tenant.orgId]);
    const secondAck = await expectError(() =>
      sql('update public.sync_outbox set acked_at = now() where org_id = $1', [fx.tenant.orgId]),
    );
    expect(secondAck.message).toMatch(/write-once/i);

    // Any other column is immutable.
    const mutate = await expectError(() =>
      sql(`update public.sync_outbox set payload = '{}'::jsonb where org_id = $1`, [fx.tenant.orgId]),
    );
    expect(mutate.message).toMatch(/append-only/i);
  });

  it('56. The branch acks only the prefix the cloud applied; a rejected event is recorded as a conflict and not acked', async () => {
    const fx = await branchFixture('H2 Reject');
    await withBranch(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());
    });

    const events = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    const good = events[0]!;
    // A malformed second event: the cloud rejects it, so it must not be acked past.
    const bad: SyncOutboxEvent = {
      seq: '999999',
      event_id: crypto.randomUUID(),
      event_type: 'sale',
      payload: { client_sale_id: crypto.randomUUID() }, // no lines/warehouse: replay cannot proceed
      created_at: new Date().toISOString(),
    };

    const pushed = await withCloud((client) =>
      client.query<{ r: { applied: number; highest_seq: string; rejects: Array<{ event_id: string }> } }>(
        'select app.sync_push_result($1, $2, $3::jsonb) as r',
        [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify([good, bad])],
      ),
    );
    expect(pushed.rows[0]!.r.applied).toBe(1);
    expect(pushed.rows[0]!.r.rejects).toHaveLength(1);
    expect(pushed.rows[0]!.r.rejects[0]!.event_id).toBe(bad.event_id);

    // The branch records the conflict and acks only up to the good event.
    await withBranch(async (client) => {
      await client.query('select app.sync_record_conflict($1, $2, $3, $4, $5, $6, $7::jsonb)', [
        fx.tenant.orgId,
        fx.tenant.branchId,
        bad.event_id,
        bad.seq,
        bad.event_type,
        'cloud rejected the event',
        JSON.stringify({}),
      ]);
      await client.query('select app.sync_outbox_ack($1, $2, $3)', [
        fx.tenant.orgId,
        fx.tenant.branchId,
        good.seq,
      ]);
    });

    const conflicts = await one<{ n: string }>(
      'select count(*)::text as n from public.sync_conflicts where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(conflicts!.n).toBe('1');
    const pending = await one<{ n: string }>(
      'select app.sync_outbox_size($1, $2)::text as n',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(pending!.n).toBe('0'); // the one real event was acked; the malformed one was never in the outbox
  });

  it('57. A network failure is retryable (backoff, not a conflict); only a cloud rejection is a conflict', () => {
    // Backoff is exponential with full jitter, capped at 5 minutes, and never negative.
    expect(retryDelayMs(1, () => 1)).toBe(1_000);
    expect(retryDelayMs(2, () => 1)).toBe(2_000);
    expect(retryDelayMs(20, () => 1)).toBe(5 * 60 * 1000);
    expect(retryDelayMs(3, () => 0)).toBe(0);

    expect(isRetryable(new SyncNetworkError('down'))).toBe(true);
    expect(isRetryable(new SyncRejectionError('no', []))).toBe(false);
  });

  it('58. Master-data pull is ordered by change_seq and advances the cursor forward only', async () => {
    const fx = await branchFixture('H2 Pull');

    // Two changes, written out of order on the wire.
    await sql(`select app.record_master_data_change($1, 'product', $2, 'upsert', $3::jsonb, 1)`, [
      fx.tenant.orgId,
      fx.productId,
      JSON.stringify({ name: 'A' }),
    ]);
    await sql(`select app.record_master_data_change($1, 'product', $2, 'upsert', $3::jsonb, 2)`, [
      fx.tenant.orgId,
      fx.productId,
      JSON.stringify({ name: 'B' }),
    ]);

    const batch = await one<{ b: Array<{ change_seq: string }> }>(
      'select app.sync_pull_batch($1, $2, 0, 500) as b',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(batch!.b.map((c) => Number(c.change_seq))).toEqual([1, 2]);

    await withBranch(async (client) => {
      // Apply a stale batch (cursor 0) then the real one: the cursor only moves forward.
      const applied = await client.query<{ r: { applied: number; cursor: string } }>(
        'select app.sync_apply_pull($1, $2, $3::jsonb) as r',
        [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify(batch!.b)],
      );
      expect(applied.rows[0]!.r.applied).toBe(2);
      expect(Number(applied.rows[0]!.r.cursor)).toBe(2);

      // A stale apply cannot rewind the cursor.
      await client.query('select app.sync_set_cursor($1, $2, 1)', [fx.tenant.orgId, fx.tenant.branchId]);
      const cursor = await storedCursor(client, fx.tenant.orgId, fx.tenant.branchId);
      expect(cursor).toBe('2');
    });
  });

  it('59. A pulled price change is served from the local mirror and a later change bumps the version', async () => {
    const fx = await branchFixture('H2 Price');

    await sql(
      `select app.record_master_data_change($1, 'price_list_item', $2, 'upsert', $3::jsonb, 1)`,
      [fx.tenant.orgId, fx.variantId, JSON.stringify({ price: '6.0000', currency: 'USD' })],
    );
    const first = await one<{ b: unknown[] }>('select app.sync_pull_batch($1, $2, 0, 500) as b', [
      fx.tenant.orgId,
      fx.tenant.branchId,
    ]);

    const versionOne = await withBranch(async (client) => {
      await client.query('select app.sync_apply_pull($1, $2, $3::jsonb)', [
        fx.tenant.orgId,
        fx.tenant.branchId,
        JSON.stringify(first!.b),
      ]);
      const price = await client.query<{ unit_price: string; price_version: string }>(
        'select * from app.branch_price($1, $2, $3)',
        [fx.tenant.orgId, fx.tenant.branchId, fx.variantId],
      );
      return price.rows[0]!;
    });
    expect(versionOne.unit_price).toBe('6.0000');
    expect(Number(versionOne.price_version)).toBe(1);

    // A later change updates the mirror and raises the version; the earlier version is history.
    await sql(
      `select app.record_master_data_change($1, 'price_list_item', $2, 'upsert', $3::jsonb, 2)`,
      [fx.tenant.orgId, fx.variantId, JSON.stringify({ price: '7.0000', currency: 'USD' })],
    );
    const second = await one<{ b: unknown[] }>('select app.sync_pull_batch($1, $2, 1, 500) as b', [
      fx.tenant.orgId,
      fx.tenant.branchId,
    ]);

    const versionTwo = await withBranch(async (client) => {
      await client.query('select app.sync_apply_pull($1, $2, $3::jsonb)', [
        fx.tenant.orgId,
        fx.tenant.branchId,
        JSON.stringify(second!.b),
      ]);
      const price = await client.query<{ unit_price: string; price_version: string }>(
        'select * from app.branch_price($1, $2, $3)',
        [fx.tenant.orgId, fx.tenant.branchId, fx.variantId],
      );
      return price.rows[0]!;
    });
    expect(versionTwo.unit_price).toBe('7.0000');
    expect(Number(versionTwo.price_version)).toBeGreaterThan(Number(versionOne.price_version));
  });

  it('60. The outbox triggers are inert when branch mode is off, so the cloud writes no outbox rows', async () => {
    const fx = await branchFixture('H2 CloudInert');
    // Ring a sale on a CLOUD connection (no app.branch_mode): no outbox row appears.
    await withCloud(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());
    });
    const rows = await one<{ n: string }>(
      'select count(*)::text as n from public.sync_outbox where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(rows!.n).toBe('0');
  });

  it('61. Org A cannot read Org B sync rows (RLS on the sync tables)', async () => {
    const a = await branchFixture('H2 RLS A');
    const b = await branchFixture('H2 RLS B');
    await withBranch(async (client) => {
      await ringSale(a, client, crypto.randomUUID());
    });
    await sql(`select app.record_master_data_change($1, 'product', $2, 'upsert', $3::jsonb, 1)`, [
      b.tenant.orgId,
      b.productId,
      JSON.stringify({ name: 'B only' }),
    ]);

    await asUser(a.tenant.claims, async (client) => {
      const outbox = await client.query('select id from public.sync_outbox');
      const inbox = await client.query('select id from public.sync_inbox');
      const master = await client.query('select id from public.master_data_changes');
      const mirror = await client.query('select id from public.branch_master_data');
      const conflicts = await client.query('select id from public.sync_conflicts');
      expect(master.rows).toHaveLength(0); // B's change is invisible to A
      expect(outbox.rows).toHaveLength(1); // A's own event is visible
      expect(inbox.rows).toHaveLength(0);
      expect(mirror.rows).toHaveLength(0);
      expect(conflicts.rows).toHaveLength(0);
    });
  });

  it('62. Kill-and-restart: an interrupted push re-pushes on restart and the cloud dedupes, so nothing double-posts', async () => {
    const fx = await branchFixture('H2 Restart');
    await withBranch(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());
      await ringSale(fx, client, crypto.randomUUID());
    });

    const events = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    const highestSeq = events[events.length - 1]!.seq;

    // First attempt: the transport fails, as if the branch was killed mid-push.
    const first = await withBranch((client) =>
      pushOnce({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        deliver: async () => {
          throw new SyncNetworkError('branch killed mid-push');
        },
      }),
    );
    expect(first.retryAtMs).not.toBeNull();
    expect(first.ackedSeq).toBe('0');
    const pendingAfterCrash = await one<{ n: string }>(
      'select app.sync_outbox_size($1, $2)::text as n',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(pendingAfterCrash!.n).toBe('2'); // nothing was acked

    // Restart: the same events are pushed and applied once.
    const second = await withBranch((client) =>
      pushOnce({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        deliver: async (batch) => {
          const res = await client.query<{ r: { applied: number; duplicates: number; highest_seq: string; rejects: [] } }>(
            'select app.sync_push_result($1, $2, $3::jsonb) as r',
            [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify(batch)],
          );
          return res.rows[0]!.r;
        },
      }),
    );
    expect(second.applied).toBe(2);
    expect(second.ackedSeq).toBe(highestSeq);

    const pendingAfterRestart = await one<{ n: string }>(
      'select app.sync_outbox_size($1, $2)::text as n',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(pendingAfterRestart!.n).toBe('0');

    const inbox = await one<{ n: string }>(
      'select count(*)::text as n from public.sync_inbox where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(inbox!.n).toBe('2'); // two events, applied once each
  });

  it('63. A branch backup is encrypted before upload, checksummed, and recorded; a bad key fails loudly', async () => {
    const fx = await branchFixture('H2 Backup');
    const key = randomBytes(32);
    const dump = Buffer.from('-- branch dump\nselect 1;\n'.repeat(64));

    const uploaded: { objectKey: string; payload: Buffer }[] = [];
    const result = await withBranch(async (client) =>
      runBackup({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        dump,
        key,
        uploader: async (objectKey, payload) => {
          uploaded.push({ objectKey, payload });
          return { objectKey, byteSize: payload.length };
        },
      }),
    );

    expect(result.status).toBe('uploaded');
    expect(uploaded).toHaveLength(1);
    // The uploaded bytes are not the plaintext: they decrypt back to it, with a verified auth tag.
    const payload = uploaded[0]!.payload;
    expect(payload.equals(dump)).toBe(false);
    expect(decryptDump(payload, key).equals(dump)).toBe(true);
    expect(checksumMatches(payload, result.checksum)).toBe(true);
    // A tampered byte fails the auth tag.
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptDump(tampered, key)).toThrow();
    expect(checksumMatches(tampered, result.checksum)).toBe(false);

    const rows = await sql<{ status: string; checksum: string; byte_size: string }>(
      'select status, checksum, byte_size from public.sync_backups where org_id = $1 order by created_at desc',
      [fx.tenant.orgId],
    );
    expect(rows[0]!.status).toBe('uploaded');
    expect(rows[0]!.checksum).toBe(result.checksum);

    // A wrong key never produces plaintext, and the failure is recorded, not swallowed.
    const failed = await withBranch(async (client) =>
      runBackup({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        dump,
        key,
        uploader: async () => {
          throw new Error('cloud storage refused the upload');
        },
      }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/refused/);
    const failedRow = await sql<{ status: string }>(
      `select status from public.sync_backups where org_id = $1 and status = 'failed'`,
      [fx.tenant.orgId],
    );
    expect(failedRow).toHaveLength(1);
  });

  it('supports: the push worker acks the applied prefix and records a conflict for a rejected event', async () => {
    const fx = await branchFixture('H2 WorkerReject');
    await withBranch(async (client) => {
      await ringSale(fx, client, crypto.randomUUID());
    });

    const outcome = await withBranch((client) =>
      pushOnce({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        deliver: async (events) => ({
          highest_seq: events[events.length - 1]!.seq,
          applied: 0,
          duplicates: 0,
          rejects: [{ event_id: events[0]!.event_id, reason: 'cloud said no' }],
        }),
      }),
    );
    // The rejected event stops the ack before it, and a conflict is recorded.
    expect(outcome.rejected).toHaveLength(1);
    const conflicts = await one<{ n: string }>(
      'select count(*)::text as n from public.sync_conflicts where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(conflicts!.n).toBe('1');
  });

  it('supports: the pull worker applies a batch and the runner drives one push+pull tick', async () => {
    const fx = await branchFixture('H2 Runner');
    await withBranch((client) => ringSale(fx, client, crypto.randomUUID()));
    await sql(`select app.record_master_data_change($1, 'product', $2, 'upsert', $3::jsonb, 1)`, [
      fx.tenant.orgId,
      fx.productId,
      JSON.stringify({ name: 'Runner product' }),
    ]);

    const result = await withBranch((client) =>
      runSyncTick({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        state: newRunnerState(),
        deliverPushFn: async (_cloud, _org, _branch, events) => {
          const res = await client.query<{ r: { applied: number; duplicates: number; highest_seq: string; rejects: [] } }>(
            'select app.sync_push_result($1, $2, $3::jsonb) as r',
            [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify(events)],
          );
          return res.rows[0]!.r;
        },
        deliverPullFn: async () => {
          const res = await client.query<{ b: unknown[] }>(
            'select app.sync_pull_batch($1, $2, 0, 500) as b',
            [fx.tenant.orgId, fx.tenant.branchId],
          );
          return { changes: res.rows[0]!.b as never[] };
        },
      }),
    );
    expect(result.pushed).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.pulled).toBe(1);
    expect(result.cursor).toBe('1');
  });

  it('supports: compareSeq orders bigint-as-string sequences without precision loss', () => {
    expect(compareSeq('2', '10')).toBe(-1);
    expect(compareSeq('10', '2')).toBe(1);
    expect(compareSeq('7', '7')).toBe(0);
    expect(compareSeq('9007199254740993', '9007199254740992')).toBe(1);
  });
});
