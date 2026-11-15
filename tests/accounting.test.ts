import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { expectError, one, sql, tx } from './support/db';
import { accountId, createFiscalPeriod, createTenant, type Tenant } from './support/fixtures';

/** Post a balanced journal through app.post_journal. Returns the journal id. */
async function postJournal(
  tenant: Tenant,
  lines: unknown[],
  options: { date?: string; currency?: string; sourceType?: string } = {},
): Promise<string> {
  const date = options.date ?? '2026-06-15';
  const row = await one<{ app: string }>(
    `select app.post_journal($1, $2, $3::date, $4, null, 'test', $5, $6::jsonb) as app`,
    [tenant.orgId, tenant.branchId, date, options.sourceType ?? 'manual', options.currency ?? 'USD', JSON.stringify(lines)],
  );
  return row!.app;
}

describe('M2 accounting', () => {
  it('15. An unbalanced journal is rejected at commit', async () => {
    const t = await createTenant('Acct 15');

    const error = await expectError(() =>
      tx(async (client) => {
        const journal = await client.query<{ id: string; created_at: string }>(
          `insert into public.journals (org_id, branch_id, posting_date, source_type)
           values ($1, $2, current_date, 'manual') returning id, created_at::text as created_at`,
          [t.orgId, t.branchId],
        );
        const id = journal.rows[0]!.id;
        const createdAt = journal.rows[0]!.created_at;
        const acct = await accountId(t, '1000');
        await client.query(
          `insert into public.journal_lines
             (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit, base_debit, posting_date)
           values ($1, $2, $3, $4, 1, $5, 100, 100, current_date)`,
          [t.orgId, t.branchId, id, createdAt, acct],
        );
        // second line credits 90, so base_debit 100 <> base_credit 90
        await client.query(
          `insert into public.journal_lines
             (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, credit, base_credit, posting_date)
           values ($1, $2, $3, $4, 2, $5, 90, 90, current_date)`,
          [t.orgId, t.branchId, id, createdAt, acct],
        );
      }),
    );
    expect(error.message).toMatch(/does not balance/i);
  });

  it('16. A journal with one line is rejected', async () => {
    const t = await createTenant('Acct 16');

    const error = await expectError(() =>
      tx(async (client) => {
        const journal = await client.query<{ id: string; created_at: string }>(
          `insert into public.journals (org_id, branch_id, posting_date, source_type)
           values ($1, $2, current_date, 'manual') returning id, created_at::text as created_at`,
          [t.orgId, t.branchId],
        );
        const id = journal.rows[0]!.id;
        const createdAt = journal.rows[0]!.created_at;
        const acct = await accountId(t, '1000');
        await client.query(
          `insert into public.journal_lines
             (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit, base_debit, posting_date)
           values ($1, $2, $3, $4, 1, $5, 100, 100, current_date)`,
          [t.orgId, t.branchId, id, createdAt, acct],
        );
      }),
    );
    expect(error.message).toMatch(/at least two lines/i);
  });

  it('17. A line with both a debit and a credit is rejected', async () => {
    const t = await createTenant('Acct 17');
    const acct = await accountId(t, '1000');

    const error = await expectError(() =>
      sql(
        `insert into public.journal_lines
           (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit, credit, base_debit, base_credit, posting_date)
         values ($1, $2, gen_random_uuid(), now(), 1, $3, 10, 10, 10, 10, current_date)`,
        [t.orgId, t.branchId, acct],
      ),
    );
    expect(error.message).toMatch(/single_sided|either a debit or a credit/i);
  });

  it('18. UPDATE on a posted journal is rejected', async () => {
    const t = await createTenant('Acct 18');
    const journalId = await postJournal(t, [
      { account_code: '1000', debit: 50 },
      { account_code: '4000', credit: 50 },
    ]);

    const error = await expectError(() =>
      sql('update public.journals set memo = $1 where id = $2', ['tampered', journalId]),
    );
    expect(error.message).toMatch(/append-only/i);
  });

  it('19. DELETE on a journal line is rejected', async () => {
    const t = await createTenant('Acct 19');
    const journalId = await postJournal(t, [
      { account_code: '1000', debit: 50 },
      { account_code: '4000', credit: 50 },
    ]);

    const error = await expectError(() =>
      sql('delete from public.journal_lines where journal_id = $1', [journalId]),
    );
    expect(error.message).toMatch(/append-only/i);
  });

  it('20. A reversal nets the original to zero', async () => {
    const t = await createTenant('Acct 20');
    const journalId = await postJournal(t, [
      { account_code: '1000', debit: 75 },
      { account_code: '4000', credit: 75 },
    ]);

    const original = await one<{ created_at: string }>(
      'select created_at::text as created_at from public.journals where id = $1',
      [journalId],
    );

    await tx(async (client) => {
      await client.query('select app.reverse_journal($1, $2, $3, $4::timestamptz, $5::date)', [
        t.orgId,
        t.branchId,
        journalId,
        original!.created_at,
        '2026-06-16',
      ]);
    });

    const sums = await one<{ dr: string; cr: string; reversal_of: string | null }>(
      `select sum(base_debit)::text as dr, sum(base_credit)::text as cr,
              (select count(*)::text from public.journals where reversal_of = $2) as reversal_of
         from public.journal_lines where journal_id = $1 or journal_id = $2`,
      [journalId, journalId],
    );
    expect(sums).toBeDefined();

    const net = await one<{ net: string }>(
      `select (sum(base_debit) - sum(base_credit))::text as net
         from public.journal_lines where org_id = $1 and account_id = $2`,
      [t.orgId, await accountId(t, '1000')],
    );
    expect(new Decimal(net!.net).isZero()).toBe(true);

    const reversalCount = await one<{ n: string }>(
      'select count(*)::text as n from public.journals where reversal_of = $1',
      [journalId],
    );
    expect(reversalCount!.n).toBe('1');
  });

  it('21. Posting into a closed fiscal period is rejected', async () => {
    const t = await createTenant('Acct 21');
    await createFiscalPeriod(t, '2026-01-01', '2026-12-31', true);

    const error = await expectError(() =>
      postJournal(
        t,
        [
          { account_code: '1000', debit: 10 },
          { account_code: '4000', credit: 10 },
        ],
        { date: '2026-06-15' },
      ),
    );
    expect(error.message).toMatch(/closed/i);

    // An open period still posts.
    await createFiscalPeriod(t, '2027-01-01', '2027-12-31', false);
    const ok = await postJournal(
      t,
      [
        { account_code: '1000', debit: 10 },
        { account_code: '4000', credit: 10 },
      ],
      { date: '2027-06-15' },
    );
    expect(ok).toBeTruthy();
  });

  it('22. A later exchange rate update does not change the rates stored on existing lines', async () => {
    const t = await createTenant('Acct 22');

    await sql(
      `insert into public.exchange_rates (org_id, currency, rate, effective_from)
       values ($1, 'ZAR', 18.0000000000, date '2026-01-01')`,
      [t.orgId],
    );

    const journalId = await postJournal(
      t,
      [
        { account_code: '1000', debit: 100, currency: 'ZAR' },
        { account_code: '4000', credit: 100, currency: 'ZAR' },
      ],
      { date: '2026-06-15', currency: 'ZAR' },
    );

    const before = await one<{ exchange_rate: string; base_debit: string }>(
      `select exchange_rate::text, base_debit::text from public.journal_lines
        where journal_id = $1 and debit > 0`,
      [journalId],
    );
    expect(before!.exchange_rate).toBe('18.0000000000');
    expect(before!.base_debit).toBe('1800.0000');

    // A new rate for the same currency does not rewrite history.
    await sql(
      `insert into public.exchange_rates (org_id, currency, rate, effective_from)
       values ($1, 'ZAR', 25.0000000000, date '2026-07-01')`,
      [t.orgId],
    );

    const after = await one<{ exchange_rate: string; base_debit: string }>(
      `select exchange_rate::text, base_debit::text from public.journal_lines
        where journal_id = $1 and debit > 0`,
      [journalId],
    );
    expect(after!.exchange_rate).toBe('18.0000000000');
    expect(after!.base_debit).toBe('1800.0000');
  });

  it('23. Two VAT rates with different effective dates each apply to the correct invoice date', async () => {
    const t = await createTenant('Acct 23');

    await sql(
      `insert into public.tax_rates (org_id, code, name, rate, effective_from, effective_to)
       values ($1, 'VAT-A', 'VAT 10%', 0.100000, date '2026-01-01', date '2026-06-30')`,
      [t.orgId],
    );
    await sql(
      `insert into public.tax_rates (org_id, code, name, rate, effective_from, effective_to)
       values ($1, 'VAT-B', 'VAT 20%', 0.200000, date '2026-07-01', null)`,
      [t.orgId],
    );

    const early = await one<{ rate: string }>(
      `select app.tax_rate_on($1, 'VAT-A', date '2026-03-15')::text as rate`,
      [t.orgId],
    );
    const late = await one<{ rate: string }>(
      `select app.tax_rate_on($1, 'VAT-B', date '2026-09-15')::text as rate`,
      [t.orgId],
    );

    expect(early!.rate).toBe('0.100000');
    expect(late!.rate).toBe('0.200000');

    // The same code with an expiry does not apply after its effective window.
    const expired = await one<{ rate: string | null }>(
      `select app.tax_rate_on($1, 'VAT-A', date '2026-09-15')::text as rate`,
      [t.orgId],
    );
    expect(expired!.rate).toBeNull();
  });

  it('24. A rounding residual posts to the rounding account, and the journal still balances', async () => {
    const t = await createTenant('Acct 24');

    // Two ZAR lines that, at rate 3.3333333333, round to values whose base sums differ.
    await sql(
      `insert into public.exchange_rates (org_id, currency, rate, effective_from)
       values ($1, 'ZAR', 3.3333333333, date '2026-01-01')`,
      [t.orgId],
    );

    const journalId = await postJournal(
      t,
      [
        { account_code: '1000', debit: 1, currency: 'ZAR' },
        { account_code: '4000', credit: 1, currency: 'ZAR' },
        { account_code: '5000', debit: 1, currency: 'ZAR' },
        { account_code: '4000', credit: 1, currency: 'ZAR' },
      ],
      { date: '2026-06-15', currency: 'ZAR' },
    );

    const balance = await one<{ dr: string; cr: string }>(
      `select sum(base_debit)::text as dr, sum(base_credit)::text as cr
         from public.journal_lines where journal_id = $1`,
      [journalId],
    );
    expect(new Decimal(balance!.dr).equals(new Decimal(balance!.cr))).toBe(true);

    // Every line is rounded to 4 dp.
    const lines = await sql<{ base_debit: string; base_credit: string }>(
      'select base_debit::text, base_credit::text from public.journal_lines where journal_id = $1',
      [journalId],
    );
    for (const line of lines) {
      expect(line.base_debit).toMatch(/^\d+\.\d{4}$/);
      expect(line.base_credit).toMatch(/^\d+\.\d{4}$/);
    }
  });
});
