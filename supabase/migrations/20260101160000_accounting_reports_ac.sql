-- AC — The accountant: financial statements and the books the owner signs.
--
-- Additive. It changes no core table shape and no core function signature. It adds read-only
-- report functions over the immutable ledger (`journals` + `journal_lines`) and the sales and
-- purchase documents, plus the accounts-payable sub-ledger that an AP aging by supplier needs.
--
-- Every report returns typed rows with NUMERIC money columns, never jsonb: `pg` returns a NUMERIC
-- as a string, so money stays exact through the boundary (AGENTS.md). Every function is SECURITY
-- INVOKER, so the caller's RLS scopes the rows; no accounting path uses the service role.
--
--   * app.report_trial_balance(org, branch, from, to, include_zero)
--   * app.report_profit_and_loss(org, branch, from, to)
--   * app.report_balance_sheet(org, branch, as_of)
--   * app.report_changes_in_equity(org, branch, from, to)
--   * app.report_cash_flow(org, branch, from, to)               -- indirect method
--   * app.report_ar_aging(org, branch, as_of)                   -- by contact, aged buckets
--   * app.report_ap_aging(org, branch, as_of)                   -- by supplier, aged buckets
--   * app.report_general_ledger(org, branch, account_id, from, to, limit, cursor)
--   * app.report_journal_list(org, branch, from, to, source_type, limit, cursor)
--   * app.report_journal(org, journal_id, journal_created_at)
--   * app.report_journal_lines(org, journal_id, journal_created_at)
--   * app.report_vat_return(org, branch, from, to)              -- ZIMRA return
--   * app.report_control_account_balance(org, branch, code, as_of)
--
-- The statements read the ledger, never a stored balance. A trial balance, a P&L and a balance
-- sheet computed from the same journal_lines over the same range always reconcile, and a closed
-- period is read the same way as an open one, so a reprint is stable.

-- ---------------------------------------------------------------------------
-- The section a statement groups an account into. Codes are the default chart of accounts; an org
-- that adds its own accounts inside a range inherits the grouping, because the range is on the code.
-- ---------------------------------------------------------------------------
create or replace function app.account_statement_section(p_account_type text, p_code text)
returns text
language sql
immutable
as $$
  select case p_account_type
    when 'asset' then
      case when p_code like '15%' or p_code like '16%' then 'non_current_asset'
           else 'current_asset' end
    when 'liability' then
      case when p_code like '25%' or p_code like '26%' then 'non_current_liability'
           else 'current_liability' end
    when 'equity' then 'equity'
    when 'revenue' then 'revenue'
    when 'expense' then
      case when p_code like '50%' then 'cost_of_sales'
           else 'operating_expense' end
    else 'other'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Cash accounts. Cash is an asset account in the bank range. The statement of cash flows treats
-- every other balance-sheet account as a non-cash adjustment.
-- ---------------------------------------------------------------------------
create or replace function app.is_cash_account(p_account_type text, p_code text)
returns boolean
language sql
immutable
as $$
  select p_account_type = 'asset' and p_code like '12%';
$$;

-- ---------------------------------------------------------------------------
-- report_account_activity: per account, the opening balance (everything posted before `from`), the
-- period debits and credits, and the closing balance. One definition of "a balance" that the trial
-- balance, the P&L, the balance sheet, the equity statement and the cash flow all read, so the
-- statements reconcile by construction.
--
-- opening/closing are signed (debit - credit): a debit balance is positive, a credit balance
-- negative. A null branch means every branch the caller's RLS allows.
-- ---------------------------------------------------------------------------
create or replace function app.report_account_activity(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  account_id   uuid,
  code         text,
  name         text,
  account_type text,
  section      text,
  opening      numeric,
  debit        numeric,
  credit       numeric,
  closing      numeric
)
language sql
stable
security invoker
as $$
  with accounts as (
    select a.id, a.code, a.name, a.account_type,
           app.account_statement_section(a.account_type, a.code) as section
      from public.chart_of_accounts a
     where a.org_id = p_org_id
  ),
  sums as (
    select jl.account_id,
           coalesce(sum(case when jl.posting_date < p_from
                             then jl.base_debit - jl.base_credit end), 0) as opening,
           coalesce(sum(case when jl.posting_date >= p_from
                             then jl.base_debit end), 0) as debit,
           coalesce(sum(case when jl.posting_date >= p_from
                             then jl.base_credit end), 0) as credit
      from public.journal_lines jl
     where jl.org_id = p_org_id
       and (p_branch_id is null or jl.branch_id = p_branch_id)
       and jl.posting_date <= p_to
     group by jl.account_id
  )
  select a.id,
         a.code,
         a.name,
         a.account_type,
         a.section,
         round(coalesce(s.opening, 0), 4),
         round(coalesce(s.debit, 0), 4),
         round(coalesce(s.credit, 0), 4),
         round(coalesce(s.opening, 0) + coalesce(s.debit, 0) - coalesce(s.credit, 0), 4)
    from accounts a
    left join sums s on s.account_id = a.id;
