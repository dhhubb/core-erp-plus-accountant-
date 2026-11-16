import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { one, sql, tx } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { createInvoice } from '../src/core/sales';
import { parseCsv } from '../src/verticals/import/csv';
import {
  applyMapping,
  naturalKey,
  suggestMapping,
  validateMapping,
  type ImportKind,
} from '../src/verticals/import/mapping';
import {
  commitImportJob,
  createImportJob,
  listImportRows,
  loadImportChunk,
  stageImportRows,
  updateImportRow,
  validateImportJob,
} from '../src/verticals/import/jobs';

/**
 * H5 — the migration wizard. Tests 75–77, continuing from H4's 74 (ADR-0010, ADR-0026).
 *
 * Everything runs against the real local Postgres. The wizard is driven exactly as the branch
 * drives it: parse the sample file, map the columns, COPY the rows into the staging table, validate
 * in SQL, and commit the whole job in one transaction. Nothing is mocked.
 */

const SAMPLES = path.resolve(__dirname, '..', 'samples');

function sample(name: string): { headers: string[]; rows: Array<Record<string, string>> } {
  return parseCsv(readFileSync(path.join(SAMPLES, name), 'utf8'));
}

/** Seed a branch with a MAIN warehouse, so opening stock has somewhere to land. */
async function seedBranch(tenant: Tenant): Promise<string> {
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'MAIN', 'Main store') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  return warehouse!.id;
}

/**
 * Run the whole wizard for one file: open the job, stage every row with COPY, validate, and return
 * the job id and the mapping the wizard guessed. The caller commits (or does not).
 */
async function stageFile(
  tenant: Tenant,
  kind: ImportKind,
  fileName: string,
  client: PoolClient,
  mapping?: Record<string, string>,
): Promise<{ jobId: string; mapping: Record<string, string>; rows: number }> {
  const file = sample(fileName);
  const chosen = mapping ?? suggestMapping(kind, file.headers);
  const job = await createImportJob(client, {
    orgId: tenant.orgId,
    branchId: tenant.branchId,
    kind,
    sourceName: fileName,
    mapping: chosen,
  });
  const rows = await stageImportRows(client, {
    orgId: tenant.orgId,
    branchId: tenant.branchId,
    jobId: job.jobId,
    kind,
    mapping: chosen,
    rows: file.rows,
  });
  return { jobId: job.jobId, mapping: chosen, rows };
}

