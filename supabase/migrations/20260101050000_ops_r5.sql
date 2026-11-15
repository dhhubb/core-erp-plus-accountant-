-- R5: Operations (Retail vertical).
--
-- Additive only. Nothing here edits an applied migration. This file adds the operational
-- (non-ledger) side of the till and the back office:
--
--   * public.credit_limits            (org-scoped; a credit ceiling per customer)
--   * public.laybys                   (branch-scoped; a customer layby)
--   * public.layby_reservations       (branch-scoped; stock held aside for a layby)
--   * public.returns                  (branch-scoped; a customer return against an invoice)
--   * public.return_lines             (branch-scoped; what came back)
--   * public.z_reports                (branch-scoped, IMMUTABLE; one row per closed shift)
--   * public.stock_counts             (branch-scoped, PARTITIONED monthly; PK (id, created_at))
--   * public.stock_count_items        (branch-scoped; the counted lines)
--
-- Plus:
--   * app.post_balanced_journal(...)  — the balanced-journal hook (ADR-0019). A pre-flight
--     balance assertion in front of app.post_journal; every operational journal goes through it.
--   * app.check_credit(...)           — locks the contact FOR UPDATE and checks the ceiling.
--   * app.create_layby / app.complete_layby / app.cancel_layby
--   * app.create_return(...)          — locks the original invoice lines FOR UPDATE, then calls
--     the CORE app.create_credit_note for stock and revenue.
--   * app.close_shift(...)            — one immutable z_reports row per shift.
--   * app.create_stock_count / app.close_stock_count — one CORE stock adjustment (one journal).
--
-- Two additive core changes (recorded in ADR-0019):
--   * new settings columns (layby fee/percent, return refund method);
--   * three new default accounts and four new number series.
--   * one new index on the core `invoices` table for the credit-limit open-balance sum.

-- ---------------------------------------------------------------------------
-- Additive core changes: settings columns, accounts, number series.
-- ---------------------------------------------------------------------------
alter table public.settings
  add column layby_deposit_percent numeric(5, 2) not null default 20.00,
  add column layby_cancellation_fee numeric(19, 4) not null default 0,
  add column return_refund_method text not null default 'cash';

alter table public.settings
  add constraint settings_layby_percent_check
    check (layby_deposit_percent >= 0 and layby_deposit_percent <= 100),
  add constraint settings_layby_fee_check check (layby_cancellation_fee >= 0),
  add constraint settings_return_refund_method_check
    check (return_refund_method in ('cash', 'store_credit'));

-- New default accounts, added to the org-creation trigger. New orgs get them; existing orgs keep
-- the accounts they already have (this phase only creates orgs through app.create_org).
create or replace function app.create_default_accounts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.chart_of_accounts (org_id, code, name, account_type) values
    (new.id, '1000', 'Inventory',            'asset'),
    (new.id, '1100', 'Accounts Receivable',  'asset'),
    (new.id, '1200', 'Bank',                 'asset'),
    (new.id, '2000', 'Accounts Payable',     'liability'),
    (new.id, '2100', 'VAT Output',           'liability'),
    (new.id, '2200', 'VAT Input',            'asset'),
    (new.id, '2300', 'Customer Deposits',    'liability'),
    (new.id, '2400', 'Store Credit',         'liability'),
    (new.id, '3000', 'Retained Earnings',    'equity'),
    (new.id, '4000', 'Sales Revenue',        'revenue'),
    (new.id, '4600', 'Layby Cancellation Fees', 'revenue'),
    (new.id, '5000', 'Cost of Goods Sold',   'expense'),
    (new.id, '6900', 'Inventory Adjustment', 'expense'),
    (new.id, '6999', 'Rounding Differences', 'expense')
  on conflict (org_id, code) do nothing;

  insert into public.tax_rates (org_id, code, name, rate, effective_from, effective_to)
  values (new.id, 'VAT15', 'VAT 15% (to be confirmed)', 0.150000, date '2020-01-01', null)
  on conflict (org_id, code, effective_from) do nothing;

  insert into public.exchange_rates (org_id, currency, rate, effective_from)
  values (new.id, 'USD', 1.0000000000, date '2020-01-01')
  on conflict (org_id, currency, effective_from) do nothing;

  return new;
end;
$$;

create or replace function app.create_default_number_series()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.number_series (org_id, code, prefix, pad_width) values
    (new.id, 'INVOICE',     '',      6),
    (new.id, 'CREDIT_NOTE', 'CN-',   6),
    (new.id, 'SKU',         'SKU-',  8),
    (new.id, 'PO',          'PO-',   6),
    (new.id, 'LAYBY',       'LB-',   6),
    (new.id, 'RETURN',      'RT-',   6),
    (new.id, 'Z_REPORT',    'Z-',    6),
    (new.id, 'STOCK_COUNT', 'SC-',   6)
  on conflict (org_id, code) do nothing;
  return new;
end;
$$;

-- The open-balance sum for the credit check. The partial index already on `invoices` covers
-- (org_id, contact_id) where total > amount_paid; this index additionally serves a keyset listing
-- of a customer's invoices. ADR-0019.
create index if not exists invoices_org_contact_created_idx
  on public.invoices (org_id, contact_id, created_at desc, id desc);

-- Three new operational journal source types. The check lives on the partitioned parent, so
-- altering it there covers every partition, existing and future.
alter table public.journals drop constraint journals_source_type_check;
alter table public.journals add constraint journals_source_type_check
  check (source_type in ('manual', 'invoice', 'receipt', 'payment', 'credit_note',
                         'stock_adjustment', 'reversal',
                         'layby_deposit', 'layby_cancellation', 'return_refund'));

-- A dedicated stock_ledger source type for a layby reservation, rather than overloading
-- 'transfer' (which means a warehouse-to-warehouse move).
alter table public.stock_ledger drop constraint stock_ledger_source_type_check;
alter table public.stock_ledger add constraint stock_ledger_source_type_check
  check (source_type in ('receipt', 'sale', 'adjustment', 'transfer', 'credit_note', 'opening',
                         'layby'));

