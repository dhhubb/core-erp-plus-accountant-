-- M2: accounting engine functions.
--
-- post_journal() is the single entry point for posting. It is synchronous: the journal and its
-- lines are written in the caller's transaction, and the DEFERRABLE INITIALLY DEFERRED balance
-- trigger verifies at commit that the journal has >= 2 lines and that base debits equal base
-- credits.

-- ---------------------------------------------------------------------------
-- Effective-dated lookups.
-- ---------------------------------------------------------------------------

-- Base-currency rate for `currency` effective on p_date. Returns 1 for the base currency.
-- Posting reads this inside its own transaction; reads elsewhere may cache it.
create or replace function app.rate_on(p_org_id uuid, p_currency text, p_date date)
returns numeric
language sql
stable
as $$
  select case
           when p_currency = coalesce(
                  (select s.base_currency from public.settings s where s.org_id = p_org_id),
                  'USD')
             then 1::numeric
           else (
             select r.rate
               from public.exchange_rates r
              where r.org_id = p_org_id
                and r.currency = p_currency
                and r.effective_from <= p_date
                and (r.effective_to is null or r.effective_to >= p_date)
              order by r.effective_from desc
              limit 1
           )
         end;
$$;

-- VAT rate effective on p_date for a tax code.
create or replace function app.tax_rate_on(p_org_id uuid, p_code text, p_date date)
returns numeric
language sql
stable
as $$
  select r.rate
    from public.tax_rates r
   where r.org_id = p_org_id
     and r.code = p_code
     and r.is_active
     and r.effective_from <= p_date
     and (r.effective_to is null or r.effective_to >= p_date)
   order by r.effective_from desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Closed fiscal periods.
-- ---------------------------------------------------------------------------
create or replace function app.assert_period_open(p_org_id uuid, p_date date)
returns void
language plpgsql
stable
as $$
begin
  if exists (
    select 1 from public.fiscal_periods f
     where f.org_id = p_org_id
       and f.is_closed
       and p_date between f.start_date and f.end_date
  ) then
    raise exception 'fiscal period covering % is closed for org %', p_date, p_org_id
      using errcode = '55000';
  end if;
end;
$$;

create or replace function app.journals_reject_closed_period()
returns trigger
language plpgsql
as $$
begin
  perform app.assert_period_open(new.org_id, new.posting_date);
  return new;
end;
$$;

create trigger journals_closed_period before insert on public.journals
  for each row execute function app.journals_reject_closed_period();

-- ---------------------------------------------------------------------------
-- Balance check, deferred to commit. On a partitioned table PG17 clones the parent's constraint
-- trigger onto every existing and future partition (ADR-0001).
-- ---------------------------------------------------------------------------
create or replace function app.journal_lines_check_balance()
returns trigger
language plpgsql
as $$
declare
  v_journal_id uuid;
  v_created_at timestamptz;
  v_lines      int;
  v_debit      numeric(19, 4);
  v_credit     numeric(19, 4);
begin
  if tg_op = 'DELETE' then
    v_journal_id := old.journal_id;
    v_created_at := old.journal_created_at;
  else
    v_journal_id := new.journal_id;
    v_created_at := new.journal_created_at;
  end if;

  select count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    into v_lines, v_debit, v_credit
    from public.journal_lines
   where journal_id = v_journal_id
     and journal_created_at = v_created_at;

  if v_lines < 2 then
    raise exception 'journal % must have at least two lines (has %)', v_journal_id, v_lines
      using errcode = '23514';
  end if;

  if v_debit <> v_credit then
    raise exception 'journal % does not balance: base debit % <> base credit %',
      v_journal_id, v_debit, v_credit
      using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger journal_lines_balance
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function app.journal_lines_check_balance();