describe('H5 migration wizard', () => {
  it('75. A 5,000-product import completes under 2 seconds using COPY', async () => {
    const tenant = await createTenant('H5 75');
    await seedBranch(tenant);

    const file = sample('products-5000.csv');
    expect(file.rows).toHaveLength(5000);

    const started = Date.now();
    const result = await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      const validation = await validateImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: staged.jobId,
      });
      expect(validation.status).toBe('validated');
      expect(validation.invalidRows).toBe(0);

      const commit = await commitImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: staged.jobId,
      });
      return { staged, commit };
    });
    const elapsedMs = Date.now() - started;

    expect(result.commit.created).toBe(5000);
    expect(result.commit.committedRows).toBe(5000);

    // The rows really are in the database.
    const count = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(count!.n).toBe('5000');

    // Every product got a default variant, so it is sellable at the till.
    const variants = await one<{ n: string }>(
      'select count(*)::text as n from public.product_variants where org_id = $1',
      [tenant.orgId],
    );
    expect(variants!.n).toBe('5000');

    // Prices landed in the retail price list.
    const priced = await one<{ n: string }>(
      `select count(*)::text as n
         from public.price_list_items pli
         join public.price_lists pl on pl.id = pli.price_list_id
        where pl.org_id = $1 and pl.kind = 'retail'`,
      [tenant.orgId],
    );
    expect(priced!.n).toBe('5000');

    // The gate is 2 seconds. The COPY itself is well under; assert on the measured wall clock.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('76. Invalid rows are reported by row number and block commit until fixed', async () => {
    const tenant = await createTenant('H5 76');
    await seedBranch(tenant);

    const { jobId } = await tx((client) => stageFile(tenant, 'products', 'products-with-errors.csv', client));

    const validation = await tx((client) =>
      validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId }),
    );
    expect(validation.status).toBe('invalid');
    expect(validation.totalRows).toBe(6);
    // Row 1 is good; rows 2-6 each break one rule.
    expect(validation.invalidRows).toBe(5);

    // The errors are listed against the file's row numbers (the header is row 0, so data row 1 is
    // the first data line and the failing rows are 2, 3, 4, 5 and 6).
    const page = await tx((client) =>
      listImportRows(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId }),
    );
    const byRowNo = new Map(page.rows.map((row) => [row.row_no, row]));
    expect(byRowNo.get(1)!.status).toBe('valid');
    expect(byRowNo.get(1)!.errors).toEqual([]);

    expect(byRowNo.get(2)!.status).toBe('invalid');
    expect(byRowNo.get(2)!.errors.map((e) => e.field)).toContain('external_code');
    expect(byRowNo.get(3)!.errors.map((e) => e.field)).toContain('name');
    expect(byRowNo.get(4)!.errors.map((e) => e.field)).toContain('price');
    expect(byRowNo.get(5)!.errors.map((e) => e.field)).toContain('unit');
    expect(byRowNo.get(6)!.errors.map((e) => e.field)).toContain('price');

    // Commit is blocked while any row is invalid.
    const blocked = await tx(async (client) => {
      try {
        await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId });
        return null;
      } catch (error) {
        return error as Error;
      }
    });
    expect(blocked).not.toBeNull();
    expect(blocked!.message).toMatch(/invalid rows/i);

    // Nothing was committed: no product rows exist yet.
    const before = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(before!.n).toBe('0');

    // Fix the five rows in the UI (PATCH), revalidate, and the commit goes through.
    const fixes: Array<[number, Record<string, string>]> = [
      [2, { external_code: 'B0002', name: 'Missing stock code', unit: 'each', price: '10.00' }],
      [3, { external_code: 'B0003', name: 'Had no description', unit: 'each', price: '10.00' }],
      [4, { external_code: 'B0004', name: 'Bad price', unit: 'each', price: '10.00' }],
      [5, { external_code: 'B0005', name: 'Bad unit', unit: 'each', price: '10.00' }],
      [6, { external_code: 'B0006', name: 'Negative price', unit: 'each', price: '4.00' }],
    ];
    for (const [rowNo, data] of fixes) {
      const row = byRowNo.get(rowNo)!;
      const updated = await tx((client) =>
        updateImportRow(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          rowId: row.row_id,
          data,
        }),
      );
      expect(updated.status, `row ${rowNo} should be valid after the fix`).toBe('valid');
    }

    const revalidated = await tx((client) =>
      validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId }),
    );
    expect(revalidated.status).toBe('validated');
    expect(revalidated.invalidRows).toBe(0);

    const committed = await tx((client) =>
      commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId }),
    );
    expect(committed.created).toBe(6);
  });

  it('77. A failed import leaves no partial data and re-running creates no duplicates', async () => {
    const tenant = await createTenant('H5 77');
    await seedBranch(tenant);

    // First run: import the good file and commit it.
    const first = await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(first.created).toBe(5000);

    const afterFirst = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(afterFirst!.n).toBe('5000');

    // A failed run: a file whose rows are valid but whose commit cannot succeed must roll back
    // completely. This file names the same Pastel code twice, so the products upsert (keyed on
    // external_code) cannot succeed; the rows are individually valid, so validation passes and the
    // failure happens part-way through the commit.
    const collidingFile = parseCsv(
      [
        'StockCode,Description,SellingPrice',
        'DUP1,First copy,10.00',
        'DUP2,Second copy,11.00',
        'DUP1,Duplicate code,12.00',
      ].join('\n'),
    );
    const mapping = { StockCode: 'external_code', Description: 'name', SellingPrice: 'price' };
    expect(validateMapping('products', mapping)).toEqual([]);

    const before = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );

    const failure = await tx(async (client) => {
      const job = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'duplicate-code.csv',
        mapping,
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
        kind: 'products',
        mapping,
        rows: collidingFile.rows,
      });
      const validation = await validateImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
      });
      // The rows are valid; the failure only appears at commit.
      expect(validation.invalidRows).toBe(0);
      try {
        await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: job.jobId });
        return null;
      } catch (error) {
        return error as Error;
      }
    });
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/cannot affect row a second time|duplicate key|unique/i);

    // The failed job left no partial data: the product count is unchanged.
    const afterFailure = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(afterFailure!.n).toBe(before!.n);
    expect(afterFailure!.n).toBe('5000');

    // Re-running the original file updates the existing rows instead of duplicating them.
    const second = await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(5000);

    const afterSecond = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(afterSecond!.n).toBe('5000');
  });
});