$$;

-- ---------------------------------------------------------------------------
-- report_trial_balance: the six-column trial balance — opening, period debit, period credit,
-- closing. An account with no movement is omitted unless `include_zero`. On a balanced ledger the
-- closing column sums to zero, which the caller can assert.
-- ---------------------------------------------------------------------------
create or replace function app.report_trial_balance(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_from         date,
  p_to           date,
  p_include_zero boolean default false
)
returns table (
  code         text,
  name         text,
  account_type text,
  section      text,
  opening      numeric,
  debit        numeric,
  credit       numeric,
  closing      numeric
)
language sql
stable
security invoker
as $$
  select a.code, a.name, a.account_type, a.section, a.opening, a.debit, a.credit, a.closing
    from app.report_account_activity(p_org_id, p_branch_id, p_from, p_to) a
   where p_include_zero
      or a.opening <> 0 or a.debit <> 0 or a.credit <> 0 or a.closing <> 0
   order by a.code;
$$;

-- ---------------------------------------------------------------------------
-- report_profit_and_loss: the period movement of every revenue and expense account, tagged with
-- its statement section ('revenue', 'cost_of_sales', 'operating_expense'). Revenue is positive;
-- an expense is positive. The route computes gross profit and net profit with Decimal.
-- ---------------------------------------------------------------------------
create or replace function app.report_profit_and_loss(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  section text,
  code    text,
  name    text,
  amount  numeric
)
language sql
stable
security invoker
as $$
  select a.section,
         a.code,
         a.name,
         round(case when a.account_type = 'revenue' then a.credit - a.debit
                    else a.debit - a.credit end, 4)
    from app.report_account_activity(p_org_id, p_branch_id, p_from, p_to) a
   where a.account_type in ('revenue', 'expense')
     and (a.debit <> 0 or a.credit <> 0)
   order by a.section, a.code;
$$;

-- ---------------------------------------------------------------------------
-- report_balance_sheet: assets, liabilities and equity as of a date, one row per account, tagged
-- with its statement section, plus a synthetic 'accumulated_profit' row (revenue less expenses
-- from inception) because this ledger posts no closing entry to retained earnings. Assets and the
-- equity section are shown as positive balances; the route totals them and asserts the identity.
-- ---------------------------------------------------------------------------
create or replace function app.report_balance_sheet(
  p_org_id    uuid,
  p_branch_id uuid,
  p_as_of     date
)
returns table (
  section text,
  code    text,
  name    text,
  amount  numeric
)
language sql
stable
security invoker
as $$
  with act as (
    select * from app.report_account_activity(p_org_id, p_branch_id, '0001-01-01'::date, p_as_of)
  ),
  balances as (
    select a.section, a.code, a.name,
           round(case when a.account_type = 'asset' then a.closing else -a.closing end, 4) as amount
      from act a
     where a.account_type in ('asset', 'liability', 'equity')
       and a.closing <> 0
  )
  select b.section, b.code, b.name, b.amount from balances b
  union all
  select 'accumulated_profit', null::text, 'Accumulated profit',
         round(coalesce(-(select sum(a.closing) from act a
                           where a.account_type in ('revenue', 'expense')), 0), 4);
$$;

