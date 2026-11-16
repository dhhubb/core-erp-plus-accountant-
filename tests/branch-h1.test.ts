import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { asUser, expectError, one, sql } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import { authenticateCashier, setCashierPin } from '../src/branch/pin';
import { authenticateDevice, createDeviceRegistration, registerDevice } from '../src/branch/device';
import { signInWithPin } from '../src/branch/session';
import { branchHealth, databaseUp } from '../src/branch/health';
import { probeCloud } from '../src/branch/connectivity';
import { clearBranchCache, inProcessIncrWithTtl } from '../src/branch/cache';
import { BRANCH_PROTOCOL_VERSION } from '../src/branch/config';

/**
 * H1 — branch server foundation. Tests 49–51 plus supporting tests.
 *
 * Test numbering continues from the highest number actually present (48), per ADR-0010. The H1 spec
 * called its three tests 16–18, which collide with R4's 14–18; ADR-0026 maps them. The numbers here
 * are the canonical ones.
 *
 * Everything runs against the real local Postgres. Nothing is mocked: the device flow, the PIN
 * check and the health probe all exercise the SQL functions the routes call.
 */

/** Set a PIN through the SQL function (the admin path). */
async function givePin(
  tenant: Tenant,
  cashierId: string,
  pin: string,
  isManager = true,
): Promise<void> {
  await sql('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [
    cashierId,
    `cashier-${cashierId.slice(0, 8)}@example.test`,
  ]);
  await sql('select app.set_cashier_pin($1, $2, $3, $4, $5)', [
    tenant.orgId,
    tenant.branchId,
    cashierId,
    pin,
    isManager,
  ]);
}

/** A real pool client for the TS wrappers. */
async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

