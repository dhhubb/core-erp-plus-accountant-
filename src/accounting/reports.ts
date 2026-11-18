import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { money, moneyFromSql } from '../core/money';

/**
 * The accountant's data access. Every figure comes from an `app.report_*` SQL function, so the
 * statements reconcile with each other and a closed period reprints the same way (ADR-0065). No
 * `any` appears in this folder: an ESLint override sets `@typescript-eslint/no-explicit-any: error`
 * for `src/accounting/**`.
 *
 * A read takes the caller's `PoolClient` (the request path opens it as the user, so RLS scopes the
 * rows). Money is NUMERIC in SQL and Decimal here; nothing is ever a JS number.
 */

export interface Period {
  from: string;
  to: string;
}

export interface ActivityRow {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  section: string;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
  [key: string]: unknown;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  accountType: string;
  section: string;
  opening: Decimal;
  debit: Decimal;
  credit: Decimal;
  closing: Decimal;
}

export interface StatementLine {
  section: string;
  code: string | null;
  name: string;
  amount: Decimal;
}

export interface ProfitAndLoss {
  revenue: StatementLine[];
  costOfSales: StatementLine[];
  operatingExpenses: StatementLine[];
  totalRevenue: Decimal;
  totalCostOfSales: Decimal;
  grossProfit: Decimal;
  totalOperatingExpenses: Decimal;
  netProfit: Decimal;
}

export interface BalanceSheet {
  assets: { current: StatementLine[]; nonCurrent: StatementLine[] };
  liabilities: { current: StatementLine[]; nonCurrent: StatementLine[] };
  equity: StatementLine[];
  totalAssets: Decimal;
  totalLiabilities: Decimal;
  totalEquity: Decimal;
  difference: Decimal;
  balanced: boolean;
}

export interface EquityRow {
  kind: string;
  code: string | null;
  name: string;
  opening: Decimal;
  movement: Decimal;
  closing: Decimal;
}

export interface EquityStatement {
  rows: EquityRow[];
  openingEquity: Decimal;
  profitForPeriod: Decimal;
  otherMovements: Decimal;
  closingEquity: Decimal;
}

export interface CashFlowLine {
  activity: string;
  code: string | null;
  name: string;
  amount: Decimal;
}

export interface CashFlow {
  rows: CashFlowLine[];
  operating: Decimal;
  investing: Decimal;
  financing: Decimal;
  openingCash: Decimal;
  closingCash: Decimal;
  netChange: Decimal;
  reconciles: boolean;
}

export interface AgingRow {
  contactId: string;
  contactName: string;
  current: Decimal;
  days1To30: Decimal;
  days31To60: Decimal;
  days61To90: Decimal;
  over90: Decimal;
  total: Decimal;
}

export interface AgingReport {
  rows: AgingRow[];
  totals: AgingRow;
  controlAccount: Decimal;
  reconciles: boolean;
}

export interface LedgerRow {
  lineId: string;
  postingDate: string;
  createdAt: string;
  journalId: string;
  journalCreatedAt: string;
  sourceType: string;
  journalMemo: string | null;
  description: string | null;
  debit: Decimal;
  credit: Decimal;
  runningBalance: Decimal;
}

export interface LedgerPage {
  accountId: string;
  openingBalance: Decimal;
  closingBalance: Decimal;
  rows: LedgerRow[];
  nextCursor: { afterDate: string; afterCreatedAt: string; afterId: string } | null;
}

export interface JournalRow {
  journalId: string;
  postingDate: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  currency: string;
  reversalOf: string | null;
  lineCount: number;
  totalDebit: Decimal;
  createdAt: string;
}

export interface JournalLineRow {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: Decimal;
  credit: Decimal;
  currency: string;
  exchangeRate: Decimal;
  taxRateId: string | null;
}

export interface JournalDetail {
  journal: JournalRow | null;
  lines: JournalLineRow[];
}

export interface VatRow {
  bucket: string;
  taxRate: Decimal;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
}

export interface VatReturn {
  rows: VatRow[];
  outputVat: Decimal;
  inputVat: Decimal;
  netVat: Decimal;
}