-- ---------------------------------------------------------------------------
-- report_changes_in_equity: the movement in equity over a period. One row per equity account with
-- opening, movement and closing, plus a 'profit_for_period' row carrying the accumulated-profit
-- movement. Every row satisfies opening + movement = closing, and the totals reconcile with the
-- balance sheet's equity section at both ends.
-- ---------------------------------------------------------------------------
create or replace function app.report_changes_in_equity(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  kind    text,
  code    text,
  name    text,
  opening numeric,
  movement numeric,
  closing numeric
)
language sql
stable
security invoker
as $$
  with opening as (
    select * from app.report_account_activity(p_org_id, p_branch_id, '0001-01-01'::date, p_from - 1)
  ),
  period as (
    select * from app.report_account_activity(p_org_id, p_branch_id, p_from, p_to)
  ),
  equity_rows as (
    select 'equity_account'::text as kind, o.code, o.name,
           round(-o.closing, 4)                  as opening,
           round(p.credit - p.debit, 4)          as movement,
           round(-p.closing, 4)                  as closing
      from opening o
      join period p on p.account_id = o.account_id
     where o.account_type = 'equity'
  ),
  profit_row as (
    select 'profit_for_period'::text as kind, null::text as code, 'Profit for the period' as name,
           round(coalesce(-(select sum(o.closing) from opening o
                             where o.account_type in ('revenue', 'expense')), 0), 4) as opening,
           round(coalesce(-(select sum(p.debit - p.credit) from period p
                             where p.account_type in ('revenue', 'expense')), 0), 4) as movement,
           round(coalesce(-(select sum(p.closing) from period p
                             where p.account_type in ('revenue', 'expense')), 0), 4) as closing
  )
  select * from equity_rows
  union all
  select * from profit_row;
$$;

-- ---------------------------------------------------------------------------
-- report_cash_flow: the indirect method. One row per line, tagged with its activity
-- ('operating', 'investing', 'financing') or 'summary' for the opening and closing cash. The
-- operating section starts with the net profit and adjusts for the movement in current non-cash
-- assets and liabilities; investing is the movement in non-current assets; financing is the
-- movement in non-current liabilities and equity. Because the signed movement of every account
-- sums to zero, the three activities always sum to the change in cash.
-- ---------------------------------------------------------------------------
create or replace function app.report_cash_flow(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  activity text,
  code     text,
  name     text,
  amount   numeric
)
language sql
stable
security invoker
as $$
  with act as (
    select * from app.report_account_activity(p_org_id, p_branch_id, p_from, p_to)
  ),
  cash as (
    select coalesce(sum(opening), 0) as opening, coalesce(sum(closing), 0) as closing
      from act where app.is_cash_account(account_type, code)
  ),
  mv as (
    select * from act where not app.is_cash_account(account_type, code)
  ),
  lines as (
    select 'operating'::text as activity, null::text as code, 'Net profit'::text as name,
           round(coalesce(-(select sum(m.closing - m.opening) from mv m
                             where m.account_type in ('revenue', 'expense')), 0), 4) as amount
    union all
    select 'operating', m.code, m.name, round(-(m.closing - m.opening), 4)
      from mv m where m.section in ('current_asset', 'current_liability')
    union all
    select 'investing', m.code, m.name, round(-(m.closing - m.opening), 4)
      from mv m where m.section = 'non_current_asset'
    union all
    select 'financing', m.code, m.name, round(-(m.closing - m.opening), 4)
      from mv m where m.section in ('non_current_liability', 'equity')
    union all
    select 'summary', null::text, 'Opening cash'::text, c.opening from cash c
    union all
    select 'summary', null::text, 'Closing cash'::text, c.closing from cash c
  )
  select * from lines;
$$;

