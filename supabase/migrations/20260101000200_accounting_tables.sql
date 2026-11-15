-- M1/M2: accounting tables.
--
-- chart_of_accounts, fiscal_periods, tax_rates, exchange_rates -> org scoped
-- journals, journal_lines                                      -> branch scoped, partitioned monthly
--
-- Money is numeric(19,4). The schema contains no float, real or double column.
-- journals and journal_lines are append-only: a correction is a reversing journal whose
-- reversal_of points at the original.

create table public.chart_of_accounts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  code         text not null,
  name         text not null,
  account_type text not null,
  parent_id    uuid references public.chart_of_accounts (id) on delete restrict,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint chart_of_accounts_org_code_key unique (org_id, code),
  constraint chart_of_accounts_type_check
    check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense'))
);

create table public.fiscal_periods (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  is_closed  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_periods_org_start_key unique (org_id, start_date),
  constraint fiscal_periods_range_check check (end_date >= start_date)
);

create table public.tax_rates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  code           text not null,
  name           text not null,
  rate           numeric(9, 6) not null,
  effective_from date not null,
  effective_to   date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint tax_rates_org_code_from_key unique (org_id, code, effective_from),
  constraint tax_rates_rate_check check (rate >= 0 and rate < 1),
  constraint tax_rates_effective_check check (effective_to is null or effective_to >= effective_from)
);

create table public.exchange_rates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  -- base-currency units per one unit of `currency`
  currency       text not null,
  rate           numeric(19, 10) not null,
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint exchange_rates_org_currency_from_key unique (org_id, currency, effective_from),
  constraint exchange_rates_rate_check check (rate > 0),
  constraint exchange_rates_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint exchange_rates_effective_check check (effective_to is null or effective_to >= effective_from)
);

create table public.journals (
  id                  uuid not null default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete restrict,
  branch_id           uuid not null references public.branches (id) on delete restrict,
  posting_date        date not null,
  currency            text not null default 'USD',
  source_type         text not null,
  source_id           uuid,
  memo                text,
  reversal_of         uuid,
  reversal_created_at timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  primary key (id, created_at),
  constraint journals_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint journals_source_type_check
    check (source_type in ('manual', 'invoice', 'receipt', 'payment', 'credit_note',
                           'stock_adjustment', 'reversal')),
  constraint journals_reversal_pair_check
    check ((reversal_of is null) = (reversal_created_at is null)),
  constraint journals_reversal_of_fkey
    foreign key (reversal_of, reversal_created_at)
    references public.journals (id, created_at)
) partition by range (created_at);

create table public.journal_lines (
  id                 uuid not null default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  branch_id          uuid not null references public.branches (id) on delete restrict,
  journal_id         uuid not null,
  -- carries the parent's partition key so the composite FK to journals (id, created_at) works
  journal_created_at timestamptz not null,
  line_no            int not null,
  account_id         uuid not null references public.chart_of_accounts (id) on delete restrict,
  description        text,
  -- transaction-currency amounts
  debit              numeric(19, 4) not null default 0,
  credit             numeric(19, 4) not null default 0,
  currency           text not null default 'USD',
  exchange_rate      numeric(19, 10) not null default 1,
  -- base-currency amounts, rounded to 4 dp per line
  base_debit         numeric(19, 4) not null default 0,
  base_credit        numeric(19, 4) not null default 0,
  tax_rate_id        uuid references public.tax_rates (id) on delete restrict,
  posting_date       date not null,
  created_at         timestamptz not null default now(),
  primary key (id, created_at),
  constraint journal_lines_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict,
  -- a line has either a debit or a credit, never both, and never a negative value
  constraint journal_lines_single_sided_check check ((debit > 0) <> (credit > 0)),
  constraint journal_lines_non_negative_check check (debit >= 0 and credit >= 0),
  constraint journal_lines_base_non_negative_check check (base_debit >= 0 and base_credit >= 0),
  constraint journal_lines_base_single_sided_check check (base_debit = 0 or base_credit = 0),
  constraint journal_lines_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint journal_lines_line_no_check check (line_no >= 1)
) partition by range (created_at);