async function rows<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  params: readonly unknown[],
): Promise<T[]> {
  const result = await client.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function trialBalance(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period; includeZero?: boolean },
): Promise<TrialBalanceRow[]> {
  const result = await rows<{
    code: string;
    name: string;
    account_type: string;
    section: string;
    opening: string;
    debit: string;
    credit: string;
    closing: string;
  }>(
    client,
    `select code, name, account_type, section, opening, debit, credit, closing
       from app.report_trial_balance($1, $2, $3::date, $4::date, $5)`,
    [input.orgId, input.branchId, input.period.from, input.period.to, input.includeZero ?? false],
  );
  return result.map((row) => ({
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    section: row.section,
    opening: moneyFromSql(row.opening),
    debit: moneyFromSql(row.debit),
    credit: moneyFromSql(row.credit),
    closing: moneyFromSql(row.closing),
  }));
}

export async function profitAndLoss(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period },
): Promise<ProfitAndLoss> {
  const result = await rows<{ section: string; code: string; name: string; amount: string }>(
    client,
    `select section, code, name, amount
       from app.report_profit_and_loss($1, $2, $3::date, $4::date)`,
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );

  const lines: StatementLine[] = result.map((row) => ({
    section: row.section,
    code: row.code,
    name: row.name,
    amount: moneyFromSql(row.amount),
  }));
  const pick = (section: string) => lines.filter((line) => line.section === section);
  const sum = (section: string) =>
    money(pick(section).reduce((total, line) => total.plus(line.amount), new Decimal(0)));

  const totalRevenue = sum('revenue');
  const totalCostOfSales = sum('cost_of_sales');
  const totalOperatingExpenses = sum('operating_expense');

  return {
    revenue: pick('revenue'),
    costOfSales: pick('cost_of_sales'),
    operatingExpenses: pick('operating_expense'),
    totalRevenue,
    totalCostOfSales,
    grossProfit: money(totalRevenue.minus(totalCostOfSales)),
    totalOperatingExpenses,
    netProfit: money(totalRevenue.minus(totalCostOfSales).minus(totalOperatingExpenses)),
  };
}

export async function balanceSheet(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; asOf: string },
): Promise<BalanceSheet> {
  const result = await rows<{ section: string; code: string | null; name: string; amount: string }>(
    client,
    `select section, code, name, amount from app.report_balance_sheet($1, $2, $3::date)`,
    [input.orgId, input.branchId, input.asOf],
  );

  const lines: StatementLine[] = result.map((row) => ({
    section: row.section,
    code: row.code,
    name: row.name,
    amount: moneyFromSql(row.amount),
  }));
  const pick = (section: string) => lines.filter((line) => line.section === section);
  const sum = (section: string) =>
    money(pick(section).reduce((total, line) => total.plus(line.amount), new Decimal(0)));

  const totalAssets = money(sum('current_asset').plus(sum('non_current_asset')));
  const totalLiabilities = money(sum('current_liability').plus(sum('non_current_liability')));
  const totalEquity = money(sum('equity').plus(sum('accumulated_profit')));
  const difference = money(totalAssets.minus(totalLiabilities).minus(totalEquity));

  return {
    assets: { current: pick('current_asset'), nonCurrent: pick('non_current_asset') },
    liabilities: { current: pick('current_liability'), nonCurrent: pick('non_current_liability') },
    equity: [...pick('equity'), ...pick('accumulated_profit')],
    totalAssets,
    totalLiabilities,
    totalEquity,
    difference,
    balanced: difference.isZero(),
  };
}