-- ---------------------------------------------------------------------------
-- Accounts payable sub-ledger.
--
-- The core posts to the AP control account (2000) from app.post_receipt, but it keeps no supplier
-- document, so an AP *aging* by supplier cannot be derived. This adds the missing sub-ledger: one
-- `supplier_bills` row per bill, posted Dr Expense/Inventory (subtotal), Dr VAT Input (tax),
-- Cr Accounts Payable (total). app.pay_supplier_bill applies a payment (Dr AP, Cr Bank), capped at
-- the open balance, exactly as app.allocate_payment caps a customer payment. Aging reads the open
-- balance of each bill, and the AP control account reconciles with the sub-ledger.
--
-- Additive: a new branch-scoped table and its own functions. It changes no core table or function.
-- ---------------------------------------------------------------------------
create table public.supplier_bills (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  branch_id          uuid not null references public.branches (id) on delete restrict,
  contact_id         uuid not null references public.contacts (id) on delete restrict,
  bill_no            text not null,
  bill_date          date not null,
  due_date           date not null,
  currency           text not null default 'USD',
  exchange_rate      numeric(19, 10) not null default 1,
  subtotal           numeric(19, 4) not null default 0,
  tax_total          numeric(19, 4) not null default 0,
  total              numeric(19, 4) not null default 0,
  amount_paid        numeric(19, 4) not null default 0,
  journal_id         uuid,
  journal_created_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint supplier_bills_org_no_key unique (org_id, bill_no),
  constraint supplier_bills_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint supplier_bills_totals_check check (subtotal >= 0 and tax_total >= 0 and total >= 0),
  constraint supplier_bills_paid_check check (amount_paid >= 0),
  constraint supplier_bills_due_check check (due_date >= bill_date),
  constraint supplier_bills_journal_pair_check check ((journal_id is null) = (journal_created_at is null)),
  constraint supplier_bills_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

create index supplier_bills_org_branch_created_idx
  on public.supplier_bills (org_id, branch_id, created_at desc, id desc);
create index supplier_bills_org_created_idx
  on public.supplier_bills (org_id, created_at desc, id desc);
create index supplier_bills_org_branch_due_idx
  on public.supplier_bills (org_id, branch_id, due_date, id);
create index supplier_bills_org_id_idx     on public.supplier_bills (org_id);
create index supplier_bills_branch_id_idx  on public.supplier_bills (branch_id);
create index supplier_bills_contact_id_idx on public.supplier_bills (contact_id);
create index supplier_bills_journal_idx    on public.supplier_bills (journal_id, journal_created_at);

select app.apply_tenant_rls('public.supplier_bills', 'branch');

create trigger supplier_bills_set_updated_at before update on public.supplier_bills
  for each row execute function app.set_updated_at();

-- The AP sub-ledger posts two new journal source types. Widen the check on the partitioned parent,
-- so its existing and future partitions inherit it (AGENTS.md). Additive: the applied migrations
-- are untouched and the newest definition wins.
alter table public.journals drop constraint journals_source_type_check;
alter table public.journals add constraint journals_source_type_check
  check (source_type in ('manual', 'invoice', 'receipt', 'payment', 'credit_note',
                         'stock_adjustment', 'reversal', 'layby_deposit', 'layby_cancellation',
                         'return_refund', 'opening', 'supplier_bill', 'supplier_payment'));

-- ---------------------------------------------------------------------------
-- post_supplier_bill: post one bill. Dr Expense/Inventory (subtotal), Dr VAT Input (tax),
-- Cr Accounts Payable (total). The accounts default to the chart of accounts.
-- ---------------------------------------------------------------------------
create or replace function app.post_supplier_bill(
  p_org_id          uuid,
  p_branch_id       uuid,
  p_contact_id      uuid,
  p_bill_no         text,
  p_bill_date       date,
  p_due_date        date default null,
  p_currency        text default 'USD',
  p_subtotal        numeric default 0,
  p_tax_total       numeric default 0,
  p_expense_account text default '5000',
  p_tax_account     text default '2200',
  p_ap_account      text default '2000'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id  uuid := gen_random_uuid();
  v_created  timestamptz := clock_timestamp();
  v_currency text := coalesce(p_currency, 'USD');
  v_total    numeric(19, 4);
  v_rate     numeric(19, 10);
  v_journal  uuid;
begin
  if p_subtotal is null or p_subtotal < 0 or p_tax_total is null or p_tax_total < 0 then
    raise exception 'supplier bill amounts must not be negative' using errcode = '23514';
  end if;

  v_total := round(p_subtotal + p_tax_total, 4);
  if v_total <= 0 then
    raise exception 'supplier bill total must be positive' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_bill_date);

  v_rate := app.rate_on(p_org_id, v_currency, p_bill_date);
  if v_rate is null then
    raise exception 'no exchange rate for % effective on %', v_currency, p_bill_date
      using errcode = 'no_data_found';
  end if;

  v_journal := app.post_balanced_journal(
    p_org_id, p_branch_id, p_bill_date, 'supplier_bill', v_bill_id,
    'Supplier bill ' || p_bill_no, v_currency,
    jsonb_build_array(
      jsonb_build_object('account_code', p_expense_account, 'debit', p_subtotal,
                         'currency', v_currency, 'exchange_rate', v_rate,
                         'description', 'Supplier bill'),
      jsonb_build_object('account_code', p_tax_account, 'debit', p_tax_total,
                         'currency', v_currency, 'exchange_rate', v_rate,
                         'description', 'VAT input'),
      jsonb_build_object('account_code', p_ap_account, 'credit', v_total,
                         'currency', v_currency, 'exchange_rate', v_rate,
                         'description', 'Accounts payable')
    )
  );

  insert into public.supplier_bills
    (id, org_id, branch_id, contact_id, bill_no, bill_date, due_date, currency, exchange_rate,
     subtotal, tax_total, total, journal_id, journal_created_at, created_at)
  select v_bill_id, p_org_id, p_branch_id, p_contact_id, p_bill_no, p_bill_date,
         coalesce(p_due_date, p_bill_date), v_currency, v_rate, p_subtotal, p_tax_total, v_total,
         v_journal, j.created_at, v_created
    from public.journals j where j.id = v_journal;

  return jsonb_build_object('bill_id', v_bill_id, 'bill_no', p_bill_no, 'total', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- pay_supplier_bill: apply a payment to a bill. It cannot exceed the open balance. Posts Dr AP,
-- Cr Bank.
-- ---------------------------------------------------------------------------
create or replace function app.pay_supplier_bill(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_bill_id      uuid,
  p_amount       numeric,
  p_payment_date date,
  p_bank_account text default '1200',
  p_ap_account   text default '2000'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill    public.supplier_bills%rowtype;
  v_open    numeric(19, 4);
  v_journal uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'payment amount must be positive' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_payment_date);

  select * into v_bill from public.supplier_bills where id = p_bill_id for update;
  if not found then
    raise exception 'supplier bill % not found', p_bill_id using errcode = 'no_data_found';
  end if;

  v_open := v_bill.total - v_bill.amount_paid;
  if p_amount > v_open then
    raise exception 'payment % exceeds open balance % on bill %',
      p_amount, v_open, p_bill_id using errcode = '23514';
  end if;

  v_journal := app.post_balanced_journal(
    p_org_id, p_branch_id, p_payment_date, 'supplier_payment', p_bill_id,
    'Supplier payment ' || v_bill.bill_no, v_bill.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', p_ap_account, 'debit', p_amount,
                         'currency', v_bill.currency, 'exchange_rate', v_bill.exchange_rate,
                         'description', 'Accounts payable'),
      jsonb_build_object('account_code', p_bank_account, 'credit', p_amount,
                         'currency', v_bill.currency, 'exchange_rate', v_bill.exchange_rate,
                         'description', 'Bank')
    )
  );

  update public.supplier_bills set amount_paid = amount_paid + p_amount where id = p_bill_id;

  return v_journal;
