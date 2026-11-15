import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { money, moneyFromSql } from '../core/money';

/**
 * The accounting domain module. No `any` appears in this folder: an ESLint override in
 * `.eslintrc.json` sets `@typescript-eslint/no-explicit-any: error` for `src/accounting/**`, and
 * `npm run lint` fails if it appears.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface JournalLineInput {
  accountCode: string;
  debit?: string | Decimal;
  credit?: string | Decimal;
  currency?: string;
  exchangeRate?: string | Decimal;
  description?: string | null;
}

export interface PostedJournal {
  journalId: string;
  journalCreatedAt: string;
}

interface PostJournalResult {
  journal_id: string;
  journal_created_at: string;
}

function lineJson(line: JournalLineInput): Record<string, string | null> {
  const entry: Record<string, string | null> = { account_code: line.accountCode };
  if (line.debit !== undefined) entry['debit'] = new Decimal(line.debit).toFixed(4);
  if (line.credit !== undefined) entry['credit'] = new Decimal(line.credit).toFixed(4);
  if (line.currency !== undefined) entry['currency'] = line.currency;
  if (line.exchangeRate !== undefined) {
    entry['exchange_rate'] = new Decimal(line.exchangeRate).toString();
  }
  if (line.description !== undefined) entry['description'] = line.description;
  return entry;
}

/**
 * Post a balanced journal. The balance check runs at commit: a deferred constraint trigger on
 * journal_lines rejects a journal with fewer than two lines or whose base debits do not equal its
 * base credits. Rates are read inside this transaction.
 */
export async function postJournal(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    postingDate: string;
    sourceType: string;
    sourceId?: string | null;
    memo?: string | null;
    currency?: string;
    lines: readonly JournalLineInput[];
  },
): Promise<PostedJournal> {
  const result = await client.query<{ app: PostJournalResult }>(
    `select app.post_journal($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb) as app`,
    [
      input.orgId,
      input.branchId,
      input.postingDate,
      input.sourceType,
      input.sourceId ?? null,
      input.memo ?? null,
      input.currency ?? 'USD',
      JSON.stringify(input.lines.map(lineJson)),
    ],
  );
  const row = result.rows[0]!.app;
  return { journalId: row.journal_id, journalCreatedAt: row.journal_created_at };
}

/** Post a reversing journal whose reversal_of points at the original. Nothing is updated. */
export async function reverseJournal(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    journalId: string;
    journalCreatedAt: string;
    postingDate: string;
    memo?: string | null;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.reverse_journal($1, $2, $3, $4::timestamptz, $5::date, $6) as app',
    [
      input.orgId,
      input.branchId,
      input.journalId,
      input.journalCreatedAt,
      input.postingDate,
      input.memo ?? null,
    ],
  );
  return result.rows[0]!.app;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  debit: Decimal;
  credit: Decimal;
  balance: Decimal;
}

/**
 * Trial balance straight from journal_lines with an indexed date-range predicate. No summary
 * table and no materialized view in this phase.
 */
export async function trialBalance(
  client: PoolClient,
  input: { orgId: string; from: string; to: string; branchId?: string | null },
): Promise<TrialBalanceRow[]> {
  const result = await client.query<{
    account_id: string;
    code: string;
    name: string;
    account_type: AccountType;
    debit: string;
    credit: string;
  }>(
    `select a.id as account_id,
            a.code,
            a.name,
            a.account_type,
            coalesce(sum(jl.base_debit), 0)::text as debit,
            coalesce(sum(jl.base_credit), 0)::text as credit
       from public.journal_lines jl
       join public.chart_of_accounts a on a.id = jl.account_id
      where jl.org_id = $1
        and jl.posting_date between $2::date and $3::date
        and ($4::uuid is null or jl.branch_id = $4::uuid)
      group by a.id, a.code, a.name, a.account_type
      order by a.code`,
    [input.orgId, input.from, input.to, input.branchId ?? null],
  );

  return result.rows.map((row) => {
    const debit = moneyFromSql(row.debit);
    const credit = moneyFromSql(row.credit);
    return {
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      debit,
      credit,
      balance: money(debit.minus(credit)),
    };
  });
}

export interface StatementRow {
  code: string;
  name: string;
  accountType: AccountType;
  amount: Decimal;
}

async function statement(
  client: PoolClient,
  accountTypes: readonly AccountType[],
  input: { orgId: string; from: string; to: string; branchId?: string | null },
): Promise<StatementRow[]> {
  const result = await client.query<{
    code: string;
    name: string;
    account_type: AccountType;
    amount: string;
  }>(
    `select a.code,
            a.name,
            a.account_type,
            (coalesce(sum(jl.base_debit), 0) - coalesce(sum(jl.base_credit), 0))::text as amount
       from public.journal_lines jl
       join public.chart_of_accounts a on a.id = jl.account_id
      where jl.org_id = $1
        and jl.posting_date between $2::date and $3::date
        and ($4::uuid is null or jl.branch_id = $4::uuid)
        and a.account_type = any ($5::text[])
      group by a.code, a.name, a.account_type
      order by a.code`,
    [input.orgId, input.from, input.to, input.branchId ?? null, [...accountTypes]],
  );

  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    amount: moneyFromSql(row.amount),
  }));
}

/** Profit and loss: revenue accounts less expense accounts over the range. */
export async function profitAndLoss(
  client: PoolClient,
  input: { orgId: string; from: string; to: string; branchId?: string | null },
): Promise<{ revenue: StatementRow[]; expenses: StatementRow[]; netProfit: Decimal }> {
  const revenue = await statement(client, ['revenue'], input);
  const expenses = await statement(client, ['expense'], input);

  const revenueTotal = revenue.reduce((sum, row) => sum.plus(row.amount.negated()), new Decimal(0));
  const expenseTotal = expenses.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

  return { revenue, expenses, netProfit: money(revenueTotal.minus(expenseTotal)) };
}

/** Balance sheet: assets, liabilities and equity over the range. */
export async function balanceSheet(
  client: PoolClient,
  input: { orgId: string; from: string; to: string; branchId?: string | null },
): Promise<{ assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[] }> {
  const [assets, liabilities, equity] = await Promise.all([
    statement(client, ['asset'], input),
    statement(client, ['liability'], input),
    statement(client, ['equity'], input),
  ]);
  return { assets, liabilities, equity };
}