export async function changesInEquity(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period },
): Promise<EquityStatement> {
  const result = await rows<{
    kind: string;
    code: string | null;
    name: string;
    opening: string;
    movement: string;
    closing: string;
  }>(
    client,
    `select kind, code, name, opening, movement, closing
       from app.report_changes_in_equity($1, $2, $3::date, $4::date)`,
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );

  const resultRows: EquityRow[] = result.map((row) => ({
    kind: row.kind,
    code: row.code,
    name: row.name,
    opening: moneyFromSql(row.opening),
    movement: moneyFromSql(row.movement),
    closing: moneyFromSql(row.closing),
  }));
  const profit = resultRows.find((row) => row.kind === 'profit_for_period');
  const equityRows = resultRows.filter((row) => row.kind !== 'profit_for_period');
  const total = (pick: (row: EquityRow) => Decimal) =>
    money(resultRows.reduce((sum, row) => sum.plus(pick(row)), new Decimal(0)));

  return {
    rows: resultRows,
    openingEquity: total((row) => row.opening),
    profitForPeriod: profit?.movement ?? new Decimal(0),
    otherMovements: money(
      equityRows.reduce((sum, row) => sum.plus(row.movement), new Decimal(0)),
    ),
    closingEquity: total((row) => row.closing),
  };
}

export async function cashFlow(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period },
): Promise<CashFlow> {
  const result = await rows<{ activity: string; code: string | null; name: string; amount: string }>(
    client,
    `select activity, code, name, amount
       from app.report_cash_flow($1, $2, $3::date, $4::date)`,
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );

  const resultRows: CashFlowLine[] = result.map((row) => ({
    activity: row.activity,
    code: row.code,
    name: row.name,
    amount: moneyFromSql(row.amount),
  }));
  const sum = (activity: string) =>
    money(
      resultRows
        .filter((row) => row.activity === activity)
        .reduce((total, row) => total.plus(row.amount), new Decimal(0)),
    );

  const openingCash = money(
    resultRows.find((row) => row.activity === 'summary' && row.name === 'Opening cash')?.amount ??
      0,
  );
  const closingCash = money(
    resultRows.find((row) => row.activity === 'summary' && row.name === 'Closing cash')?.amount ??
      0,
  );
  const operating = sum('operating');
  const investing = sum('investing');
  const financing = sum('financing');
  const netChange = money(closingCash.minus(openingCash));

  return {
    rows: resultRows,
    operating,
    investing,
    financing,
    openingCash,
    closingCash,
    netChange,
    reconciles: money(operating.plus(investing).plus(financing)).equals(netChange),
  };
}

function agingFrom(row: {
  contact_id: string;
  contact_name: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  over_90: string;
  total: string;
}): AgingRow {
  return {
    contactId: row.contact_id,
    contactName: row.contact_name,
    current: moneyFromSql(row.current),
    days1To30: moneyFromSql(row.d1_30),
    days31To60: moneyFromSql(row.d31_60),
    days61To90: moneyFromSql(row.d61_90),
    over90: moneyFromSql(row.over_90),
    total: moneyFromSql(row.total),
  };
}

const EMPTY_AGING: AgingRow = {
  contactId: '',
  contactName: 'Total',
  current: new Decimal(0),
  days1To30: new Decimal(0),
  days31To60: new Decimal(0),
  days61To90: new Decimal(0),
  over90: new Decimal(0),
  total: new Decimal(0),
};

async function aging(
  client: PoolClient,
  fn: 'app.report_ar_aging' | 'app.report_ap_aging',
  input: { orgId: string; branchId: string | null; asOf: string },
  controlCode: string,
): Promise<AgingReport> {
  const result = await rows<{
    contact_id: string;
    contact_name: string;
    current: string;
    d1_30: string;
    d31_60: string;
    d61_90: string;
    over_90: string;
    total: string;
  }>(client, `select * from ${fn}($1, $2, $3::date)`, [input.orgId, input.branchId, input.asOf]);

  const resultRows = result.map(agingFrom);
  const totals = resultRows.reduce<AgingRow>((acc, row) => {
    acc.current = money(acc.current.plus(row.current));
    acc.days1To30 = money(acc.days1To30.plus(row.days1To30));
    acc.days31To60 = money(acc.days31To60.plus(row.days31To60));
    acc.days61To90 = money(acc.days61To90.plus(row.days61To90));
    acc.over90 = money(acc.over90.plus(row.over90));
    acc.total = money(acc.total.plus(row.total));
    return acc;
  }, { ...EMPTY_AGING });

  const control = await rows<{ balance: string }>(
    client,
    `select app.report_control_account_balance($1, $2, $3, $4::date)::text as balance`,
    [input.orgId, input.branchId, controlCode, input.asOf],
  );
  const rawControl = moneyFromSql(control[0]?.balance ?? '0');
  // AR is a debit control account; AP is a credit control account. Show both as a positive
  // sub-ledger total so they compare directly.
  const controlAccount = money(rawControl.abs());

  return {
    rows: resultRows,
    totals,
    controlAccount,
    reconciles: totals.total.equals(controlAccount),
  };
}