end;
$$;

-- ---------------------------------------------------------------------------
-- report_ar_aging: open customer invoices as of a date, one row per contact, aged into buckets.
-- The open balance is total - amount_paid. A credit note credits AR through the ledger, so it is
-- already reflected in the account balance; the aging reports the document exposure. Invoices have
-- no due date in this core, so the age is measured from the invoice date.
-- ---------------------------------------------------------------------------
create or replace function app.report_ar_aging(
  p_org_id    uuid,
  p_branch_id uuid,
  p_as_of     date
)
returns table (
  contact_id   uuid,
  contact_name text,
  current      numeric,
  d1_30        numeric,
  d31_60       numeric,
  d61_90       numeric,
  over_90      numeric,
  total        numeric
)
language sql
stable
security invoker
as $$
  with open_items as (
    select i.contact_id,
           round(i.total - i.amount_paid, 4) as open_amount,
           greatest((p_as_of - i.invoice_date), 0) as days_outstanding
      from public.invoices i
     where i.org_id = p_org_id
       and (p_branch_id is null or i.branch_id = p_branch_id)
       and i.invoice_date <= p_as_of
       and round(i.total - i.amount_paid, 4) > 0
  )
  select o.contact_id,
         coalesce(c.name, 'Unassigned') as contact_name,
         round(sum(case when o.days_outstanding = 0  then o.open_amount else 0 end), 4),
         round(sum(case when o.days_outstanding between 1 and 30 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_outstanding between 31 and 60 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_outstanding between 61 and 90 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_outstanding > 90 then o.open_amount else 0 end), 4),
         round(sum(o.open_amount), 4)
    from open_items o
    left join public.contacts c on c.id = o.contact_id
   group by o.contact_id, c.name
   order by coalesce(c.name, 'Unassigned'), o.contact_id;