describe('H5 opening stock and mapping', () => {
  it('78. Opening stock writes opening ledger rows and one balanced journal', async () => {
    const tenant = await createTenant('H5 78');
    await seedBranch(tenant);

    // Products first: opening stock references their Pastel codes.
    await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });

    const commit = await tx(async (client) => {
      const staged = await stageFile(tenant, 'opening_stock', 'opening-stock.csv', client);
      const validation = await validateImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: staged.jobId,
      });
      expect(validation.status).toBe('validated');
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });

    expect(commit.created).toBe(1200);
    expect(commit.journalId).not.toBeNull();

    // Every opening row is an append-only 'opening' ledger row.
    const ledger = await one<{ n: string; v: string }>(
      `select count(*)::text as n, coalesce(sum(qty * unit_cost), 0)::text as v
         from public.stock_ledger
        where org_id = $1 and source_type = 'opening'`,
      [tenant.orgId],
    );
    expect(ledger!.n).toBe('1200');
    expect(Number(ledger!.v)).toBeCloseTo(commit.totalValue.toNumber(), 2);

    // The journal balances: Dr Inventory = Cr Opening Balance Equity, through the hook.
    const journal = await one<{ source_type: string; debit: string; credit: string }>(
      `select j.source_type,
              sum(jl.base_debit)::text  as debit,
              sum(jl.base_credit)::text as credit
         from public.journals j
         join public.journal_lines jl on jl.journal_id = j.id
        where j.id = $1
        group by j.source_type`,
      [commit.journalId],
    );
    expect(journal!.source_type).toBe('opening');
    expect(Number(journal!.debit)).toBeCloseTo(Number(journal!.credit), 4);
    expect(Number(journal!.debit)).toBeCloseTo(commit.totalValue.toNumber(), 2);

    // The credit landed in Opening Balance Equity (3900).
    const equity = await one<{ code: string }>(
      `select a.code
         from public.journal_lines jl
         join public.chart_of_accounts a on a.id = jl.account_id
        where jl.journal_id = $1 and jl.base_credit > 0`,
      [commit.journalId],
    );
    expect(equity!.code).toBe('3900');
  });

  it('79. Opening stock is idempotent: a re-run does not double-count', async () => {
    const tenant = await createTenant('H5 79');
    await seedBranch(tenant);

    await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });

    const first = await tx(async (client) => {
      const staged = await stageFile(tenant, 'opening_stock', 'opening-stock.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(first.created).toBe(1200);

    const second = await tx(async (client) => {
      const staged = await stageFile(tenant, 'opening_stock', 'opening-stock.csv', client);
      const validation = await validateImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: staged.jobId,
      });
      // Every row is recognised as already committed, so it is skipped rather than re-posted.
      expect(validation.skippedRows).toBe(1200);
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(second.created).toBe(0);
    expect(second.committedRows).toBe(0);

    const ledger = await one<{ n: string }>(
      `select count(*)::text as n from public.stock_ledger
        where org_id = $1 and source_type = 'opening'`,
      [tenant.orgId],
    );
    expect(ledger!.n).toBe('1200');
  });

  it('85. Imported opening stock is consumed by a later sale at the imported cost', async () => {
    const tenant = await createTenant('H5 85');
    await seedBranch(tenant);

    // One product, ten units on hand at 4.0000 each, imported from Pastel.
    const productFile = parseCsv(['Code,Description,Price', 'P1,Widget,9.00'].join('\n'));
    const openingFile = parseCsv(['Code,Warehouse,Qty,Cost', 'P1,MAIN,10,4.00'].join('\n'));

    await tx(async (client) => {
      const productsJob = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        mapping: { Code: 'external_code', Description: 'name', Price: 'price' },
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: productsJob.jobId,
        kind: 'products',
        mapping: { Code: 'external_code', Description: 'name', Price: 'price' },
        rows: productFile.rows,
      });
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: productsJob.jobId });
      await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: productsJob.jobId });

      const openingMapping = { Code: 'external_code', Warehouse: 'warehouse_code', Qty: 'qty', Cost: 'unit_cost' };
      const openingJob = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'opening_stock',
        mapping: openingMapping,
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: openingJob.jobId,
        kind: 'opening_stock',
        mapping: openingMapping,
        rows: openingFile.rows,
      });
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: openingJob.jobId });
      await commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: openingJob.jobId });
    });

    const product = await one<{ id: string; variant_id: string }>(
      `select p.id, v.id as variant_id
         from public.products p
         join public.product_variants v on v.product_id = p.id
        where p.org_id = $1 and p.external_code = 'P1'`,
      [tenant.orgId],
    );
    const warehouse = await one<{ id: string }>(
      `select id from public.warehouses where org_id = $1 and branch_id = $2 and code = 'MAIN'`,
      [tenant.orgId, tenant.branchId],
    );

    // Sell two units. The COGS must be the imported cost (2 x 4.0000), which proves the FIFO layer
    // the import created is the layer the sale consumed.
    const invoice = await tx((client) =>
      createInvoice(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        invoiceDate: '2026-06-15',
        lines: [
          {
            productId: product!.id,
            variantId: product!.variant_id,
            warehouseId: warehouse!.id,
            qty: '2',
            unitPrice: '9.00',
          },
        ],
      }),
    );
    expect(invoice.invoiceNo).toBeTruthy();

    const cogs = await one<{ amount: string }>(
      `select sum(jl.base_debit)::text as amount
         from public.journal_lines jl
         join public.journals j on j.id = jl.journal_id
         join public.chart_of_accounts a on a.id = jl.account_id
        where j.org_id = $1 and a.code = '5000'`,
      [tenant.orgId],
    );
    expect(Number(cogs!.amount)).toBeCloseTo(8, 4);

    const balance = await one<{ qty: string; value: string }>(
      `select qty::text, value::text from public.stock_balances
        where org_id = $1 and product_id = $2`,
      [tenant.orgId, product!.id],
    );
    expect(Number(balance!.qty)).toBeCloseTo(8, 4);
    expect(Number(balance!.value)).toBeCloseTo(32, 4);
  });

  it('80. Customers import by external code and are idempotent', async () => {
    const tenant = await createTenant('H5 80');
    await seedBranch(tenant);

    const first = await tx(async (client) => {
      const staged = await stageFile(tenant, 'customers', 'customers.csv', client);
      const validation = await validateImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: staged.jobId,
      });
      expect(validation.status).toBe('validated');
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(first.created).toBe(300);

    const second = await tx(async (client) => {
      const staged = await stageFile(tenant, 'customers', 'customers.csv', client);
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(300);

    const count = await one<{ n: string }>(
      'select count(*)::text as n from public.contacts where org_id = $1',
      [tenant.orgId],
    );
    expect(count!.n).toBe('300');
  });

  it('81. The column mapping is validated and saved per shop', async () => {
    const tenant = await createTenant('H5 81');

    // A required field that is not mapped is rejected before anything is staged.
    expect(validateMapping('products', { Description: 'name' })).toContain(
      'required field "external_code" is not mapped',
    );
    // Two columns may not map to the same field.
    expect(validateMapping('products', { A: 'name', B: 'name', C: 'external_code' }).length).toBeGreaterThan(0);
    // An unknown target is rejected.
    expect(validateMapping('products', { A: 'nonsense' }).length).toBeGreaterThan(0);

    const mapping = { StockCode: 'external_code', Description: 'name' };
    await tx((client) =>
      client.query('select app.import_save_mapping($1, $2, $3, $4::jsonb)', [
        tenant.orgId,
        tenant.branchId,
        'products',
        JSON.stringify(mapping),
      ]),
    );

    const saved = await one<{ mapping: Record<string, string> }>(
      `select app.import_get_mapping($1, $2, 'products') as mapping`,
      [tenant.orgId, tenant.branchId],
    );
    expect(saved!.mapping).toEqual(mapping);

    // A second save updates the same row rather than adding one.
    await tx((client) =>
      client.query('select app.import_save_mapping($1, $2, $3, $4::jsonb)', [
        tenant.orgId,
        tenant.branchId,
        'products',
        JSON.stringify({ StockCode: 'external_code', Description: 'name', SellingPrice: 'price' }),
      ]),
    );
    const rows = await one<{ n: string }>(
      `select count(*)::text as n from public.import_mappings
        where org_id = $1 and branch_id = $2 and kind = 'products'`,
      [tenant.orgId, tenant.branchId],
    );
    expect(rows!.n).toBe('1');
  });

  it('82. The import tables are tenant-scoped and well-formed', async () => {
    for (const table of ['import_jobs', 'import_rows', 'import_mappings']) {
      const info = await one<{
        org_id: boolean;
        created_at: boolean;
        rls: boolean;
        forced: boolean;
      }>(
        `select
           exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'org_id' and a.attnotnull) as org_id,
           exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'created_at' and a.attnotnull) as created_at,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      expect(info, `${table} not found`).toEqual({ org_id: true, created_at: true, rls: true, forced: true });

      const index = await one<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and tablename = $1
            and indexdef like '%(org_id, branch_id, created_at DESC, id DESC)%'`,
        [table],
      );
      expect(index, `${table} missing the high-volume branch index`).toBeDefined();
    }

    // Every foreign key on the new tables has an index.
    const missing = await sql(
      `with fks as (
         select c.conrelid as table_oid,
                ('{' || replace(translate(c.conkey::text, '{}', ''), ' ', ',') || '}')::int[] as fk_cols,
                array_length(c.conkey, 1) as ncols
           from pg_constraint c
           join pg_class cl on cl.oid = c.conrelid
           join pg_namespace n on n.oid = cl.relnamespace
          where c.contype = 'f' and n.nspname = 'public'
            and cl.relname in ('import_jobs', 'import_rows', 'import_mappings')
       ),
       idx as (
         select i.indrelid, i.indnkeyatts,
                ('{' || replace(translate(i.indkey::text, '{}', ''), ' ', ',') || '}')::int[] as idx_cols
           from pg_index i where i.indisvalid
       )
       select f.table_oid from fks f
        where not exists (
          select 1 from idx i
           where i.indrelid = f.table_oid
             and i.indnkeyatts >= f.ncols
             and i.idx_cols[1:f.ncols] = f.fk_cols[1:f.ncols])`,
    );
    expect(missing).toEqual([]);
  });
});