-- ---------------------------------------------------------------------------
-- post_journal: post a balanced journal.
--
--   p_lines: jsonb array of
--     { account_code | account_id, debit, credit, currency?, exchange_rate?, description?,
--       tax_rate_id?, tax_rate_code? }
--
-- Resolves account and tax codes, resolves the exchange rate when a foreign currency is used
-- (storing the resolved rate on the line), converts to base currency, rounds to 4 dp per line,
-- and posts any rounding residual to the org's rounding account so the journal still balances.
-- Returns the new journal id.
-- ---------------------------------------------------------------------------
create or replace function app.post_journal(
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
  v_journal_id      uuid := gen_random_uuid();
  v_created_at      timestamptz := clock_timestamp();
  v_currency        text := coalesce(p_currency, 'USD');
  v_default_rate    numeric;
  v_lines           jsonb := '[]'::jsonb;
  v_sum_base_debit  numeric(19, 4) := 0;
  v_sum_base_credit numeric(19, 4) := 0;
  v_line            jsonb;
  v_account_id      uuid;
  v_debit           numeric(19, 4);
  v_credit          numeric(19, 4);
  v_line_currency   text;
  v_rate            numeric;
  v_base_debit      numeric(19, 4);
  v_base_credit     numeric(19, 4);
  v_tax_rate_id     uuid;
  v_line_no         int := 0;
  v_residual        numeric(19, 4);
  v_rounding_code   text;
  v_rounding_account uuid;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'post_journal requires at least two lines' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_posting_date);

  v_default_rate := app.rate_on(p_org_id, v_currency, p_posting_date);
  if v_default_rate is null then
    raise exception 'no exchange rate for % effective on %', v_currency, p_posting_date
      using errcode = 'no_data_found';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;

    if v_line ? 'account_id' and (v_line ->> 'account_id') is not null then
      v_account_id := (v_line ->> 'account_id')::uuid;
    else
      select a.id into v_account_id
        from public.chart_of_accounts a
       where a.org_id = p_org_id and a.code = (v_line ->> 'account_code');
      if v_account_id is null then
        raise exception 'account % not found for org %', v_line ->> 'account_code', p_org_id
          using errcode = 'no_data_found';
      end if;
    end if;

    v_debit  := coalesce((v_line ->> 'debit')::numeric, 0);
    v_credit := coalesce((v_line ->> 'credit')::numeric, 0);

    if v_debit < 0 or v_credit < 0 then
      raise exception 'journal line amounts must not be negative' using errcode = '23514';
    end if;
    if (v_debit > 0) = (v_credit > 0) then
      raise exception 'a journal line has either a debit or a credit, never both'
        using errcode = '23514';
    end if;

    v_line_currency := coalesce(v_line ->> 'currency', v_currency);

    if v_line ? 'exchange_rate' and (v_line ->> 'exchange_rate') is not null then
      v_rate := (v_line ->> 'exchange_rate')::numeric;
    elsif v_line_currency = v_currency then
      v_rate := v_default_rate;
    else
      v_rate := app.rate_on(p_org_id, v_line_currency, p_posting_date);
    end if;

    if v_rate is null then
      raise exception 'no exchange rate for % effective on %', v_line_currency, p_posting_date
        using errcode = 'no_data_found';
    end if;

    v_base_debit  := round(v_debit  * v_rate, 4);
    v_base_credit := round(v_credit * v_rate, 4);

    if v_line ? 'tax_rate_id' and (v_line ->> 'tax_rate_id') is not null then
      v_tax_rate_id := (v_line ->> 'tax_rate_id')::uuid;
    elsif v_line ? 'tax_rate_code' and (v_line ->> 'tax_rate_code') is not null then
      select r.id into v_tax_rate_id
        from public.tax_rates r
       where r.org_id = p_org_id
         and r.code = (v_line ->> 'tax_rate_code')
         and r.effective_from <= p_posting_date
         and (r.effective_to is null or r.effective_to >= p_posting_date)
       order by r.effective_from desc
       limit 1;
    end if;

    v_sum_base_debit  := v_sum_base_debit  + v_base_debit;
    v_sum_base_credit := v_sum_base_credit + v_base_credit;

    v_lines := v_lines || jsonb_build_object(
      'line_no', v_line_no,
      'account_id', v_account_id,
      'description', v_line ->> 'description',
      'debit', v_debit,
      'credit', v_credit,
      'currency', v_line_currency,
      'exchange_rate', v_rate,
      'base_debit', v_base_debit,
      'base_credit', v_base_credit,
      'tax_rate_id', v_tax_rate_id
    );
  end loop;

  -- Rounding residual: post it to the rounding account so the journal still balances.
  v_residual := v_sum_base_debit - v_sum_base_credit;
  if v_residual <> 0 then
    select s.rounding_account_code into v_rounding_code
      from public.settings s where s.org_id = p_org_id;
    v_rounding_code := coalesce(v_rounding_code, '6999');

    select a.id into v_rounding_account
      from public.chart_of_accounts a
     where a.org_id = p_org_id and a.code = v_rounding_code;

    if v_rounding_account is null then
      raise exception 'rounding account % not found for org %', v_rounding_code, p_org_id
        using errcode = 'no_data_found';
    end if;

    v_line_no := v_line_no + 1;
    v_lines := v_lines || jsonb_build_object(
      'line_no', v_line_no,
      'account_id', v_rounding_account,
      'description', 'Rounding residual',
      'debit', case when v_residual < 0 then -v_residual else 0 end,
      'credit', case when v_residual > 0 then v_residual else 0 end,
      'currency', v_currency,
      'exchange_rate', 1,
      'base_debit', case when v_residual < 0 then -v_residual else 0 end,
      'base_credit', case when v_residual > 0 then v_residual else 0 end,
      'tax_rate_id', null
    );
  end if;

  insert into public.journals
    (id, org_id, branch_id, posting_date, currency, source_type, source_id, memo, created_by,
     created_at)
  values
    (v_journal_id, p_org_id, p_branch_id, p_posting_date, v_currency, p_source_type, p_source_id,
     p_memo, auth.uid(), v_created_at);

  insert into public.journal_lines
    (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, description,
     debit, credit, currency, exchange_rate, base_debit, base_credit, tax_rate_id, posting_date,
     created_at)
  select p_org_id,
         p_branch_id,
         v_journal_id,
         v_created_at,
         (l ->> 'line_no')::int,
         (l ->> 'account_id')::uuid,
         l ->> 'description',
         (l ->> 'debit')::numeric,
         (l ->> 'credit')::numeric,
         l ->> 'currency',
         (l ->> 'exchange_rate')::numeric,
         (l ->> 'base_debit')::numeric,
         (l ->> 'base_credit')::numeric,
         nullif(l ->> 'tax_rate_id', '')::uuid,
         p_posting_date,
         v_created_at
    from jsonb_array_elements(v_lines) as l;

  return v_journal_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- reverse_journal: post a mirror-image journal whose reversal_of points at the original.