$$;

-- ---------------------------------------------------------------------------
-- report_ap_aging: open supplier bills as of a date, one row per supplier, aged into the same
-- buckets. The age is measured from the bill's due date, so a bill inside its terms is current.
-- ---------------------------------------------------------------------------
create or replace function app.report_ap_aging(
  p_org_id    uuid,
  p_branch_id uuid,
  p_as_of     date
)
returns table (
  contact_id   uuid,
  contact_name text,
  current      numeric,
  d1_30        numeric,
  d31_60       numeric,
  d61_90       numeric,
  over_90      numeric,
  total        numeric
)
language sql
stable
security invoker
as $$
  with open_items as (
    select b.contact_id,
           round(b.total - b.amount_paid, 4) as open_amount,
           greatest((p_as_of - b.due_date), 0) as days_overdue
      from public.supplier_bills b
     where b.org_id = p_org_id
       and (p_branch_id is null or b.branch_id = p_branch_id)
       and b.bill_date <= p_as_of
       and round(b.total - b.amount_paid, 4) > 0
  )
  select o.contact_id,
         coalesce(c.name, 'Unassigned') as contact_name,
         round(sum(case when o.days_overdue = 0  then o.open_amount else 0 end), 4),
         round(sum(case when o.days_overdue between 1 and 30 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_overdue between 31 and 60 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_overdue between 61 and 90 then o.open_amount else 0 end), 4),
         round(sum(case when o.days_overdue > 90 then o.open_amount else 0 end), 4),
         round(sum(o.open_amount), 4)
    from open_items o
    left join public.contacts c on c.id = o.contact_id
   group by o.contact_id, c.name
   order by coalesce(c.name, 'Unassigned'), o.contact_id;
$$;

-- ---------------------------------------------------------------------------
-- report_control_account_balance: the ledger balance of one account code at a date, signed the way
-- a statement shows it (assets and expenses positive; liabilities, equity and revenue positive when
-- credit). Used to reconcile a sub-ledger (AR, AP) with its control account.
-- ---------------------------------------------------------------------------
create or replace function app.report_control_account_balance(
  p_org_id    uuid,
  p_branch_id uuid,
  p_code      text,
  p_as_of     date
)
returns numeric
language sql
stable
security invoker
as $$
  select round(coalesce(sum(jl.base_debit - jl.base_credit), 0), 4)
    from public.journal_lines jl
    join public.chart_of_accounts a on a.id = jl.account_id
   where jl.org_id = p_org_id
     and (p_branch_id is null or jl.branch_id = p_branch_id)
     and jl.posting_date <= p_as_of
     and a.code = p_code;
$$;

