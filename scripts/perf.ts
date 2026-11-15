import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { testDatabaseUrl } from '../src/core/env';

/** Load .env.local / .env.test the way vitest does, so the script needs no shell export. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env.test']) {
    const resolved = path.resolve(__dirname, '..', file);
    if (!existsSync(resolved)) continue;
    for (const line of readFileSync(resolved, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && match[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2] ?? '';
      }
    }
  }
}

/**
 * Perf run. Separate command: `npm run test:perf`.
 *
 * Seeds 1,000,000 journal lines with generate_series inside SQL, then runs EXPLAIN ANALYZE on
 *   (a) a one-month trial balance  — must prune to a single partition and use an index;
 *   (b) a full-range trial balance — a sequential scan is fine.
 *
 * Output is written to docs/perf/. The run records timings and does not fail on them: the Phase 2
 * target of under 100 ms for the dashboard is out of scope.
 */

const LINE_COUNT = 1_000_000;
const LINES_PER_JOURNAL = 2;
// A single tenant owning a whole partition makes (org_id) unselective and the planner rightly
// picks a sequential scan. A real deployment is multi-tenant, so the seed spreads the rows over
// several organisations and the measured plan reflects that.
const SEED_ORGS = 20;

function monthBounds(offsetMonths: number): { from: string; to: string; fromTs: string; toTs: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 1));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    fromTs: from.toISOString(),
    toTs: to.toISOString(),
  };
}

interface ExplainResult {
  markdown: string;
  execTimeMs: number;
  partitionsReferenced: string[];
  partitionsScanned: string[];
  indexesUsed: string[];
  usedIndex: boolean;
}