describe('H5 mapping unit behaviour', () => {
  it('83. applyMapping drops empty cells and naturalKey is the opening-stock key', () => {
    const mapping = { Code: 'external_code', Name: 'name', Price: 'price' };
    expect(applyMapping(mapping, { Code: ' P1 ', Name: '', Price: '10.00' })).toEqual({
      external_code: 'P1',
      price: '10.00',
    });

    expect(naturalKey('products', { external_code: 'P1' })).toBeNull();
    expect(naturalKey('opening_stock', { external_code: 'P1', warehouse_code: 'MAIN' })).toBe(
      'opening_stock:P1@MAIN',
    );
    expect(naturalKey('opening_stock', { sku: 'SKU1' })).toBe('opening_stock:SKU1@default');
  });

  it('84. loadImportChunk numbers rows contiguously across chunks', async () => {
    const tenant = await createTenant('H5 84');

    const rows = Array.from({ length: 12 }, (_, i) => ({
      external_code: `X${i + 1}`,
      name: `Item ${i + 1}`,
      unit: 'each',
    }));

    const jobId = await tx(async (client) => {
      const job = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        mapping: { external_code: 'external_code', name: 'name', unit: 'unit' },
      });
      await loadImportChunk(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
        startRowNo: 1,
        rows: rows.slice(0, 5),
      });
      await loadImportChunk(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
        startRowNo: 6,
        rows: rows.slice(5),
      });
      return job.jobId;
    });

    const page = await tx((client) =>
      listImportRows(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId, limit: 100 }),
    );
    expect(page.rows.map((row) => row.row_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(page.next_after_row_no).toBeNull();
  });
});