-- ---------------------------------------------------------------------------
-- report_general_ledger: the ledger for one account over a period — each posting line in order
-- with a running balance. Keyset on (posting_date, created_at, id) so a long account streams. The
-- opening balance is computed by the route from the same definition, so the running balance starts
-- from it.
-- ---------------------------------------------------------------------------
create or replace function app.report_general_ledger(
  p_org_id        uuid,
  p_branch_id     uuid,
  p_account_id    uuid,
  p_from          date,
  p_to            date,
  p_limit         int default 100,
  p_after_date    date default null,
  p_after_created timestamptz default null,
  p_after_id      uuid default null
)
returns table (
  line_id            uuid,
  posting_date       text,
  created_at         text,
  journal_id         uuid,
  journal_created_at text,
  source_type        text,
  journal_memo       text,
  description        text,
  debit              numeric,
  credit             numeric,
  running_balance    numeric
)
language sql
stable
security invoker
as $$
  with opening as (
    select coalesce(sum(jl.base_debit - jl.base_credit), 0) as amount
      from public.journal_lines jl
     where jl.org_id = p_org_id
       and (p_branch_id is null or jl.branch_id = p_branch_id)
       and jl.account_id = p_account_id
       and jl.posting_date < p_from
  ),
  -- The running balance is computed over the whole period, so it is correct on every page. The
  -- keyset filter is applied afterwards, on the already-numbered rows.
  period_rows as (
    select jl.id, jl.posting_date, jl.created_at, jl.journal_id, jl.journal_created_at,
           j.source_type, j.memo as journal_memo, jl.description,
           jl.base_debit, jl.base_credit,
           round((select amount from opening)
                 + sum(jl.base_debit - jl.base_credit)
                   over (order by jl.posting_date, jl.created_at, jl.id), 4) as running_balance
      from public.journal_lines jl
      join public.journals j on j.id = jl.journal_id and j.created_at = jl.journal_created_at
     where jl.org_id = p_org_id
       and (p_branch_id is null or jl.branch_id = p_branch_id)
       and jl.account_id = p_account_id
       and jl.posting_date between p_from and p_to
  ),
  page as (
    select *
      from period_rows
     where (p_after_date is null
            or (posting_date, created_at, id) > (p_after_date, p_after_created, p_after_id))
     order by posting_date, created_at, id
     limit app.assert_page_limit(p_limit)
  )
  select p.id, p.posting_date::text, p.created_at::text, p.journal_id, p.journal_created_at::text,
         p.source_type, p.journal_memo, p.description, p.base_debit, p.base_credit,
         p.running_balance
    from page p
   order by p.posting_date, p.created_at, p.id;
$$;

-- ---------------------------------------------------------------------------
-- report_journal_list: a keyset page of journals in a period, optionally filtered by source type.
-- Keyset on (created_at, id), descending, with the exact text cursor (ADR-0057).
-- ---------------------------------------------------------------------------
create or replace function app.report_journal_list(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_from             date,
  p_to               date,
  p_source_type      text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  journal_id   uuid,
  posting_date text,
  source_type  text,
  source_id    uuid,
  memo         text,
  currency     text,
  reversal_of  uuid,
  line_count   int,
  total_debit  numeric,
  created_at   text
)
language sql
stable
security invoker
as $$
  select j.id, j.posting_date::text, j.source_type, j.source_id, j.memo, j.currency,
         j.reversal_of,
         (select count(*)::int from public.journal_lines jl
           where jl.journal_id = j.id and jl.journal_created_at = j.created_at) as line_count,
         (select coalesce(sum(jl.base_debit), 0) from public.journal_lines jl
           where jl.journal_id = j.id and jl.journal_created_at = j.created_at) as total_debit,
         j.created_at::text
    from public.journals j
   where j.org_id = p_org_id
     and (p_branch_id is null or j.branch_id = p_branch_id)
     and j.posting_date between p_from and p_to
     and (p_source_type is null or j.source_type = p_source_type)
     and (p_after_created_at is null or (j.created_at, j.id) < (p_after_created_at, p_after_id))
   order by j.created_at desc, j.id desc
   limit app.assert_page_limit(p_limit);
$$;

-- ---------------------------------------------------------------------------
-- report_journal: one journal header, read by primary key (id, created_at).
-- ---------------------------------------------------------------------------
create or replace function app.report_journal(
  p_org_id     uuid,
  p_journal_id uuid,
  p_created_at timestamptz
)
returns table (
  journal_id   uuid,
  posting_date text,
  source_type  text,
  source_id    uuid,
  memo         text,
  currency     text,
  reversal_of  uuid,
  created_at   text
)
language sql
stable
security invoker
as $$
  select j.id, j.posting_date::text, j.source_type, j.source_id, j.memo, j.currency,
         j.reversal_of, j.created_at::text
    from public.journals j
   where j.org_id = p_org_id and j.id = p_journal_id and j.created_at = p_created_at;
$$;