-- Nothing is updated or deleted.
-- ---------------------------------------------------------------------------
create or replace function app.reverse_journal(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_journal_id   uuid,
  p_created_at   timestamptz,
  p_posting_date date,
  p_memo         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_journal    public.journals%rowtype;
  v_new_id     uuid := gen_random_uuid();
  v_created_at timestamptz := clock_timestamp();
begin
  select * into v_journal
    from public.journals
   where id = p_journal_id and created_at = p_created_at;

  if not found then
    raise exception 'journal % not found', p_journal_id using errcode = 'no_data_found';
  end if;

  perform app.assert_period_open(p_org_id, coalesce(p_posting_date, v_journal.posting_date));

  insert into public.journals
    (id, org_id, branch_id, posting_date, currency, source_type, source_id, memo,
     reversal_of, reversal_created_at, created_by, created_at)
  values
    (v_new_id, v_journal.org_id, v_journal.branch_id,
     coalesce(p_posting_date, v_journal.posting_date), v_journal.currency, 'reversal',
     v_journal.source_id, coalesce(p_memo, 'Reversal of ' || p_journal_id::text),
     v_journal.id, v_journal.created_at, auth.uid(), v_created_at);

  insert into public.journal_lines
    (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, description,
     debit, credit, currency, exchange_rate, base_debit, base_credit, tax_rate_id, posting_date,
     created_at)
  select l.org_id, l.branch_id, v_new_id, v_created_at, l.line_no, l.account_id,
         l.description, l.credit, l.debit, l.currency, l.exchange_rate,
         l.base_credit, l.base_debit, l.tax_rate_id,
         coalesce(p_posting_date, v_journal.posting_date), v_created_at
    from public.journal_lines l
   where l.journal_id = p_journal_id and l.journal_created_at = p_created_at
   order by l.line_no;

  return v_new_id;
end;
$$;