export function arAging(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; asOf: string },
): Promise<AgingReport> {
  return aging(client, 'app.report_ar_aging', input, '1100');
}

export function apAging(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; asOf: string },
): Promise<AgingReport> {
  return aging(client, 'app.report_ap_aging', input, '2000');
}

export async function generalLedger(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string | null;
    accountId: string;
    period: Period;
    limit: number;
    cursor?: { afterDate: string; afterCreatedAt: string; afterId: string } | null;
  },
): Promise<LedgerPage> {
  const cursor = input.cursor ?? null;
  const result = await rows<{
    line_id: string;
    posting_date: string;
    created_at: string;
    journal_id: string;
    journal_created_at: string;
    source_type: string;
    journal_memo: string | null;
    description: string | null;
    debit: string;
    credit: string;
    running_balance: string;
  }>(
    client,
    `select * from app.report_general_ledger($1, $2, $3, $4::date, $5::date, $6, $7::date, $8::timestamptz, $9)`,
    [
      input.orgId,
      input.branchId,
      input.accountId,
      input.period.from,
      input.period.to,
      input.limit,
      cursor?.afterDate ?? null,
      cursor?.afterCreatedAt ?? null,
      cursor?.afterId ?? null,
    ],
  );

  const ledgerRows: LedgerRow[] = result.map((row) => ({
    lineId: row.line_id,
    postingDate: row.posting_date,
    createdAt: row.created_at,
    journalId: row.journal_id,
    journalCreatedAt: row.journal_created_at,
    sourceType: row.source_type,
    journalMemo: row.journal_memo,
    description: row.description,
    debit: moneyFromSql(row.debit),
    credit: moneyFromSql(row.credit),
    runningBalance: moneyFromSql(row.running_balance),
  }));

  const opening = await rows<{ opening: string; closing: string }>(
    client,
    `select
       app.report_control_account_balance($1, $2, a.code, ($4::date - 1))::text as opening,
       app.report_control_account_balance($1, $2, a.code, $5::date)::text as closing
     from public.chart_of_accounts a where a.org_id = $1 and a.id = $3`,
    [input.orgId, input.branchId, input.accountId, input.period.from, input.period.to],
  );

  const last = ledgerRows[ledgerRows.length - 1];
  const nextCursor =
    ledgerRows.length === input.limit && last
      ? {
          afterDate: last.postingDate,
          afterCreatedAt: last.createdAt,
          afterId: last.lineId,
        }
      : null;

  return {
    accountId: input.accountId,
    openingBalance: moneyFromSql(opening[0]?.opening ?? '0'),
    closingBalance: moneyFromSql(opening[0]?.closing ?? '0'),
    rows: ledgerRows,
    nextCursor,
  };
}

export async function journalList(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string | null;
    period: Period;
    sourceType?: string | null;
    limit: number;
    cursor?: { createdAt: string; id: string } | null;
  },
): Promise<{ rows: JournalRow[]; nextCursor: { createdAt: string; id: string } | null }> {
  const cursor = input.cursor ?? null;
  const result = await rows<{
    journal_id: string;
    posting_date: string;
    source_type: string;
    source_id: string | null;
    memo: string | null;
    currency: string;
    reversal_of: string | null;
    line_count: number;
    total_debit: string;
    created_at: string;
  }>(
    client,
    `select * from app.report_journal_list($1, $2, $3::date, $4::date, $5, $6, $7::timestamptz, $8)`,
    [
      input.orgId,
      input.branchId,
      input.period.from,
      input.period.to,
      input.sourceType ?? null,
      input.limit,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ],
  );

  const list: JournalRow[] = result.map((row) => ({
    journalId: row.journal_id,
    postingDate: row.posting_date,
    sourceType: row.source_type,
    sourceId: row.source_id,
    memo: row.memo,
    currency: row.currency,
    reversalOf: row.reversal_of,
    lineCount: row.line_count,
    totalDebit: moneyFromSql(row.total_debit),
    createdAt: row.created_at,
  }));

  const last = list[list.length - 1];
  const nextCursor =
    list.length === input.limit && last
      ? { createdAt: last.createdAt, id: last.journalId }
      : null;

  return { rows: list, nextCursor };
}