-- ---------------------------------------------------------------------------
-- report_journal_lines: the lines of one journal, by primary key.
-- ---------------------------------------------------------------------------
create or replace function app.report_journal_lines(
  p_org_id     uuid,
  p_journal_id uuid,
  p_created_at timestamptz
)
returns table (
  line_no       int,
  account_id    uuid,
  account_code  text,
  account_name  text,
  description   text,
  debit         numeric,
  credit        numeric,
  currency      text,
  exchange_rate numeric,
  tax_rate_id   uuid
)
language sql
stable
security invoker
as $$
  select jl.line_no, jl.account_id, a.code, a.name, jl.description,
         jl.base_debit, jl.base_credit, jl.currency, jl.exchange_rate, jl.tax_rate_id
    from public.journal_lines jl
    join public.chart_of_accounts a on a.id = jl.account_id
   where jl.org_id = p_org_id
     and jl.journal_id = p_journal_id
     and jl.journal_created_at = p_created_at
   order by jl.line_no;
$$;

-- ---------------------------------------------------------------------------
-- report_vat_return: the VAT return for a period, one row per VAT rate, plus the totals. Output VAT
-- is the movement on the VAT Output account (2100); input VAT is the movement on VAT Input (2200).
-- Reads the ledger, so it agrees with the trial balance's movement on those accounts.
-- ---------------------------------------------------------------------------
create or replace function app.report_vat_return(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns table (
  bucket     text,
  tax_rate   numeric,
  net        numeric,
  tax        numeric,
  gross      numeric
)
language sql
stable
security invoker
as $$
  with lines as (
    select jl.tax_rate_id, jl.base_debit, jl.base_credit, a.code
      from public.journal_lines jl
      join public.chart_of_accounts a on a.id = jl.account_id
     where jl.org_id = p_org_id
       and (p_branch_id is null or jl.branch_id = p_branch_id)
       and jl.posting_date between p_from and p_to
       and a.code in ('2100', '2200')
  ),
  output as (
    select coalesce(t.rate, 0) as tax_rate,
           round(coalesce(sum(l.base_debit), 0), 4) as net,
           round(coalesce(sum(l.base_credit - l.base_debit), 0), 4) as tax
      from lines l
      left join public.tax_rates t on t.id = l.tax_rate_id
     where l.code = '2100'
     group by coalesce(t.rate, 0)
  ),
  input as (
    select coalesce(t.rate, 0) as tax_rate,
           round(coalesce(sum(l.base_credit), 0), 4) as net,
           round(coalesce(sum(l.base_debit - l.base_credit), 0), 4) as tax
      from lines l
      left join public.tax_rates t on t.id = l.tax_rate_id
     where l.code = '2200'
     group by coalesce(t.rate, 0)
  )
  select 'output'::text, o.tax_rate, o.net, o.tax, round(o.net + o.tax, 4) from output o
  union all
  select 'input'::text, i.tax_rate, i.net, i.tax, round(i.net + i.tax, 4) from input i
  order by 1, 2;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Every report is SECURITY INVOKER, so the caller's RLS scopes the rows.
-- ---------------------------------------------------------------------------
grant execute on function app.account_statement_section(text, text) to authenticated, service_role;
grant execute on function app.is_cash_account(text, text) to authenticated, service_role;
grant execute on function app.report_account_activity(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.report_trial_balance(uuid, uuid, date, date, boolean) to authenticated, service_role;
grant execute on function app.report_profit_and_loss(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.report_balance_sheet(uuid, uuid, date) to authenticated, service_role;
grant execute on function app.report_changes_in_equity(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.report_cash_flow(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.report_ar_aging(uuid, uuid, date) to authenticated, service_role;
grant execute on function app.report_ap_aging(uuid, uuid, date) to authenticated, service_role;
grant execute on function app.report_control_account_balance(uuid, uuid, text, date) to authenticated, service_role;
grant execute on function app.report_general_ledger(uuid, uuid, uuid, date, date, int, date, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.report_journal_list(uuid, uuid, date, date, text, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.report_journal(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function app.report_journal_lines(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function app.report_vat_return(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.post_supplier_bill(uuid, uuid, uuid, text, date, date, text, numeric, numeric, text, text, text) to authenticated, service_role;
grant execute on function app.pay_supplier_bill(uuid, uuid, uuid, numeric, date, text, text) to authenticated, service_role;