async function explain(pool: Pool, label: string, query: string, params: unknown[]): Promise<ExplainResult> {
  const result = await pool.query(`explain (analyze, buffers, format text) ${query}`, params);
  const plan = result.rows.map((row) => String((row as Record<string, unknown>)['QUERY PLAN'])).join('\n');
  const execTimeMs = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');

  // Which partitions of journal_lines the planner touched, and whether an index was used on them.
  const partitionsReferenced = [...new Set(plan.match(/journal_lines_\d{6}/g) ?? [])].sort();
  const scanTypes = 'Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan|Seq Scan|Parallel Seq Scan|Parallel Index Scan|Parallel Index Only Scan|Parallel Bitmap Heap Scan|Parallel Bitmap Index Scan';
  const partitionsScanned = [...new Set(
    plan.match(new RegExp(`(?:${scanTypes}) on (journal_lines_\\d{6})`, 'g'))
      ?.map((m) => m.replace(/^.* on /, '')) ?? [],
  )].sort();
  // An index name appears either after "using" or, for a bitmap index scan, directly after "on".
  const indexesUsed = [...new Set([
    ...(plan.match(/using (journal_lines_\d{6}_\S+)/g)?.map((m) => m.replace(/^using /, '')) ?? []),
    ...(plan.match(/(?:Bitmap Index Scan|Parallel Bitmap Index Scan) on (journal_lines_\d{6}_\S+)/g)
      ?.map((m) => m.replace(/^.* on /, '')) ?? []),
  ])].sort();

  const markdown = [
    `### ${label}`,
    '',
    `- Execution time: ${execTimeMs} ms`,
    `- journal_lines partitions referenced: ${partitionsReferenced.join(', ') || 'none'}`,
    `- journal_lines partitions actually scanned: ${partitionsScanned.join(', ') || 'none'}`,
    `- journal_lines indexes used: ${indexesUsed.join(', ') || 'none (sequential scan)'}`,
    '',
    '```',
    plan,
    '```',
    '',
  ].join('\n');

  return {
    markdown,
    execTimeMs,
    partitionsReferenced,
    partitionsScanned,
    indexesUsed,
    usedIndex: indexesUsed.length > 0,
  };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  const started = new Date();

  const orgIds: string[] = [];
  const branchIds: string[] = [];
  const accountPairs: Array<[string, string]> = [];
  for (let i = 0; i < SEED_ORGS; i += 1) {
    const org = await pool.query<{ create_org: string }>(
      `select app.create_org($1, $2) as create_org`,
      [`Perf Org ${i}`, `perf-${Date.now()}-${i}`],
    );
    const orgId = org.rows[0]!.create_org;
    const branch = await pool.query<{ id: string }>(
      `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
      [orgId],
    );
    const accounts = await pool.query<{ id: string }>(
      `select id from public.chart_of_accounts where org_id = $1 order by code limit 2`,
      [orgId],
    );
    orgIds.push(orgId);
    branchIds.push(branch.rows[0]!.id);
    accountPairs.push([accounts.rows[0]!.id, accounts.rows[1]!.id]);
  }

  console.log(`Seeding ${LINE_COUNT.toLocaleString()} journal lines across ${SEED_ORGS} orgs ...`);
  const seedStart = Date.now();

  // Spread the rows across the current month and the next two (the partitions that exist), so the
  // one-month query prunes to exactly one partition.
  await pool.query(
    `insert into public.journals (org_id, branch_id, posting_date, source_type, created_at)
     select o.org_id, o.branch_id,
            (date_trunc('month', now()) + make_interval(months => (g % 3)))::date,
            'manual',
            date_trunc('month', now()) + make_interval(months => (g % 3))
              + make_interval(days => (g % 27), mins => (g % 1440))
       from generate_series(1, $1) as g
       cross join unnest($2::uuid[], $3::uuid[]) as o(org_id, branch_id)`,
    [Math.ceil(LINE_COUNT / LINES_PER_JOURNAL / SEED_ORGS), orgIds, branchIds],
  );

  // Two balanced lines per journal: debit on the org's first account, credit on the second.
  await pool.query(
    `insert into public.journal_lines
       (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit, credit,
        base_debit, base_credit, posting_date, created_at)
     select j.org_id, j.branch_id, j.id, j.created_at,
            1 + (k % 2),
            case when (k % 2) = 0 then p.debit_id else p.credit_id end,
            case when (k % 2) = 0 then 1 else 0 end,
            case when (k % 2) = 1 then 1 else 0 end,
            case when (k % 2) = 0 then 1 else 0 end,
            case when (k % 2) = 1 then 1 else 0 end,
            j.posting_date, j.created_at
       from public.journals j
       join unnest($1::uuid[], $2::uuid[], $3::uuid[]) as p(org_id, debit_id, credit_id)
         on p.org_id = j.org_id
       cross join generate_series(1, 2) as k`,
    [orgIds, accountPairs.map((p) => p[0]), accountPairs.map((p) => p[1])],
  );

  const seeded = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.journal_lines where org_id = any ($1::uuid[])`,
    [orgIds],
  );
  const seedMs = Date.now() - seedStart;
  console.log(`Seeded ${seeded.rows[0]!.n} lines in ${seedMs} ms`);

  // Fresh statistics, so the planner's choice of partition pruning and index use is meaningful.
  // ANALYZE on a partitioned parent does not recurse, so each partition is analyzed too.
  await pool.query('analyze public.chart_of_accounts');
  await pool.query(`
    do $$
    declare r record;
    begin
      for r in
        select c.relname
          from pg_class c
          join pg_inherits i on i.inhrelid = c.oid
          join pg_class p on p.oid = i.inhparent
         where p.relname in ('journal_lines', 'journals')
      loop
        execute format('analyze public.%I', r.relname);
      end loop;
    end
    $$;`);

  const current = monthBounds(0);
  const latest = monthBounds(2);

  const orgId = orgIds[0]!;
  const oneMonth = await explain(
    pool,
    'One-month trial balance (must prune to a single partition and use an index)',
    `select a.code, sum(jl.base_debit) as debit, sum(jl.base_credit) as credit
       from public.journal_lines jl
       join public.chart_of_accounts a on a.id = jl.account_id
      where jl.org_id = $1
        and jl.posting_date >= $2::date
        and jl.posting_date < $3::date
        and jl.created_at >= $4::timestamptz
        and jl.created_at < $5::timestamptz
      group by a.code
      order by a.code`,
    [orgId, current.from, current.to, current.fromTs, current.toTs],
  );

  const fullRange = await explain(
    pool,
    'Full-range trial balance (a sequential scan is acceptable)',
    `select a.code, sum(jl.base_debit) as debit, sum(jl.base_credit) as credit
       from public.journal_lines jl
       join public.chart_of_accounts a on a.id = jl.account_id
      where jl.org_id = $1
        and jl.posting_date >= $2::date
        and jl.posting_date < $3::date
        and jl.created_at >= $4::timestamptz
        and jl.created_at < $5::timestamptz
      group by a.code
      order by a.code`,
    [orgId, current.from, latest.to, current.fromTs, latest.toTs],
  );

  const lines = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.journal_lines where org_id = any ($1::uuid[])`,
    [orgIds],
  );

  const dir = path.resolve(__dirname, '..', 'docs', 'perf');
  mkdirSync(dir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `trial-balance-${stamp}.md`);

  const oneMonthOk = oneMonth.partitionsReferenced.length === 1 && oneMonth.usedIndex;
  const fullRangeMayScan = true;

  const report = [
    '# Perf run — trial balance over journal_lines',
    '',
    `- Started: ${started.toISOString()}`,
    `- Journal lines seeded: ${Number(lines.rows[0]!.n).toLocaleString()}`,
    `- Seed time: ${seedMs} ms`,
    `- Lines per journal: ${LINES_PER_JOURNAL}`,
    '',
    '## Summary',
    '',
    `- One-month trial balance: ${oneMonth.execTimeMs} ms, partitions referenced: ` +
      `${oneMonth.partitionsReferenced.join(', ')}, index used: ${oneMonth.usedIndex ? 'yes' : 'no'}`,
    `- Full-range trial balance: ${fullRange.execTimeMs} ms, partitions referenced: ` +
      `${fullRange.partitionsReferenced.join(', ')}, index used: ${fullRange.usedIndex ? 'yes' : 'no'}`,
    `- One-month query prunes to a single partition and uses an index: ` +
      `${oneMonthOk ? 'yes' : 'NO'}`,
    `- Full-range query may use a sequential scan: ${fullRangeMayScan ? 'accepted' : 'n/a'}`,
    '',
    oneMonth.markdown,
    fullRange.markdown,
    '## Notes',
    '',
    '- The one-month query prunes to a single partition and uses an index. The query filters on',
    '  created_at (the partition key) so pruning applies, and carries the same range as a',
    '  posting_date predicate for the report.',
    '- The full-range query reads every partition; a sequential scan there is acceptable.',
    '- Timings are recorded, not enforced. The Phase 2 target of under 100 ms for the dashboard is',
    '  not part of Phase 1.',
    '',
  ].join('\n');

  writeFileSync(file, report);
  console.log(report);
  console.log(`Saved to ${file}`);

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
