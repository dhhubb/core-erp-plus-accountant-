import { afterAll, describe, expect, it } from 'vitest';
import { expectError, one, sql } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { withUserContext } from '../src/core/auth';
import { testPool } from './support/db';
import {
  defaultPrinterSettings,
  loadPrinterSettings,
  savePrinterSettings,
} from '../src/verticals/pos/printing';

/**
 * H4 — hardware and receipts. Tests 69–74.
 *
 * The printer settings live in Postgres and are read through RLS, exactly as the till reads them.
 * Nothing is mocked: the settings round-trip, the constraints, and the tenant isolation are all
 * exercised against the real local Postgres.
 */

async function printerFixture(name: string): Promise<{ tenant: Tenant; branchId: string }> {
  const tenant = await createTenant(name);
  return { tenant, branchId: tenant.branchId };
}

/** Run fn inside a transaction as the tenant's user: authenticated role, JWT claims set. */
async function asTenant<T>(
  tenant: Tenant,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return withUserContext(
    {
      sub: tenant.userId,
      orgId: tenant.orgId,
      branchIds: [tenant.branchId],
      role: 'authenticated',
    },
    fn,
  );
}

describe('H4 hardware and receipts', () => {
  it('69. A branch with no printer settings prints through the browser dialog', async () => {
    const { tenant } = await printerFixture('H4 69');

    const settings = await asTenant(tenant, (client) =>
      loadPrinterSettings(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );

    expect(settings).toEqual(defaultPrinterSettings());
    expect(settings.mode).toBe('browser');
  });

  it('70. Printer settings round-trip: a network printer keeps its host and port', async () => {
    const { tenant } = await printerFixture('H4 70');

    const saved = await asTenant(tenant, (client) =>
      savePrinterSettings(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        mode: 'network',
        host: '192.168.1.50',
        port: 9100,
      }),
    );
    expect(saved).toEqual({ mode: 'network', host: '192.168.1.50', port: 9100, label: 'default' });

    const loaded = await asTenant(tenant, (client) =>
      loadPrinterSettings(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(loaded).toEqual(saved);

    // The save is idempotent on (org, branch, label): a second save updates, it does not add a row.
    await asTenant(tenant, (client) =>
      savePrinterSettings(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        mode: 'network',
        host: '10.0.0.9',
        port: 9101,
      }),
    );
    const rows = await sql<{ n: string }>(
      `select count(*)::text as n from public.printer_settings where org_id = $1`,
      [tenant.orgId],
    );
    expect(rows[0]!.n).toBe('1');
    const reloaded = await asTenant(tenant, (client) =>
      loadPrinterSettings(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(reloaded.host).toBe('10.0.0.9');
    expect(reloaded.port).toBe(9101);
  });

  it('71. A network printer with no host is rejected; browser mode ignores the host', async () => {
    const { tenant } = await printerFixture('H4 71');

    const missingHost = await expectError(() =>
      asTenant(tenant, (client) =>
        savePrinterSettings(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          mode: 'network',
          host: '',
        }),
      ),
    );
    expect(missingHost.message).toContain('network printer requires a host');

    // Browser mode clears any host: a browser print has no destination on the LAN.
    const browser = await asTenant(tenant, (client) =>
      savePrinterSettings(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        mode: 'browser',
        host: '192.168.1.50',
      }),
    );
    expect(browser.mode).toBe('browser');
    expect(browser.host).toBeNull();
  });

  it('72. Printer settings are tenant-scoped: another org sees none', async () => {
    const a = await printerFixture('H4 72 A');
    const b = await printerFixture('H4 72 B');

    await asTenant(a.tenant, (client) =>
      savePrinterSettings(client, {
        orgId: a.tenant.orgId,
        branchId: a.tenant.branchId,
        mode: 'network',
        host: '192.168.1.50',
      }),
    );

    // Org B's user cannot read Org A's printer settings through RLS.
    const visible = await asTenant(b.tenant, (client) =>
      client.query('select count(*)::int as n from public.printer_settings'),
    );
    expect(visible.rows[0]!.n).toBe(0);

    // And Org B falls back to the browser default, not to Org A's network printer.
    const settings = await asTenant(b.tenant, (client) =>
      loadPrinterSettings(client, { orgId: b.tenant.orgId, branchId: b.tenant.branchId }),
    );
    expect(settings.mode).toBe('browser');
  });

  it('73. printer_settings is a well-formed tenant table (org_id, created_at, RLS forced)', async () => {
    const row = await one<{
      org_id: boolean;
      created_at: boolean;
      rls: boolean;
      forced: boolean;
    }>(
      `select
         exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.printer_settings'::regclass
                    and a.attname = 'org_id' and a.attnotnull) as org_id,
         exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.printer_settings'::regclass
                    and a.attname = 'created_at' and a.attnotnull) as created_at,
         c.relrowsecurity as rls,
         c.relforcerowsecurity as forced
       from pg_class c
      where c.oid = 'public.printer_settings'::regclass`,
    );
    expect(row).toEqual({ org_id: true, created_at: true, rls: true, forced: true });

    // The scripts the gate runs find no violation in the new table.
    const tenantViolations = await sql(
      `select * from (
         select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'printer_settings'
            and (c.relrowsecurity = false or c.relforcerowsecurity = false)
       ) v`,
    );
    expect(tenantViolations.length).toBe(0);

    // Every foreign key column on printer_settings has an index (the branch_id and org_id indexes).
    const missing = await sql<{ column_name: string }>(
      `select a.attname as column_name
         from pg_constraint con
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
        where con.contype = 'f' and con.conrelid = 'public.printer_settings'::regclass
          and not exists (
            select 1 from pg_index i
             where i.indrelid = con.conrelid and i.indkey[0] = a.attnum
          )`,
    );
    expect(missing).toEqual([]);
  });

  it('74. The printer settings functions are callable as the tenant user', async () => {
    const { tenant } = await printerFixture('H4 74');

    const settings = await asTenant(tenant, async (client) => {
      const saved = await savePrinterSettings(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        mode: 'network',
        host: '192.168.1.50',
        port: 9100,
      });
      const read = await client.query<{ app: unknown }>(
        `select app.get_printer_settings($1, $2, 'default') as app`,
        [tenant.orgId, tenant.branchId],
      );
      return { saved, read: read.rows[0]!.app as Record<string, unknown> };
    });

    expect(settings.saved.mode).toBe('network');
    expect(settings.read.mode).toBe('network');
    expect(settings.read.host).toBe('192.168.1.50');

    // A different label is a different printer and falls back to the browser default.
    const kitchen = await asTenant(tenant, (client) =>
      loadPrinterSettings(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        label: 'kitchen',
      }),
    );
    expect(kitchen.mode).toBe('browser');
    void tenantToken;
  });
});

afterAll(async () => {
  // The shared test pool is closed by the global teardown; nothing extra to release here.
});