export async function journalDetail(
  client: PoolClient,
  input: { orgId: string; journalId: string; journalCreatedAt: string },
): Promise<JournalDetail> {
  const header = await rows<{
    journal_id: string;
    posting_date: string;
    source_type: string;
    source_id: string | null;
    memo: string | null;
    currency: string;
    reversal_of: string | null;
    created_at: string;
  }>(client, `select * from app.report_journal($1, $2, $3::timestamptz)`, [
    input.orgId,
    input.journalId,
    input.journalCreatedAt,
  ]);

  const lines = await rows<{
    line_no: number;
    account_id: string;
    account_code: string;
    account_name: string;
    description: string | null;
    debit: string;
    credit: string;
    currency: string;
    exchange_rate: string;
    tax_rate_id: string | null;
  }>(client, `select * from app.report_journal_lines($1, $2, $3::timestamptz)`, [
    input.orgId,
    input.journalId,
    input.journalCreatedAt,
  ]);

  const head = header[0];
  return {
    journal: head
      ? {
          journalId: head.journal_id,
          postingDate: head.posting_date,
          sourceType: head.source_type,
          sourceId: head.source_id,
          memo: head.memo,
          currency: head.currency,
          reversalOf: head.reversal_of,
          lineCount: lines.length,
          totalDebit: money(
            lines.reduce((total, line) => total.plus(moneyFromSql(line.debit)), new Decimal(0)),
          ),
          createdAt: head.created_at,
        }
      : null,
    lines: lines.map((row) => ({
      lineNo: row.line_no,
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      description: row.description,
      debit: moneyFromSql(row.debit),
      credit: moneyFromSql(row.credit),
      currency: row.currency,
      exchangeRate: new Decimal(row.exchange_rate),
      taxRateId: row.tax_rate_id,
    })),
  };
}

export async function vatReturn(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period },
): Promise<VatReturn> {
  const result = await rows<{
    bucket: string;
    tax_rate: string;
    net: string;
    tax: string;
    gross: string;
  }>(client, `select * from app.report_vat_return($1, $2, $3::date, $4::date)`, [
    input.orgId,
    input.branchId,
    input.period.from,
    input.period.to,
  ]);

  const resultRows: VatRow[] = result.map((row) => ({
    bucket: row.bucket,
    taxRate: moneyFromSql(row.tax_rate),
    net: moneyFromSql(row.net),
    tax: moneyFromSql(row.tax),
    gross: moneyFromSql(row.gross),
  }));
  const sumTax = (bucket: string) =>
    money(
      resultRows
        .filter((row) => row.bucket === bucket)
        .reduce((total, row) => total.plus(row.tax), new Decimal(0)),
    );
  const outputVat = sumTax('output');
  const inputVat = sumTax('input');

  return { rows: resultRows, outputVat, inputVat, netVat: money(outputVat.minus(inputVat)) };
}

/** Read the ledger activity rows that back the statements (used by tests and internal callers). */
export async function accountActivity(
  client: PoolClient,
  input: { orgId: string; branchId: string | null; period: Period },
): Promise<ActivityRow[]> {
  return rows<ActivityRow>(
    client,
    `select * from app.report_account_activity($1, $2, $3::date, $4::date)`,
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );
}

export interface AccountOption {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
}

/** The active accounts, for the general-ledger picker. Ordered by code, never paged. */
export async function accountList(
  client: PoolClient,
  input: { orgId: string },
): Promise<AccountOption[]> {
  const result = await rows<{ account_id: string; code: string; name: string; account_type: string }>(
    client,
    `select id as account_id, code, name, account_type
       from public.chart_of_accounts
      where org_id = $1 and is_active
      order by code`,
    [input.orgId],
  );
  return result.map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
  }));
}