describe('H1 branch server foundation', () => {
  it('49. A device is registered with a one-time code; only hashes are stored, and the code is single use', async () => {
    const tenant = await createTenant('Branch Devices');

    const code = await one<{ app: string }>(
      'select app.create_device_registration($1, $2, $3) as app',
      [tenant.orgId, tenant.branchId, 'TILL-1'],
    );
    const rawCode = code!.app;
    expect(rawCode).toBeTruthy();

    // The raw code is never stored: only a hash is. No plaintext code appears in the table.
    const stored = await sql<{ code_hash: string; device_token_hash: string | null }>(
      'select code_hash, device_token_hash from public.device_registrations where org_id = $1',
      [tenant.orgId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code_hash).not.toBe(rawCode);
    expect(stored[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.device_token_hash).toBeNull();

    // Redeem the code once. The token comes back; only its hash is stored.
    const token = await one<{ app: string }>(
      'select app.register_device($1, $2, $3) as app',
      [tenant.orgId, tenant.branchId, rawCode],
    );
    const rawToken = token!.app;
    expect(rawToken).toBeTruthy();

    const after = await sql<{ device_token_hash: string | null; consumed_at: string | null }>(
      'select device_token_hash, consumed_at from public.device_registrations where org_id = $1',
      [tenant.orgId],
    );
    expect(after[0]!.device_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after[0]!.device_token_hash).not.toBe(rawToken);
    expect(after[0]!.consumed_at).not.toBeNull();

    // The token verifies.
    const verified = await one<{ app: string }>(
      'select app.authenticate_device($1, $2, $3) as app',
      [tenant.orgId, tenant.branchId, rawToken],
    );
    expect(verified!.app).toBeTruthy();

    // The code is single use.
    const reuse = await expectError(() =>
      sql('select app.register_device($1, $2, $3)', [tenant.orgId, tenant.branchId, rawCode]),
    );
    expect(reuse.message).toMatch(/already been used/i);

    // The TS wrapper matches the SQL behaviour end to end.
    const created = await withClient((client) =>
      createDeviceRegistration(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        tillId: 'TILL-2',
      }),
    );
    const issued = await withClient((client) =>
      registerDevice(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        code: created,
      }),
    );
    const registrationId = await withClient((client) =>
      authenticateDevice(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        token: issued,
      }),
    );
    expect(registrationId).toBeTruthy();
  });

  it('50. A cashier signs in with a PIN verified locally; five wrong PINs lock the PIN, and a manager override needs a manager PIN', async () => {
    const tenant = await createTenant('Branch PIN');
    const cashier = crypto.randomUUID();
    await givePin(tenant, cashier, '2468', true);

    // The PIN is stored as a hash, never in plaintext.
    const stored = await one<{ pin_hash: string }>(
      'select pin_hash from public.cashier_pins where org_id = $1 and cashier_id = $2',
      [tenant.orgId, cashier],
    );
    expect(stored!.pin_hash).not.toBe('2468');
    expect(stored!.pin_hash).toMatch(/^\$2[aby]\$/);

    // The correct PIN succeeds, entirely locally (no cloud call).
    const good = await one<{ app: { ok: boolean; is_manager: boolean } }>(
      'select app.authenticate_cashier($1, $2, $3, $4) as app',
      [tenant.orgId, tenant.branchId, cashier, '2468'],
    );
    expect(good!.app.ok).toBe(true);
    expect(good!.app.is_manager).toBe(true);

    // A manager override with the manager's PIN is authorised; a wrong PIN is refused.
    const override = await one<{ app: boolean }>(
      'select app.manager_override($1, $2, $3, $4) as app',
      [tenant.orgId, tenant.branchId, cashier, '2468'],
    );
    expect(override!.app).toBe(true);
    const refused = await one<{ app: boolean }>(
      'select app.manager_override($1, $2, $3, $4) as app',
      [tenant.orgId, tenant.branchId, cashier, '0000'],
    );
    expect(refused!.app).toBe(false);

    // One wrong PIN above, plus four more (five total), lock the PIN.
    for (let i = 0; i < 4; i += 1) {
      await sql('select app.authenticate_cashier($1, $2, $3, $4)', [
        tenant.orgId,
        tenant.branchId,
        cashier,
        '0000',
      ]);
    }
    const locked = await one<{ app: { ok: boolean; locked: boolean } }>(
      'select app.authenticate_cashier($1, $2, $3, $4) as app',
      [tenant.orgId, tenant.branchId, cashier, '2468'],
    );
    expect(locked!.app.ok).toBe(false);
    expect(locked!.app.locked).toBe(true);

    // The session wrapper agrees: a locked PIN signs nobody in and yields no token.
    const { result, session } = await withClient((client) =>
      signInWithPin(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        cashierId: cashier,
        pin: '2468',
      }),
    );
    expect(result.locked).toBe(true);
    expect(session).toBeNull();

    // A second cashier with no manager flag: a correct PIN signs in and is not a manager.
    const clerk = crypto.randomUUID();
    await givePin(tenant, clerk, '1111', false);
    const clerkLogin = await withClient((client) =>
      signInWithPin(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        cashierId: clerk,
        pin: '1111',
      }),
    );
    expect(clerkLogin.result.ok).toBe(true);
    expect(clerkLogin.result.isManager).toBe(false);
    expect(clerkLogin.session?.token).toBeTruthy();
    expect(clerkLogin.session?.branchId).toBe(tenant.branchId);
  });

  it('51. Branch health reports the cloud as offline when the cloud is unreachable, and the branch keeps selling', async () => {
    const tenant = await createTenant('Branch Health');

    // A probe of an unreachable cloud is `offline`, never an exception.
    const offline = await probeCloud('http://127.0.0.1:9', {
      protocolVersion: BRANCH_PROTOCOL_VERSION,
      timeoutMs: 200,
    });
    expect(offline.status).toBe('offline');

    // A reachable cloud on a different protocol version is `incompatible`, so the branch blocks push.
    const incompatible = await probeCloud('https://cloud.example.test', {
      protocolVersion: BRANCH_PROTOCOL_VERSION,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ protocol_version: 99 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    expect(incompatible.status).toBe('incompatible');
    expect(incompatible.cloudProtocolVersion).toBe(99);

    // A reachable cloud on the same version is `online`.
    const online = await probeCloud('https://cloud.example.test', {
      protocolVersion: BRANCH_PROTOCOL_VERSION,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ protocol_version: BRANCH_PROTOCOL_VERSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    expect(online.status).toBe('online');

    // The branch health report works with the cloud down: the local database answers and the cloud
    // is reported offline. The branch is up regardless.
    const health = await asUser(tenant.claims, async (client) => {
      const up = await databaseUp(client);
      const report = await branchHealth(client, {
        probe: true,
        orgId: tenant.orgId,
        branchId: tenant.branchId,
      });
      return { up, report };
    });
    expect(health.up).toBe(true);
    expect(health.report.branch_up).toBe(true);
    expect(health.report.database_up).toBe(true);
    expect(health.report.cloud_status).toBe('offline');
    expect(health.report.protocol_version).toBe(BRANCH_PROTOCOL_VERSION);
    expect(health.report.push_blocked).toBe(false);
  });

  it('supports branch mode without Redis: the in-process counter enforces the same window', () => {
    clearBranchCache();
    const key = 'ratelimit:livesale:test:branch:1';
    expect(inProcessIncrWithTtl(key, 60)).toBe(1);
    // The TTL is set only when the window opens, so later increments keep the same window and
    // must not clear the expiry.
    for (let i = 0; i < 4; i += 1) inProcessIncrWithTtl(key, 60);
    expect(inProcessIncrWithTtl(key, 60)).toBe(6);
    // A different key is a different window.
    expect(inProcessIncrWithTtl('other', 60)).toBe(1);

    // The window really expires: past the TTL the counter starts again at 1. Fake the clock so the
    // test is instant and deterministic.
    vi.useFakeTimers();
    try {
      clearBranchCache();
      expect(inProcessIncrWithTtl('window', 60)).toBe(1);
      expect(inProcessIncrWithTtl('window', 60)).toBe(2);
      vi.advanceTimersByTime(61_000);
      expect(inProcessIncrWithTtl('window', 60)).toBe(1);
    } finally {
      vi.useRealTimers();
      clearBranchCache();
    }
  });

  it('stores a PIN through the TS wrapper and never the plaintext', async () => {
    const tenant = await createTenant('Branch Pin Wrapper');
    const cashier = crypto.randomUUID();
    await sql('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [
      cashier,
      `w-${cashier.slice(0, 8)}@example.test`,
    ]);

    await withClient((client) =>
      setCashierPin(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        cashierId: cashier,
        pin: '8642',
        isManager: false,
      }),
    );

    const stored = await one<{ pin_hash: string }>(
      'select pin_hash from public.cashier_pins where org_id = $1 and cashier_id = $2',
      [tenant.orgId, cashier],
    );
    expect(stored!.pin_hash).not.toBe('8642');

    const ok = await withClient((client) =>
      authenticateCashier(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        cashierId: cashier,
        pin: '8642',
      }),
    );
    expect(ok.ok).toBe(true);
  });
});
