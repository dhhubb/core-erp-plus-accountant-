import { describe, expect, it } from 'vitest';
import { asUser, expectError, sql, tx } from './support/db';
import { addBranch, createTenant, refreshedClaims } from './support/fixtures';
import { TENANT_TABLES } from './support/tenant-tables';

describe('M1 tenancy and RLS', () => {
  it('1. Org A user cannot read Org B organizations row', async () => {
    const a = await createTenant('Org A');
    const b = await createTenant('Org B');

    const seen = await asUser(a.claims, async (client) => {
      const result = await client.query<{ id: string }>(
        'select id from public.organizations where id = $1',
        [b.orgId],
      );
      return result.rows;
    });

    expect(seen).toHaveLength(0);

    const own = await asUser(a.claims, async (client) => {
      const result = await client.query<{ id: string }>(
        'select id from public.organizations where id = $1',
        [a.orgId],
      );
      return result.rows;
    });
    expect(own).toHaveLength(1);
  });

  it('2. Org A user cannot read Org B rows in every tenant table', async () => {
    const a = await createTenant('Org A');
    const b = await createTenant('Org B');
    const { seedOneRowPerTenantTable } = await import('./support/tenant-tables');
    await seedOneRowPerTenantTable(b.orgId, b.branchId);

    for (const table of TENANT_TABLES) {
      const rows = await asUser(a.claims, async (client) => {
        const result = await client.query<{ n: string }>(
          `select count(*)::text as n from public.${table.name} where org_id = $1`,
          [b.orgId],
        );
        return result.rows;
      });
      expect(rows[0]?.n, `${table.name} leaked Org B rows to Org A`).toBe('0');
    }
  });

  it('3. An insert with another org org_id is rejected', async () => {
    const a = await createTenant('Org A');
    const b = await createTenant('Org B');

    const error = await expectError(() =>
      asUser(a.claims, async (client) => {
        await client.query(
          'insert into public.products (org_id, sku, name) values ($1, $2, $3)',
          [b.orgId, 'X-1', 'Cross-tenant product'],
        );
      }),
    );
    // RLS WITH CHECK violation.
    expect(error.message).toMatch(/row-level security|violates/i);
  });

  it('4. A JWT without org_id returns zero rows', async () => {
    const a = await createTenant('Org A');
    await sql('insert into public.products (org_id, sku, name) values ($1, $2, $3)', [
      a.orgId,
      'P-4',
      'Visible to members only',
    ]);

    const noOrgClaims = { sub: a.userId, orgId: null, branchIds: [], role: 'authenticated' };

    const orgRows = await asUser(noOrgClaims, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.organizations',
      );
      return result.rows;
    });
    expect(orgRows[0]?.n).toBe('0');

    const productRows = await asUser(noOrgClaims, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.products',
      );
      return result.rows;
    });
    expect(productRows[0]?.n).toBe('0');
  });

  it('5. A user without membership in a branch sees none of that branch rows', async () => {
    const a = await createTenant('Org A');
    const otherBranch = await addBranch(a, 'North');

    // Give the org a row in the other branch, created as superuser.
    await sql(
      `insert into public.warehouses (org_id, branch_id, code, name)
       values ($1, $2, 'N1', 'North WH')`,
      [a.orgId, otherBranch],
    );

    // The token still carries only the Main branch.
    const rows = await asUser(a.claims, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.warehouses where branch_id = $1',
        [otherBranch],
      );
      return result.rows;
    });
    expect(rows[0]?.n).toBe('0');

    // The branch the token does carry is visible.
    await sql(
      `insert into public.warehouses (org_id, branch_id, code, name)
       values ($1, $2, 'M1', 'Main WH')`,
      [a.orgId, a.branchId],
    );
    const own = await asUser(a.claims, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.warehouses where branch_id = $1',
        [a.branchId],
      );
      return result.rows;
    });
    expect(own[0]?.n).toBe('1');
  });

  it('6. Removing a membership takes effect after token refresh, not before', async () => {
    const a = await createTenant('Org A');
    const before = a.claims;

    // Remove the membership. The existing token still carries the old claims.
    await sql('delete from public.memberships where org_id = $1 and user_id = $2', [
      a.orgId,
      a.userId,
    ]);

    const stillVisible = await asUser(before, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.organizations where id = $1',
        [a.orgId],
      );
      return result.rows;
    });
    expect(stillVisible[0]?.n).toBe('1');

    // After a refresh the hook finds no membership, so the token carries no org.
    const refreshed = refreshedClaims(a.userId, null, []);
    const gone = await asUser(refreshed, async (client) => {
      const result = await client.query<{ n: string }>(
        'select count(*)::text as n from public.organizations where id = $1',
        [a.orgId],
      );
      return result.rows;
    });
    expect(gone[0]?.n).toBe('0');
  });

  it('7. An invite token works once and then fails', async () => {
    const a = await createTenant('Org A');
    const invitee = await createTenant('Invitee', { withMembership: false });

    const tokenRow = await tx(async (client) => {
      const result = await client.query<{ app: string }>(
        'select app.create_invite($1, $2, $3, $4::uuid[]) as app',
        [a.orgId, 'invitee@example.test', 'member', [a.branchId]],
      );
      return result.rows[0]!.app;
    });

    const first = await asUser(invitee.claims, async (client) => {
      const result = await client.query<{ app: string }>('select app.accept_invite($1) as app', [
        tokenRow,
      ]);
      return result.rows[0]!.app;
    });
    expect(first).toBeTruthy();

    const error = await expectError(() =>
      asUser(invitee.claims, async (client) => {
        await client.query('select app.accept_invite($1)', [tokenRow]);
      }),
    );
    expect(error.message).toMatch(/already been used/i);
  });

  it('8. Invite tokens are stored hashed with no plaintext in the table', async () => {
    const a = await createTenant('Org A');

    const token = await tx(async (client) => {
      const result = await client.query<{ app: string }>(
        'select app.create_invite($1, $2) as app',
        [a.orgId, 'hashed@example.test'],
      );
      return result.rows[0]!.app;
    });

    const rows = await sql<{ token_hash: string }>(
      'select token_hash from public.invites where org_id = $1',
      [a.orgId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).not.toBe(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // The raw token never appears anywhere in the table.
    const plaintext = await sql<{ n: string }>(
      `select count(*)::text as n from public.invites
        where org_id = $1
          and (token_hash = $2 or email = $2 or coalesce(role,'') = $2)`,
      [a.orgId, token],
    );
    expect(plaintext[0]?.n).toBe('0');
  });
});