-- ---------------------------------------------------------------------------
-- The balanced-journal hook (ADR-0019). Every operational journal (a layby deposit, a layby
-- cancellation, a return refund) goes through this instead of app.post_journal directly. It
-- asserts the lines balance before delegating, so an operational bug is caught at the call site
-- with a clear message rather than only at commit by the deferred trigger. The deferred trigger
-- still runs; this is an extra, earlier guard, not a replacement.
-- ---------------------------------------------------------------------------
create or replace function app.post_balanced_journal(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_posting_date date,
  p_source_type  text,
  p_source_id    uuid,
  p_memo         text,
  p_currency     text,
  p_lines        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line   jsonb;
  v_debit  numeric(19, 4) := 0;
  v_credit numeric(19, 4) := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'post_balanced_journal requires at least two lines' using errcode = '23514';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := v_debit  + coalesce((v_line ->> 'debit')::numeric, 0);
    v_credit := v_credit + coalesce((v_line ->> 'credit')::numeric, 0);
  end loop;

  if v_debit <> v_credit then
    raise exception 'post_balanced_journal: debits % do not equal credits %',
      v_debit, v_credit using errcode = '23514';
  end if;

  return app.post_journal(
    p_org_id, p_branch_id, p_posting_date, p_source_type, p_source_id, p_memo, p_currency,
    p_lines
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Credit limits. Org-scoped, one ceiling per customer.
-- ---------------------------------------------------------------------------
create table public.credit_limits (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  contact_id   uuid not null references public.contacts (id) on delete cascade,
  credit_limit numeric(19, 4) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint credit_limits_org_contact_key unique (org_id, contact_id),
  constraint credit_limits_amount_check check (credit_limit >= 0)
);

create index credit_limits_org_created_idx on public.credit_limits (org_id, created_at desc, id desc);
create index credit_limits_org_id_idx on public.credit_limits (org_id);
create index credit_limits_contact_id_idx on public.credit_limits (contact_id);

-- ---------------------------------------------------------------------------
-- check_credit: lock the contact FOR UPDATE, then refuse a sale that would push the customer's
-- open balance past the ceiling. The lock is what makes 20 concurrent sales serialise on the
-- customer, so none of them can each see the same headroom (ADR-0020). A customer with no
-- credit_limits row has no ceiling and is allowed.
-- ---------------------------------------------------------------------------
create or replace function app.check_credit(
  p_org_id     uuid,
  p_contact_id uuid,
  p_amount     numeric
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit numeric(19, 4);
  v_open  numeric(19, 4);
begin
  if p_contact_id is null then
    return null;
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'credit amount must not be negative' using errcode = '23514';
  end if;

  -- Serialise every credit check for this customer.
  perform 1 from public.contacts c where c.id = p_contact_id and c.org_id = p_org_id for update;

  select cl.credit_limit into v_limit
    from public.credit_limits cl
   where cl.org_id = p_org_id and cl.contact_id = p_contact_id;

  if v_limit is null then
    return null;
  end if;

  select coalesce(sum(i.total - i.amount_paid), 0) into v_open
    from public.invoices i
   where i.org_id = p_org_id
     and i.contact_id = p_contact_id
     and i.total > i.amount_paid;

  if v_open + p_amount > v_limit then
    raise exception 'credit limit exceeded for contact %: open % plus % exceeds limit %',
      p_contact_id, v_open, p_amount, v_limit using errcode = '23514';
  end if;

  return v_limit - v_open - p_amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- Laybys. A customer pays a deposit; the goods are held aside until collection.
-- ---------------------------------------------------------------------------
create table public.laybys (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  branch_id          uuid not null references public.branches (id) on delete restrict,
  contact_id         uuid not null references public.contacts (id) on delete restrict,
  warehouse_id       uuid not null references public.warehouses (id) on delete restrict,
  layby_no           text not null,
  status             text not null default 'open',
  due_date           date not null,
  currency           text not null default 'USD',
  subtotal           numeric(19, 4) not null default 0,
  tax_total          numeric(19, 4) not null default 0,
  total              numeric(19, 4) not null default 0,
  deposit_paid       numeric(19, 4) not null default 0,
  cancellation_fee   numeric(19, 4) not null default 0,
  deposit_journal_id uuid,
  deposit_journal_created_at timestamptz,
  invoice_id         uuid references public.invoices (id) on delete restrict,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint laybys_status_check check (status in ('open', 'completed', 'cancelled')),
  constraint laybys_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint laybys_amounts_check
    check (subtotal >= 0 and tax_total >= 0 and total >= 0 and deposit_paid >= 0
           and cancellation_fee >= 0),
  constraint laybys_org_no_key unique (org_id, layby_no),
  constraint laybys_deposit_journal_pair_check
    check ((deposit_journal_id is null) = (deposit_journal_created_at is null)),
  constraint laybys_deposit_journal_fkey
    foreign key (deposit_journal_id, deposit_journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

-- The brief's index: (org_id, branch_id, status, due_date).
create index laybys_org_branch_status_due_idx on public.laybys (org_id, branch_id, status, due_date);
create index laybys_org_branch_created_idx on public.laybys (org_id, branch_id, created_at desc, id desc);
create index laybys_org_created_idx on public.laybys (org_id, created_at desc, id desc);
create index laybys_org_id_idx on public.laybys (org_id);
create index laybys_branch_id_idx on public.laybys (branch_id);
create index laybys_contact_id_idx on public.laybys (contact_id);
create index laybys_warehouse_id_idx on public.laybys (warehouse_id);
create index laybys_invoice_id_idx on public.laybys (invoice_id);
create index laybys_deposit_journal_idx on public.laybys (deposit_journal_id, deposit_journal_created_at);

-- Stock held aside for a layby. The reservation consumes FIFO layers at creation, so the goods
-- leave the available pool; the reserved cost is kept here for the invoice that completion posts.
create table public.layby_reservations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  layby_id     uuid not null references public.laybys (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete restrict,
  variant_id   uuid references public.product_variants (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  line_no      int not null,
  qty          numeric(19, 4) not null,
  unit_price   numeric(19, 4) not null,
  unit_cost    numeric(19, 4) not null default 0,
  tax_rate     numeric(9, 6) not null default 0,
  status       text not null default 'reserved',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint layby_reservations_status_check
    check (status in ('reserved', 'collected', 'released')),
  constraint layby_reservations_qty_check check (qty > 0),
  constraint layby_reservations_amounts_check check (unit_price >= 0 and unit_cost >= 0),
  constraint layby_reservations_layby_line_key unique (layby_id, line_no)
);

create index layby_reservations_org_branch_created_idx
  on public.layby_reservations (org_id, branch_id, created_at desc, id desc);
create index layby_reservations_layby_idx on public.layby_reservations (layby_id);
create index layby_reservations_product_idx on public.layby_reservations (product_id);
create index layby_reservations_variant_idx on public.layby_reservations (variant_id);
create index layby_reservations_warehouse_idx on public.layby_reservations (warehouse_id);
create index layby_reservations_org_id_idx on public.layby_reservations (org_id);
create index layby_reservations_branch_id_idx on public.layby_reservations (branch_id);

-- ---------------------------------------------------------------------------
-- Returns. A customer brings goods back against an invoice. Stock and revenue are reversed by the
-- CORE credit note; the refund is posted through the balanced-journal hook.
-- ---------------------------------------------------------------------------
create table public.returns (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete restrict,
  branch_id           uuid not null references public.branches (id) on delete restrict,
  original_invoice_id uuid not null references public.invoices (id) on delete restrict,
  contact_id          uuid references public.contacts (id) on delete restrict,
  return_no           text not null,
  status              text not null default 'completed',
  refund_method       text not null default 'cash',
  total               numeric(19, 4) not null default 0,
  credit_note_id      uuid references public.credit_notes (id) on delete restrict,
  refund_journal_id   uuid,
  refund_journal_created_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint returns_status_check check (status in ('completed', 'cancelled')),
  constraint returns_refund_method_check check (refund_method in ('cash', 'store_credit')),
  constraint returns_total_check check (total >= 0),
  constraint returns_org_no_key unique (org_id, return_no),
  constraint returns_refund_journal_pair_check
    check ((refund_journal_id is null) = (refund_journal_created_at is null)),
  constraint returns_refund_journal_fkey
    foreign key (refund_journal_id, refund_journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

create index returns_org_branch_created_idx on public.returns (org_id, branch_id, created_at desc, id desc);
create index returns_org_created_idx on public.returns (org_id, created_at desc, id desc);
create index returns_original_invoice_idx on public.returns (original_invoice_id);
create index returns_contact_id_idx on public.returns (contact_id);
create index returns_credit_note_id_idx on public.returns (credit_note_id);
create index returns_org_id_idx on public.returns (org_id);
create index returns_branch_id_idx on public.returns (branch_id);
create index returns_refund_journal_idx on public.returns (refund_journal_id, refund_journal_created_at);

create table public.return_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid not null references public.branches (id) on delete restrict,
  return_id       uuid not null references public.returns (id) on delete cascade,
  invoice_line_id uuid not null references public.invoice_lines (id) on delete restrict,
  line_no         int not null,
  qty             numeric(19, 4) not null,
  unit_price      numeric(19, 4) not null,
  unit_cost       numeric(19, 4) not null default 0,
  created_at      timestamptz not null default now(),
  constraint return_lines_qty_check check (qty > 0),
  constraint return_lines_amounts_check check (unit_price >= 0 and unit_cost >= 0),
  constraint return_lines_return_line_key unique (return_id, line_no)
);

create index return_lines_org_branch_created_idx
  on public.return_lines (org_id, branch_id, created_at desc, id desc);
create index return_lines_return_idx on public.return_lines (return_id);
create index return_lines_invoice_line_idx on public.return_lines (invoice_line_id);
create index return_lines_org_id_idx on public.return_lines (org_id);
create index return_lines_branch_id_idx on public.return_lines (branch_id);

-- ---------------------------------------------------------------------------
-- Z-reports. One immutable row per closed shift. It is the only thing a daily summary reads;
-- no running daily total is kept on each sale, and no materialized view exists.
-- ---------------------------------------------------------------------------
create table public.z_reports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  branch_id      uuid not null references public.branches (id) on delete restrict,
  shift_id       uuid not null references public.shifts (id) on delete restrict,
  z_no           text not null,
  opened_at      timestamptz not null,
  closed_at      timestamptz not null default now(),
  opening_float  numeric(19, 4) not null default 0,
  sale_count     int not null default 0,
  void_count     int not null default 0,
  gross_sales    numeric(19, 4) not null default 0,
  tax_total      numeric(19, 4) not null default 0,
  by_method      jsonb not null default '{}'::jsonb,
  by_currency    jsonb not null default '{}'::jsonb,
  vat_by_rate    jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint z_reports_counts_check check (sale_count >= 0 and void_count >= 0),
  constraint z_reports_amounts_check
    check (opening_float >= 0 and gross_sales >= 0 and tax_total >= 0),
  constraint z_reports_org_no_key unique (org_id, z_no)
);

create index z_reports_org_branch_created_idx on public.z_reports (org_id, branch_id, created_at desc, id desc);
create index z_reports_org_created_idx on public.z_reports (org_id, created_at desc, id desc);
create index z_reports_shift_idx on public.z_reports (shift_id);
create index z_reports_org_id_idx on public.z_reports (org_id);
create index z_reports_branch_id_idx on public.z_reports (branch_id);

-- ---------------------------------------------------------------------------
-- Stock counts. The header is partitioned monthly on created_at, so its primary key includes
-- created_at (the same rule the ledger tables follow).
-- ---------------------------------------------------------------------------
create table public.stock_counts (
  id           uuid not null default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  count_no     text not null,
  status       text not null default 'open',
  counted_at   date not null default current_date,
  closed_at    timestamptz,
  journal_id   uuid,
  journal_created_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (id, created_at),
  constraint stock_counts_status_check check (status in ('open', 'closed')),
  constraint stock_counts_org_no_key unique (org_id, count_no, created_at),
  constraint stock_counts_journal_pair_check
    check ((journal_id is null) = (journal_created_at is null)),
  constraint stock_counts_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict
) partition by range (created_at);

create index stock_counts_org_branch_created_idx
  on public.stock_counts (org_id, branch_id, created_at desc, id desc);
create index stock_counts_warehouse_idx on public.stock_counts (warehouse_id);
create index stock_counts_org_id_idx on public.stock_counts (org_id);
create index stock_counts_branch_id_idx on public.stock_counts (branch_id);
create index stock_counts_journal_idx on public.stock_counts (journal_id, journal_created_at);

create table public.stock_count_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  branch_id        uuid not null references public.branches (id) on delete restrict,
  count_id         uuid not null,
  count_created_at timestamptz not null,
  line_no          int not null,
  product_id       uuid not null references public.products (id) on delete restrict,
  variant_id       uuid references public.product_variants (id) on delete restrict,
  counted_qty      numeric(19, 4) not null,
  system_qty       numeric(19, 4) not null default 0,
  unit_cost        numeric(19, 4) not null default 0,
  created_at       timestamptz not null default now(),
  constraint stock_count_items_qty_check check (counted_qty >= 0),
  constraint stock_count_items_cost_check check (system_qty >= 0 and unit_cost >= 0),
  constraint stock_count_items_count_line_key unique (count_id, count_created_at, line_no),
  constraint stock_count_items_count_fkey
    foreign key (count_id, count_created_at)
    references public.stock_counts (id, created_at) on delete cascade
);

create index stock_count_items_count_idx on public.stock_count_items (count_id, count_created_at);
create index stock_count_items_org_branch_created_idx
  on public.stock_count_items (org_id, branch_id, created_at desc, id desc);
create index stock_count_items_product_idx on public.stock_count_items (product_id);
create index stock_count_items_variant_idx on public.stock_count_items (variant_id);
create index stock_count_items_org_id_idx on public.stock_count_items (org_id);
create index stock_count_items_branch_id_idx on public.stock_count_items (branch_id);

-- ---------------------------------------------------------------------------
-- RLS. Every new tenant table gets enable + force and the standard policies.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.credit_limits', 'org');
select app.apply_tenant_rls('public.laybys', 'branch');
select app.apply_tenant_rls('public.layby_reservations', 'branch');
select app.apply_tenant_rls('public.returns', 'branch');
select app.apply_tenant_rls('public.return_lines', 'branch');
select app.apply_tenant_rls('public.z_reports', 'branch');
select app.apply_tenant_rls('public.stock_counts', 'branch');
select app.apply_tenant_rls('public.stock_count_items', 'branch');

-- A z-report is a financial document: once written it is never updated or deleted.
select app.enforce_immutable('public.z_reports');

-- ---------------------------------------------------------------------------
-- Layby lifecycle.
--
-- create_layby: reserve the goods (consume FIFO now, so they leave the available pool), record
-- the reservation and its cost, then post the deposit journal through the balanced-journal hook:
-- Dr Bank, Cr Customer Deposits. Revenue is not recognised yet.
-- ---------------------------------------------------------------------------
create or replace function app.create_layby(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_contact_id   uuid,
  p_warehouse_id uuid,
  p_due_date     date,
  p_lines        jsonb,
  p_deposit      numeric,
  p_currency     text default 'USD',
  p_tax_code     text default 'VAT15',
  p_posting_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date        date := coalesce(p_posting_date, current_date);
  v_currency    text := coalesce(p_currency, 'USD');
  v_rate        numeric;
  v_layby_id    uuid := gen_random_uuid();
  v_created_at  timestamptz := clock_timestamp();
  v_layby_no    text;
  v_line        jsonb;
  v_line_no     int := 0;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_qty         numeric(19, 4);
  v_unit_price  numeric(19, 4);
  v_subtotal    numeric(19, 4);
  v_tax_rate    numeric(9, 6);
  v_line_tax    numeric(19, 4);
  v_sum_subtotal numeric(19, 4) := 0;
  v_sum_tax     numeric(19, 4) := 0;
  v_sum_total   numeric(19, 4) := 0;
  v_keys        jsonb := '[]'::jsonb;
  v_ledger_id   uuid;
  v_cost        numeric(19, 4);
  v_journal     uuid;
  v_deposit     numeric(19, 4) := coalesce(p_deposit, 0);
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_layby requires at least one line' using errcode = '23514';
  end if;
  if v_deposit < 0 then
    raise exception 'layby deposit must not be negative' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, v_date);

  v_rate := app.rate_on(p_org_id, v_currency, v_date);
  if v_rate is null then
    raise exception 'no exchange rate for % effective on %', v_currency, v_date
      using errcode = 'no_data_found';
  end if;

  -- Collect the stock keys, then lock them in ascending order before touching anything.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_keys := v_keys || jsonb_build_object(
      'warehouse_id', p_warehouse_id,
      'product_id', (v_line ->> 'product_id')::uuid,
      'variant_id', nullif(v_line ->> 'variant_id', '')
    );
  end loop;
  perform app.lock_stock_balances(p_org_id, p_branch_id, v_keys);

  -- Pass 1: price every line and total the layby.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'layby line quantity must be positive' using errcode = '23514';
    end if;

    v_subtotal := round(v_qty * (v_line ->> 'unit_price')::numeric, 4);

    select r.rate into v_tax_rate
      from public.tax_rates r
     where r.org_id = p_org_id
       and r.code = coalesce(v_line ->> 'tax_rate_code', p_tax_code)
       and r.effective_from <= v_date
       and (r.effective_to is null or r.effective_to >= v_date)
     order by r.effective_from desc
     limit 1;
    v_tax_rate := coalesce(v_tax_rate, 0);

    v_sum_subtotal := v_sum_subtotal + v_subtotal;
    v_sum_tax      := v_sum_tax + round(v_subtotal * v_tax_rate, 4);
  end loop;
  v_sum_total := v_sum_subtotal + v_sum_tax;

  if v_deposit > v_sum_total then
    raise exception 'layby deposit % exceeds the layby total %', v_deposit, v_sum_total
      using errcode = '23514';
  end if;

  v_layby_no := app.next_number(p_org_id, 'LAYBY');

  insert into public.laybys
    (id, org_id, branch_id, contact_id, warehouse_id, layby_no, status, due_date, currency,
     subtotal, tax_total, total, deposit_paid, created_at, updated_at)
  values
    (v_layby_id, p_org_id, p_branch_id, p_contact_id, p_warehouse_id, v_layby_no, 'open',
     p_due_date, v_currency, v_sum_subtotal, v_sum_tax, v_sum_total, v_deposit, v_created_at,
     v_created_at);

  -- Pass 2: reserve the stock (consume FIFO now, so the goods leave the available pool).
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(v_line ->> 'variant_id', '')::uuid;
    v_qty := (v_line ->> 'qty')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    select r.rate into v_tax_rate
      from public.tax_rates r
     where r.org_id = p_org_id
       and r.code = coalesce(v_line ->> 'tax_rate_code', p_tax_code)
       and r.effective_from <= v_date
       and (r.effective_to is null or r.effective_to >= v_date)
     order by r.effective_from desc
     limit 1;
    v_tax_rate := coalesce(v_tax_rate, 0);

    v_ledger_id := gen_random_uuid();
    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, source_id, memo, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, p_warehouse_id, v_product_id, v_variant_id, 'out',
       v_qty, 0, 'layby', v_layby_id, 'Layby reservation', v_created_at);

    v_cost := app.consume_fifo(
      p_org_id, p_branch_id, p_warehouse_id, v_product_id, v_variant_id, v_qty,
      v_ledger_id, v_created_at
    );

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    values
      (p_org_id, p_branch_id, p_warehouse_id, v_product_id, v_variant_id, -v_qty, -v_cost)
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
      set qty   = public.stock_balances.qty + excluded.qty,
          value = public.stock_balances.value + excluded.value;

    insert into public.layby_reservations
      (org_id, branch_id, layby_id, product_id, variant_id, warehouse_id, line_no, qty,
       unit_price, unit_cost, tax_rate, created_at)
    values
      (p_org_id, p_branch_id, v_layby_id, v_product_id, v_variant_id, p_warehouse_id, v_line_no,
       v_qty, v_unit_price, round(v_cost / v_qty, 4), v_tax_rate, v_created_at);
  end loop;

  if v_deposit > 0 then
    -- The balanced-journal hook: Dr Bank, Cr Customer Deposits (a liability). No revenue yet.
    v_journal := app.post_balanced_journal(
      p_org_id, p_branch_id, v_date, 'layby_deposit', v_layby_id,
      'Layby deposit ' || v_layby_no, v_currency,
      jsonb_build_array(
        jsonb_build_object('account_code', '1200', 'debit', v_deposit, 'currency', v_currency,
                           'exchange_rate', v_rate, 'description', 'Bank'),
        jsonb_build_object('account_code', '2300', 'credit', v_deposit, 'currency', v_currency,
                           'exchange_rate', v_rate, 'description', 'Customer deposits')
      )
    );

    update public.laybys
       set deposit_journal_id = v_journal,
           deposit_journal_created_at = (select j.created_at from public.journals j where j.id = v_journal)
     where id = v_layby_id;
  end if;

  return jsonb_build_object(
    'layby_id', v_layby_id,
    'layby_no', v_layby_no,
    'subtotal', v_sum_subtotal,
    'tax_total', v_sum_tax,
    'total', v_sum_total,
    'deposit_paid', v_deposit,
    'deposit_journal_id', v_journal
  );
end;
$$;

-- complete_layby: create the CORE invoice for the reserved goods and clear the deposit against it.
-- The stock already moved at reservation, so the invoice is written directly at the reserved cost
-- rather than by calling app.create_invoice (which would consume FIFO a second time).
create or replace function app.complete_layby(
  p_org_id       uuid,
  p_layby_id     uuid,
  p_completion_date date default null,
  p_payment      numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_layby       public.laybys%rowtype;
  v_date        date := coalesce(p_completion_date, current_date);
  v_created_at  timestamptz := clock_timestamp();
  v_invoice_id  uuid := gen_random_uuid();
  v_invoice_no  text;
  v_res         record;
  v_line_no     int := 0;
  v_cogs        numeric(19, 4) := 0;
  v_deposit     numeric(19, 4);
  v_journal     uuid;
  v_lines       jsonb := '[]'::jsonb;
  v_payment     numeric(19, 4) := coalesce(p_payment, 0);
begin
  select * into v_layby from public.laybys where id = p_layby_id for update;
  if not found then
    raise exception 'layby % not found', p_layby_id using errcode = 'no_data_found';
  end if;
  if v_layby.status <> 'open' then
    raise exception 'layby % is %, not open', v_layby.layby_no, v_layby.status
      using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, v_date);

  for v_res in
    select * from public.layby_reservations
     where layby_id = p_layby_id
     order by line_no
  loop
    v_line_no := v_line_no + 1;
    v_cogs := v_cogs + round(v_res.qty * v_res.unit_cost, 4);

    v_lines := v_lines || jsonb_build_object(
      'line_no', v_line_no,
      'product_id', v_res.product_id,
      'variant_id', v_res.variant_id,
      'warehouse_id', v_res.warehouse_id,
      'qty', v_res.qty,
      'unit_price', v_res.unit_price,
      'unit_cost', v_res.unit_cost,
      'tax_rate', v_res.tax_rate,
      'line_subtotal', round(v_res.qty * v_res.unit_price, 4),
      'line_tax', round(round(v_res.qty * v_res.unit_price, 4) * v_res.tax_rate, 4)
    );
  end loop;

  v_invoice_no := app.next_number(p_org_id, 'INVOICE');

  -- Dr AR / Cr Revenue / Cr VAT / Dr COGS / Cr Inventory, then clear the deposit against AR.
  v_journal := app.post_balanced_journal(
    p_org_id, v_layby.branch_id, v_date, 'invoice', v_invoice_id,
    'Layby collection ' || v_layby.layby_no, v_layby.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '1100', 'debit', v_layby.total,
                         'currency', v_layby.currency, 'description', 'Accounts receivable'),
      jsonb_build_object('account_code', '4000', 'credit', v_layby.subtotal,
                         'currency', v_layby.currency, 'description', 'Sales revenue'),
      jsonb_build_object('account_code', '2100', 'credit', v_layby.tax_total,
                         'currency', v_layby.currency, 'description', 'VAT output'),
      jsonb_build_object('account_code', '5000', 'debit', v_cogs,
                         'currency', v_layby.currency, 'description', 'Cost of goods sold'),
      jsonb_build_object('account_code', '1000', 'credit', v_cogs,
                         'currency', v_layby.currency, 'description', 'Inventory'),
      jsonb_build_object('account_code', '2300', 'debit', v_layby.deposit_paid,
                         'currency', v_layby.currency, 'description', 'Customer deposits cleared'),
      jsonb_build_object('account_code', '1100', 'credit', v_layby.deposit_paid,
                         'currency', v_layby.currency, 'description', 'Deposit applied')
    )
  );

  insert into public.invoices
    (id, org_id, branch_id, contact_id, invoice_no, invoice_date, currency, exchange_rate,
     subtotal, tax_total, total, amount_paid, journal_id, journal_created_at, created_at)
  select v_invoice_id, p_org_id, v_layby.branch_id, v_layby.contact_id, v_invoice_no, v_date,
         v_layby.currency, app.rate_on(p_org_id, v_layby.currency, v_date), v_layby.subtotal,
         v_layby.tax_total, v_layby.total, v_layby.deposit_paid, v_journal, j.created_at,
         v_created_at
    from public.journals j
   where j.id = v_journal;

  insert into public.invoice_lines
    (org_id, branch_id, invoice_id, line_no, product_id, variant_id, warehouse_id, qty,
     unit_price, unit_cost, tax_rate, line_subtotal, line_tax, line_total)
  select p_org_id, v_layby.branch_id, v_invoice_id, (l ->> 'line_no')::int,
         (l ->> 'product_id')::uuid, nullif(l ->> 'variant_id', '')::uuid,
         (l ->> 'warehouse_id')::uuid, (l ->> 'qty')::numeric, (l ->> 'unit_price')::numeric,
         (l ->> 'unit_cost')::numeric, (l ->> 'tax_rate')::numeric,
         (l ->> 'line_subtotal')::numeric, (l ->> 'line_tax')::numeric,
         (l ->> 'line_subtotal')::numeric + (l ->> 'line_tax')::numeric
    from jsonb_array_elements(v_lines) as l;

  -- Any balance paid at collection settles AR.
  if v_payment > 0 then
    perform app.allocate_payment(
      p_org_id, v_layby.branch_id, v_invoice_id, v_payment, v_date, 'cash', v_layby.contact_id
    );
  end if;

  update public.laybys
     set status = 'completed', invoice_id = v_invoice_id, completed_at = v_created_at,
         updated_at = v_created_at
   where id = p_layby_id;

  update public.layby_reservations
     set status = 'collected', updated_at = v_created_at
   where layby_id = p_layby_id;

  return jsonb_build_object(
    'layby_id', p_layby_id,
    'invoice_id', v_invoice_id,
    'invoice_no', v_invoice_no,
    'total', v_layby.total,
    'deposit_applied', v_layby.deposit_paid
  );
end;
$$;

-- cancel_layby: refund the deposit less the cancellation fee and return the reserved stock.
-- Dr Customer Deposits (the whole deposit), Cr Bank (the refund), Cr Fee Income (the fee).
create or replace function app.cancel_layby(
  p_org_id       uuid,
  p_layby_id     uuid,
  p_cancellation_date date default null,
  p_fee          numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_layby       public.laybys%rowtype;
  v_date        date := coalesce(p_cancellation_date, current_date);
  v_created_at  timestamptz := clock_timestamp();
  v_fee         numeric(19, 4);
  v_refund      numeric(19, 4);
  v_res         record;
  v_ledger_id   uuid;
  v_journal     uuid;
  v_default_fee numeric(19, 4);
begin
  select * into v_layby from public.laybys where id = p_layby_id for update;
  if not found then
    raise exception 'layby % not found', p_layby_id using errcode = 'no_data_found';
  end if;
  if v_layby.status <> 'open' then
    raise exception 'layby % is %, not open', v_layby.layby_no, v_layby.status
      using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, v_date);

  select s.layby_cancellation_fee into v_default_fee
    from public.settings s where s.org_id = p_org_id;
  v_fee := coalesce(p_fee, v_default_fee, 0);

  if v_fee < 0 then
    raise exception 'cancellation fee must not be negative' using errcode = '23514';
  end if;
  if v_fee > v_layby.deposit_paid then
    raise exception 'cancellation fee % exceeds the deposit %', v_fee, v_layby.deposit_paid
      using errcode = '23514';
  end if;

  v_refund := v_layby.deposit_paid - v_fee;

  -- Return the reserved stock as a new inbound layer at the reserved cost.
  for v_res in
    select * from public.layby_reservations
     where layby_id = p_layby_id and status = 'reserved'
     order by line_no
  loop
    v_ledger_id := gen_random_uuid();
    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, source_id, memo, created_at)
    values
      (v_ledger_id, p_org_id, v_layby.branch_id, v_res.warehouse_id, v_res.product_id,
       v_res.variant_id, 'in', v_res.qty, v_res.unit_cost, 'credit_note', p_layby_id,
       'Layby cancellation', v_created_at);

    insert into public.stock_layer_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id,
       in_ledger_created_at, unit_cost, qty_remaining)
    values
      (p_org_id, v_layby.branch_id, v_res.warehouse_id, v_res.product_id, v_res.variant_id,
       v_ledger_id, v_created_at, v_res.unit_cost, v_res.qty)
    on conflict (in_ledger_id, in_ledger_created_at) do update
      set qty_remaining = public.stock_layer_balances.qty_remaining + excluded.qty_remaining;

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    values
      (p_org_id, v_layby.branch_id, v_res.warehouse_id, v_res.product_id, v_res.variant_id,
       v_res.qty, round(v_res.qty * v_res.unit_cost, 4))
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
      set qty   = public.stock_balances.qty + excluded.qty,
          value = public.stock_balances.value + excluded.value;
  end loop;

  -- The balanced-journal hook: Dr Customer Deposits, Cr Bank (refund), Cr Fee Income (fee).
  v_journal := app.post_balanced_journal(
    p_org_id, v_layby.branch_id, v_date, 'layby_cancellation', p_layby_id,
    'Layby cancellation ' || v_layby.layby_no, v_layby.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '2300', 'debit', v_layby.deposit_paid,
                         'currency', v_layby.currency, 'description', 'Customer deposits'),
      jsonb_build_object('account_code', '1200', 'credit', v_refund,
                         'currency', v_layby.currency, 'description', 'Refund'),
      jsonb_build_object('account_code', '4600', 'credit', v_fee,
                         'currency', v_layby.currency, 'description', 'Cancellation fee')
    )
  );

  update public.laybys
     set status = 'cancelled', cancellation_fee = v_fee, cancelled_at = v_created_at,
         updated_at = v_created_at
   where id = p_layby_id;

  update public.layby_reservations
     set status = 'released', updated_at = v_created_at
   where layby_id = p_layby_id;

  return jsonb_build_object(
    'layby_id', p_layby_id,
    'deposit_paid', v_layby.deposit_paid,
    'cancellation_fee', v_fee,
    'refund', v_refund,
    'journal_id', v_journal
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_return: lock the original invoice lines FOR UPDATE (in line_no order, so two concurrent
-- returns cannot deadlock and cannot each see the same unreturned quantity), check
-- qty_sold - qty_already_returned, then call the CORE app.create_credit_note for stock and
-- revenue. The refund goes through the balanced-journal hook: cash (Cr Bank) or store credit
-- (Cr Store Credit), as the setting dictates.
-- ---------------------------------------------------------------------------
create or replace function app.create_return(
  p_org_id            uuid,
  p_branch_id         uuid,
  p_original_invoice_id uuid,
  p_lines             jsonb,
  p_return_date       date default null,
  p_refund_method     text default null,
  p_reason            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date          date := coalesce(p_return_date, current_date);
  v_invoice       public.invoices%rowtype;
  v_created_at    timestamptz := clock_timestamp();
  v_return_id     uuid := gen_random_uuid();
  v_return_no     text;
  v_method        text;
  v_line          jsonb;
  v_line_no       int;
  v_inv_line      public.invoice_lines%rowtype;
  v_qty           numeric(19, 4);
  v_returned      numeric(19, 4);
  v_credit        jsonb;
  v_credit_id     uuid;
  v_credit_total  numeric(19, 4);
  v_credit_lines  jsonb := '[]'::jsonb;
  v_journal       uuid;
  v_debit_acct    text;
  v_credit_acct   text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_return requires at least one line' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, v_date);

  select * into v_invoice from public.invoices where id = p_original_invoice_id;
  if not found then
    raise exception 'invoice % not found', p_original_invoice_id using errcode = 'no_data_found';
  end if;

  -- Lock the original invoice lines in a deterministic order.
  for v_line_no in
    select distinct (l ->> 'line_no')::int
      from jsonb_array_elements(p_lines) as l
     order by 1
  loop
    perform 1 from public.invoice_lines il
     where il.invoice_id = p_original_invoice_id and il.line_no = v_line_no
       for update;
  end loop;

  -- Check each line against what has already been returned.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := (v_line ->> 'line_no')::int;
    v_qty := (v_line ->> 'qty')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'return line quantity must be positive' using errcode = '23514';
    end if;

    select * into v_inv_line from public.invoice_lines il
     where il.invoice_id = p_original_invoice_id and il.line_no = v_line_no;
    if not found then
      raise exception 'invoice line % not found on invoice %', v_line_no, p_original_invoice_id
        using errcode = 'no_data_found';
    end if;

    select coalesce(sum(rl.qty), 0) into v_returned
      from public.return_lines rl
      join public.returns r on r.id = rl.return_id
     where rl.invoice_line_id = v_inv_line.id
       and r.status = 'completed';

    if v_returned + v_qty > v_inv_line.qty then
      raise exception 'return of % on line % exceeds the % sold (already returned %)',
        v_qty, v_line_no, v_inv_line.qty, v_returned using errcode = '23514';
    end if;

    v_credit_lines := v_credit_lines || jsonb_build_object('line_no', v_line_no, 'qty', v_qty);
  end loop;

  -- The CORE credit note: reverses revenue, VAT and AR, returns stock at the original FIFO cost.
  v_credit := app.create_credit_note(
    p_org_id, p_branch_id, p_original_invoice_id, v_credit_lines, v_date, p_reason
  );
  v_credit_id := (v_credit ->> 'credit_note_id')::uuid;
  v_credit_total := (v_credit ->> 'total')::numeric;

  v_method := coalesce(
    p_refund_method,
    (select s.return_refund_method from public.settings s where s.org_id = p_org_id),
    'cash'
  );
  if v_method not in ('cash', 'store_credit') then
    raise exception 'unknown refund method %', v_method using errcode = '23514';
  end if;

  v_return_no := app.next_number(p_org_id, 'RETURN');

  insert into public.returns
    (id, org_id, branch_id, original_invoice_id, contact_id, return_no, status, refund_method,
     total, credit_note_id, created_at, updated_at)
  values
    (v_return_id, p_org_id, p_branch_id, p_original_invoice_id, v_invoice.contact_id, v_return_no,
     'completed', v_method, v_credit_total, v_credit_id, v_created_at, v_created_at);

  insert into public.return_lines
    (org_id, branch_id, return_id, invoice_line_id, line_no, qty, unit_price, unit_cost, created_at)
  select p_org_id, p_branch_id, v_return_id, il.id, il.line_no, (l ->> 'qty')::numeric,
         il.unit_price, il.unit_cost, v_created_at
    from jsonb_array_elements(v_credit_lines) as l
    join public.invoice_lines il
      on il.invoice_id = p_original_invoice_id and il.line_no = (l ->> 'line_no')::int;

  -- The refund: Dr AR (the credit note credited it), Cr Bank or Cr Store Credit.
  v_credit_acct := case when v_method = 'cash' then '1200' else '2400' end;

  v_journal := app.post_balanced_journal(
    p_org_id, p_branch_id, v_date, 'return_refund', v_return_id,
    'Refund for return ' || v_return_no, v_invoice.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '1100', 'debit', v_credit_total,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'Accounts receivable cleared'),
      jsonb_build_object('account_code', v_credit_acct, 'credit', v_credit_total,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', case when v_method = 'cash' then 'Cash refund'
                                             else 'Store credit' end)
    )
  );

  update public.returns
     set refund_journal_id = v_journal,
         refund_journal_created_at = (select j.created_at from public.journals j where j.id = v_journal)
   where id = v_return_id;

  return jsonb_build_object(
    'return_id', v_return_id,
    'return_no', v_return_no,
    'credit_note_id', v_credit_id,
    'credit_note_no', v_credit ->> 'credit_no',
    'total', v_credit_total,
    'refund_method', v_method,
    'refund_journal_id', v_journal
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- close_shift: build exactly one immutable z_reports row from the shift's pos_sales and
-- pos_payments, with VAT totals and sale/void counts, then close the shift. No materialized view,
-- no running daily total on each sale.
--
-- Re-creates the R3 app.close_shift(uuid, uuid, uuid) with the same signature (the newest
-- definition wins), so an existing caller keeps working; it now also writes the Z-report. The
-- shift's branch is read from the shift row, so no branch argument is needed. The return type
-- changes from void to uuid, and `create or replace` cannot change a return type, so the old
-- definition is dropped first; the grant is re-issued below.
-- ---------------------------------------------------------------------------
drop function if exists app.close_shift(uuid, uuid, uuid);

create or replace function app.close_shift(
  p_org_id    uuid,
  p_shift_id  uuid,
  p_closed_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift       public.shifts%rowtype;
  v_closed_at   timestamptz := clock_timestamp();
  v_z_id        uuid := gen_random_uuid();
  v_z_no        text;
  v_sale_count  int;
  v_void_count  int;
  v_gross       numeric(19, 4);
  v_tax         numeric(19, 4);
  v_by_method   jsonb;
  v_by_currency jsonb;
  v_vat_by_rate jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift_id and org_id = p_org_id for update;
  if not found then
    raise exception 'shift % is not open for org %', p_shift_id, p_org_id
      using errcode = '23514';
  end if;
  if v_shift.status = 'closed' then
    raise exception 'shift % is already closed', p_shift_id using errcode = '23514';
  end if;

  -- Sale and void counts.
  select count(*) filter (where ps.status = 'completed'),
         count(*) filter (where ps.status = 'voided')
    into v_sale_count, v_void_count
    from public.pos_sales ps
   where ps.org_id = p_org_id
     and ps.branch_id = v_shift.branch_id
     and ps.shift_id = p_shift_id;

  -- Gross sales and VAT, from the invoices the shift's sales posted.
  select coalesce(sum(i.subtotal), 0), coalesce(sum(i.tax_total), 0)
    into v_gross, v_tax
    from public.pos_sales ps
    join public.invoices i on i.id = ps.invoice_id
   where ps.org_id = p_org_id
     and ps.branch_id = v_shift.branch_id
     and ps.shift_id = p_shift_id
     and ps.status = 'completed';

  -- Tenders by method (base-currency amount) and by currency (applied amount).
  select coalesce(jsonb_object_agg(m.method, m.amount), '{}'::jsonb)
    into v_by_method
    from (
      select pp.method, sum(pp.base_amount) as amount
        from public.pos_payments pp
        join public.pos_sales ps on ps.id = pp.sale_id and ps.created_at = pp.sale_created_at
       where ps.org_id = p_org_id and ps.branch_id = v_shift.branch_id
         and ps.shift_id = p_shift_id
       group by pp.method
    ) m;

  select coalesce(jsonb_object_agg(c.currency, c.amount), '{}'::jsonb)
    into v_by_currency
    from (
      select pp.currency, sum(pp.amount_applied) as amount
        from public.pos_payments pp
        join public.pos_sales ps on ps.id = pp.sale_id and ps.created_at = pp.sale_created_at
       where ps.org_id = p_org_id and ps.branch_id = v_shift.branch_id
         and ps.shift_id = p_shift_id
       group by pp.currency
    ) c;

  -- VAT totals by rate, from the shift's invoice lines.
  select coalesce(jsonb_object_agg(v.rate_text, v.amount), '{}'::jsonb)
    into v_vat_by_rate
    from (
      select il.tax_rate::text as rate_text, sum(il.line_tax) as amount
        from public.pos_sales ps
        join public.invoice_lines il on il.invoice_id = ps.invoice_id
       where ps.org_id = p_org_id
         and ps.branch_id = v_shift.branch_id
         and ps.shift_id = p_shift_id
         and ps.status = 'completed'
       group by il.tax_rate
    ) v;

  v_z_no := app.next_number(p_org_id, 'Z_REPORT');

  insert into public.z_reports
    (id, org_id, branch_id, shift_id, z_no, opened_at, closed_at, opening_float, sale_count,
     void_count, gross_sales, tax_total, by_method, by_currency, vat_by_rate, created_at)
  values
    (v_z_id, p_org_id, v_shift.branch_id, p_shift_id, v_z_no, v_shift.opened_at, v_closed_at,
     v_shift.opening_float, v_sale_count, v_void_count, v_gross, v_tax, v_by_method,
     v_by_currency, v_vat_by_rate, v_closed_at);

  update public.shifts
     set status = 'closed', closed_at = v_closed_at, closed_by = coalesce(p_closed_by, auth.uid()),
         updated_at = v_closed_at
   where id = p_shift_id;

  return v_z_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock counts. create_stock_count opens a count with its system quantities snapshotted. Lines are
-- imported with COPY by the caller; the system_qty on each line is what the snapshot says.
-- ---------------------------------------------------------------------------
create or replace function app.create_stock_count(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_warehouse_id uuid,
  p_counted_at   date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id         uuid := gen_random_uuid();
  v_created_at timestamptz := clock_timestamp();
  v_count_no   text;
begin
  v_count_no := app.next_number(p_org_id, 'STOCK_COUNT');

  insert into public.stock_counts
    (id, org_id, branch_id, warehouse_id, count_no, status, counted_at, created_at)
  values
    (v_id, p_org_id, p_branch_id, p_warehouse_id, v_count_no, 'open',
     coalesce(p_counted_at, current_date), v_created_at);

  return jsonb_build_object('count_id', v_id, 'count_no', v_count_no, 'created_at', v_created_at);
end;
$$;

-- close_stock_count: post exactly one CORE stock adjustment (one journal) for the whole count.
-- Every variance writes its own ledger row (inbound layer or FIFO consumption), but the
-- accounting is a single journal: Dr Inventory / Cr Inventory / the variance account.
create or replace function app.close_stock_count(
  p_org_id           uuid,
  p_count_id         uuid,
  p_count_created_at timestamptz,
  p_posting_date     date default null,
  p_memo             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count      public.stock_counts%rowtype;
  v_date       date;
  v_created_at timestamptz := clock_timestamp();
  v_item       record;
  v_variance   numeric(19, 4);
  v_cost       numeric(19, 4);
  v_ledger_id  uuid;
  v_increase   numeric(19, 4) := 0;
  v_decrease   numeric(19, 4) := 0;
  v_adjusted   int := 0;
  v_journal    uuid;
  v_lines      jsonb := '[]'::jsonb;
begin
  select * into v_count
    from public.stock_counts
   where id = p_count_id and created_at = p_count_created_at
     for update;
  if not found then
    raise exception 'stock count % not found', p_count_id using errcode = 'no_data_found';
  end if;
  if v_count.status <> 'open' then
    raise exception 'stock count % is already closed', v_count.count_no using errcode = '23514';
  end if;

  v_date := coalesce(p_posting_date, v_count.counted_at, current_date);
  perform app.assert_period_open(p_org_id, v_date);

  -- Lock every stock row the count touches, in ascending order.
  perform app.lock_stock_balances(
    p_org_id, v_count.branch_id,
    (select coalesce(jsonb_agg(jsonb_build_object(
               'warehouse_id', v_count.warehouse_id,
               'product_id', sci.product_id,
               'variant_id', sci.variant_id)), '[]'::jsonb)
       from public.stock_count_items sci
      where sci.count_id = p_count_id and sci.count_created_at = p_count_created_at)
  );

  for v_item in
    select * from public.stock_count_items
     where count_id = p_count_id and count_created_at = p_count_created_at
     order by product_id, variant_id nulls first, line_no
  loop
    v_variance := v_item.counted_qty - v_item.system_qty;
    if v_variance = 0 then
      continue;
    end if;
    v_adjusted := v_adjusted + 1;

    v_ledger_id := gen_random_uuid();

    if v_variance > 0 then
      v_cost := round(v_variance * v_item.unit_cost, 4);

      insert into public.stock_ledger
        (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
         source_type, source_id, memo, created_at)
      values
        (v_ledger_id, p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id,
         v_item.variant_id, 'in', v_variance, v_item.unit_cost, 'adjustment', p_count_id,
         coalesce(p_memo, 'Stock count ' || v_count.count_no), v_created_at);

      insert into public.stock_layer_balances
        (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id,
         in_ledger_created_at, unit_cost, qty_remaining)
      values
        (p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id, v_item.variant_id,
         v_ledger_id, v_created_at, v_item.unit_cost, v_variance)
      on conflict (in_ledger_id, in_ledger_created_at) do update
        set qty_remaining = public.stock_layer_balances.qty_remaining + excluded.qty_remaining;

      insert into public.stock_balances
        (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
      values
        (p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id, v_item.variant_id,
         v_variance, v_cost)
      on conflict (org_id, warehouse_id, product_id, variant_id) do update
        set qty   = public.stock_balances.qty + excluded.qty,
            value = public.stock_balances.value + excluded.value;

      v_increase := v_increase + v_cost;
    else
      insert into public.stock_ledger
        (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
         source_type, source_id, memo, created_at)
      values
        (v_ledger_id, p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id,
         v_item.variant_id, 'out', -v_variance, 0, 'adjustment', p_count_id,
         coalesce(p_memo, 'Stock count ' || v_count.count_no), v_created_at);

      v_cost := app.consume_fifo(
        p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id, v_item.variant_id,
        -v_variance, v_ledger_id, v_created_at
      );

      insert into public.stock_balances
        (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
      values
        (p_org_id, v_count.branch_id, v_count.warehouse_id, v_item.product_id, v_item.variant_id,
         v_variance, -v_cost)
      on conflict (org_id, warehouse_id, product_id, variant_id) do update
        set qty   = public.stock_balances.qty + excluded.qty,
            value = public.stock_balances.value + excluded.value;

      v_decrease := v_decrease + v_cost;
    end if;
  end loop;

  if v_increase > 0 or v_decrease > 0 then
    v_lines := jsonb_build_array(
      jsonb_build_object('account_code', '1000', 'debit', v_increase, 'description', 'Inventory increase'),
      jsonb_build_object('account_code', '1000', 'credit', v_decrease, 'description', 'Inventory decrease'),
      jsonb_build_object('account_code', '6900', 'credit', v_increase, 'description', 'Inventory adjustment'),
      jsonb_build_object('account_code', '6900', 'debit', v_decrease, 'description', 'Inventory adjustment')
    );

    v_journal := app.post_balanced_journal(
      p_org_id, v_count.branch_id, v_date, 'stock_adjustment', p_count_id,
      coalesce(p_memo, 'Stock count ' || v_count.count_no), 'USD', v_lines
    );
  end if;

  update public.stock_counts
     set status = 'closed', closed_at = v_created_at, journal_id = v_journal,
         journal_created_at = (select j.created_at from public.journals j where j.id = v_journal)
   where id = p_count_id and created_at = p_count_created_at;

  return jsonb_build_object(
    'count_id', p_count_id,
    'count_no', v_count.count_no,
    'adjusted_lines', v_adjusted,
    'inventory_increase', v_increase,
    'inventory_decrease', v_decrease,
    'journal_id', v_journal
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Partitions for the new partitioned table (current month and the next two).
-- ---------------------------------------------------------------------------
select app.ensure_partitions(2);

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
grant execute on function app.post_balanced_journal(uuid, uuid, date, text, uuid, text, text, jsonb)
  to authenticated, service_role;
grant execute on function app.check_credit(uuid, uuid, numeric) to authenticated, service_role;
grant execute on function app.create_layby(uuid, uuid, uuid, uuid, date, jsonb, numeric, text, text, date)
  to authenticated, service_role;
grant execute on function app.complete_layby(uuid, uuid, date, numeric) to authenticated, service_role;
grant execute on function app.cancel_layby(uuid, uuid, date, numeric) to authenticated, service_role;
grant execute on function app.create_return(uuid, uuid, uuid, jsonb, date, text, text)
  to authenticated, service_role;
grant execute on function app.close_shift(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.create_stock_count(uuid, uuid, uuid, date) to authenticated, service_role;
grant execute on function app.close_stock_count(uuid, uuid, timestamptz, date, text)
  to authenticated, service_role;