describe('M1 schema and indexes', () => {
  it('9. Every foreign key column has an index', async () => {
    const rows = await sql<{ table_name: string; constraint_name: string }>(
      `with fks as (
         select cl.relname as table_name, c.conname as constraint_name, c.conrelid as table_oid,
                ('{' || replace(translate(c.conkey::text, '{}', ''), ' ', ',') || '}')::int[] as fk_cols,
                array_length(c.conkey, 1) as ncols
           from pg_constraint c
           join pg_class cl on cl.oid = c.conrelid
           join pg_namespace n on n.oid = cl.relnamespace
          where c.contype = 'f' and n.nspname = 'public' and cl.relispartition = false
       ),
       idx as (
         select i.indrelid, i.indnkeyatts,
                ('{' || replace(translate(i.indkey::text, '{}', ''), ' ', ',') || '}')::int[] as idx_cols
           from pg_index i where i.indisvalid
       )
       select f.table_name, f.constraint_name
         from fks f
        where not exists (
          select 1 from idx i
           where i.indrelid = f.table_oid
             and i.indnkeyatts >= f.ncols
             and i.idx_cols[1:f.ncols] = f.fk_cols[1:f.ncols]
        )`,
    );
    expect(rows).toEqual([]);
  });

  it('10. Every tenant table has org_id, created_at and RLS enabled and forced', async () => {
    for (const table of TENANT_TABLES) {
      const row = await sql<{
        org_id_not_null: boolean;
        created_at_not_null: boolean;
        rls_enabled: boolean;
        rls_forced: boolean;
      }>(
        `select
           (select a.attnotnull from pg_attribute a
             where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0) as org_id_not_null,
           (select a.attnotnull from pg_attribute a
             where a.attrelid = c.oid and a.attname = 'created_at' and a.attnum > 0) as created_at_not_null,
           c.relrowsecurity as rls_enabled,
           c.relforcerowsecurity as rls_forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table.name],
      );
      const info = row[0];
      expect(info, `${table.name} not found`).toBeDefined();
      expect(info!.org_id_not_null, `${table.name}.org_id`).toBe(true);
      expect(info!.created_at_not_null, `${table.name}.created_at`).toBe(true);
      expect(info!.rls_enabled, `${table.name} RLS enabled`).toBe(true);
      expect(info!.rls_forced, `${table.name} RLS forced`).toBe(true);
    }
  });

  it('11. Branch-scoped high-volume tables have the (org_id, branch_id, created_at desc, id desc) index', async () => {
    const expected = ['org_id', 'branch_id', 'created_at', 'id'];
    for (const table of [
      'warehouses', 'stock_ledger', 'stock_consumptions', 'stock_balances',
      'stock_layer_balances', 'stock_transfers', 'journals', 'journal_lines',
      'sales_orders', 'invoices', 'invoice_lines', 'payments', 'credit_notes',
      'purchase_orders', 'audit_logs',
    ]) {
      const rows = await sql<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = $1`,
        [table],
      );
      const match = rows.find((r) => {
        const def = r.indexdef.toLowerCase();
        return (
          def.includes('(org_id, branch_id, created_at desc, id desc)') ||
          /\(org_id, branch_id, created_at desc, id desc\)/.test(def)
        );
      });
      expect(match, `${table} missing (org_id, branch_id, created_at desc, id desc) index`)
        .toBeDefined();
      expect(expected.length).toBe(4);
    }
  });

  it('12. No float, real or double columns exist in the schema', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }>(
      `select c.relname as table_name, a.attname as column_name, t.typname as data_type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_type t on t.oid = a.atttypid
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
          and t.typname in ('float4', 'float8', 'real', 'double precision')`,
    );
    expect(rows).toEqual([]);
  });

  it('13. Partitioned tables have created_at in their primary key', async () => {
    for (const table of ['journals', 'journal_lines', 'stock_ledger', 'stock_consumptions', 'audit_logs']) {
      const rows = await sql<{ pk_cols: string[] }>(
        `select array_agg(a.attname order by k.ord) as pk_cols
           from pg_constraint c
           join pg_class cl on cl.oid = c.conrelid
           join pg_namespace n on n.oid = cl.relnamespace
           cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = cl.oid and a.attnum = k.attnum
          where c.contype = 'p' and n.nspname = 'public' and cl.relname = $1
          group by c.conname`,
        [table],
      );
      expect(rows[0]?.pk_cols, `${table} has no primary key`).toBeDefined();
      expect(rows[0]!.pk_cols, `${table} pk must include created_at`).toContain('created_at');
    }
  });

  it('14. Partitions exist for the current month and the next month', async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const nextKey = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, '0')}`;

    for (const table of ['journals', 'journal_lines', 'stock_ledger', 'stock_consumptions', 'audit_logs']) {
      for (const key of [current, nextKey]) {
        const rows = await sql<{ n: string }>(
          `select count(*)::text as n from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = $1 and c.relispartition`,
          [`${table}_${key}`],
        );
        expect(rows[0]?.n, `missing partition ${table}_${key}`).toBe('1');
      }
    }
  });
});
