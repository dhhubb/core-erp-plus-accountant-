-- H6 — Reports and the owner console (ADR-0045 .. ADR-0049).
--
-- Additive. It changes no core table shape and no core function signature. It adds one
-- append-only fact table and a set of read-only report functions.
--
--   * public.daily_product_sales   (branch-scoped, APPEND-ONLY): one row per closed shift, per
--                                   business date, per product/variant — the day's quantity, revenue,
--                                   tax and cost of goods sold. Written by app.close_shift.
--   * app.report_profit_by_product(...)  — per-product profit for a period, keyset on product_id
--   * app.report_best_sellers(...)       — top products by quantity, keyset on (qty, product_id)
--   * app.report_slow_movers(...)        — products that barely moved, keyset on (qty, product_id)
--   * app.report_vat(...)                — sales split by VAT rate, for the ZIMRA return
--   * app.report_z_reports(...)          — Z-reports, each with its fiscal totals (sent/pending/failed)
--   * app.report_gl_period_profit(...)   — GL revenue minus cost of goods sold for the period
--   * app.report_last_sync(...)          — when the branch last synced (the cloud console label)
--
-- Two sources, one rule (ADR-0046):
--   * a day that has closed is read from the immutable daily facts;
--   * today is read live from invoices + invoice_lines, bounded by invoice_date and an index.
-- The two never overlap: the facts side stops at current_date - 1.

-- ---------------------------------------------------------------------------
-- Daily product sales. APPEND-ONLY. The grain is (shift, business date, product, variant), so a
-- shift that closes writes its rows exactly once and a day with two shifts has two rows per
-- product that the reports sum. The unique key makes the close idempotent at the row level.
-- ---------------------------------------------------------------------------
create table public.daily_product_sales (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete restrict,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  business_date date not null,
  shift_id      uuid not null references public.shifts (id) on delete restrict,
  z_report_id   uuid references public.z_reports (id) on delete restrict,
  product_id    uuid not null references public.products (id) on delete restrict,
  variant_id    uuid references public.product_variants (id) on delete restrict,
  currency      text not null default 'USD',
  qty           numeric(19, 4) not null default 0,
  gross         numeric(19, 4) not null default 0,
  tax           numeric(19, 4) not null default 0,
  cogs          numeric(19, 4) not null default 0,
  created_at    timestamptz not null default now(),
  constraint daily_product_sales_qty_check check (qty >= 0),
  constraint daily_product_sales_key
    unique nulls not distinct (org_id, branch_id, shift_id, business_date, product_id, variant_id)
);

-- The high-volume branch index every branch-scoped table carries.
create index daily_product_sales_org_branch_created_idx
  on public.daily_product_sales (org_id, branch_id, created_at desc, id desc);
create index daily_product_sales_org_created_idx
  on public.daily_product_sales (org_id, created_at desc, id desc);
-- The report's keyset index: ordered by product for a date range, so a per-product page stops as
-- soon as it has `limit` groups (test 91).
create index daily_product_sales_org_branch_product_idx
  on public.daily_product_sales (org_id, branch_id, product_id, business_date);
-- The date-range index: the closed-day side of every report.
create index daily_product_sales_org_branch_date_idx
  on public.daily_product_sales (org_id, branch_id, business_date desc, product_id);
-- Every foreign key column gets an index.
create index daily_product_sales_branch_id_idx on public.daily_product_sales (branch_id);
create index daily_product_sales_shift_idx on public.daily_product_sales (shift_id);
create index daily_product_sales_z_report_idx on public.daily_product_sales (z_report_id);
create index daily_product_sales_product_id_idx on public.daily_product_sales (product_id);
create index daily_product_sales_variant_id_idx on public.daily_product_sales (variant_id);

select app.apply_tenant_rls('public.daily_product_sales', 'branch');
select app.enforce_immutable('public.daily_product_sales');

-- ---------------------------------------------------------------------------
-- The live side of a report bounds today by invoice_date. The core has no index on that column, so
-- add one (additive; ADR-0047). Without it the today query would filter every invoice of the org.
-- ---------------------------------------------------------------------------
create index invoices_org_branch_date_idx on public.invoices (org_id, branch_id, invoice_date, id);

-- ---------------------------------------------------------------------------
-- record_shift_daily_facts: write the closed shift's daily facts. Called by app.close_shift in the
-- same transaction as the Z-report. One row per (business date, product, variant) of the shift's
-- completed sales, with the revenue (excl. tax), the tax and the cost of goods sold.
-- ---------------------------------------------------------------------------
create or replace function app.record_shift_daily_facts(
  p_org_id      uuid,
  p_branch_id   uuid,
  p_shift_id    uuid,
  p_z_report_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  insert into public.daily_product_sales
    (org_id, branch_id, business_date, shift_id, z_report_id, product_id, variant_id, currency,
     qty, gross, tax, cogs, created_at)
  select p_org_id, p_branch_id, i.invoice_date, p_shift_id, p_z_report_id, il.product_id,
         il.variant_id, i.currency,
         sum(il.qty), sum(il.line_subtotal), sum(il.line_tax),
         sum(round(il.qty * il.unit_cost, 4)), now()
    from public.pos_sales ps
    join public.invoices i on i.id = ps.invoice_id
    join public.invoice_lines il on il.invoice_id = i.id
   where ps.org_id = p_org_id
     and ps.branch_id = p_branch_id
     and ps.shift_id = p_shift_id
     and ps.status = 'completed'
   group by i.invoice_date, i.currency, il.product_id, il.variant_id
  on conflict (org_id, branch_id, shift_id, business_date, product_id, variant_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_shift: re-created from R5 with the same signature. It now also writes the shift's daily
-- facts after the immutable Z-report (ADR-0046), so a closed day is a fact rather than a query over
-- the live sales tables. Everything else is unchanged.
-- ---------------------------------------------------------------------------
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

  -- The day's facts. From here on the shift's figures are read from daily_product_sales, not from
  -- the live sales tables.
  perform app.record_shift_daily_facts(p_org_id, v_shift.branch_id, p_shift_id, v_z_id);

  update public.shifts
     set status = 'closed', closed_at = v_closed_at, closed_by = coalesce(p_closed_by, auth.uid()),
         updated_at = v_closed_at
   where id = p_shift_id;

  return v_z_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- report_profit_by_product: per-product profit for a period, keyset on product_id.
--
-- Closed days come from the immutable daily facts; today comes live from invoices + invoice_lines,
-- bounded by invoice_date. Returns are netted out as negative rows (ADR-0048). Keyset pagination
-- on product_id lets a page stop after `limit` groups, so a report over 1M closed-day facts returns
-- fast (test 91).
-- ---------------------------------------------------------------------------
create or replace function app.report_profit_by_product(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_from             date,
  p_to               date,
  p_limit            int default 50,
  p_after_product_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_rows  jsonb;
  v_last  jsonb;
begin
  -- Each branch is its own keyset page of at most v_limit products, ordered by product_id. The
  -- smallest v_limit product ids of the union are guaranteed to lie in the union of the smallest
  -- v_limit of each branch, so merging the (at most 3 * v_limit) branch rows and re-limiting is
  -- exact. This keeps the closed-day branch a streaming index scan (ADR-0045), so a report over a
  -- million closed-day facts stays fast (test 91).
  with facts as (
    select f.product_id, sum(f.qty) as qty, sum(f.gross) as gross, sum(f.tax) as tax,
           sum(f.cogs) as cogs
      from public.daily_product_sales f
     where f.org_id = p_org_id
       and f.branch_id = p_branch_id
       and f.business_date between p_from and least(p_to, current_date - 1)
       and (p_after_product_id is null or f.product_id > p_after_product_id)
     group by f.product_id
     order by f.product_id
     limit v_limit
  ),
  live as (
    select il.product_id, sum(il.qty) as qty, sum(il.line_subtotal) as gross,
           sum(il.line_tax) as tax, sum(round(il.qty * il.unit_cost, 4)) as cogs
      from public.invoices i
      join public.invoice_lines il on il.invoice_id = i.id
     where i.org_id = p_org_id
       and i.branch_id = p_branch_id
       and i.invoice_date = current_date
       and current_date between p_from and p_to
       and (p_after_product_id is null or il.product_id > p_after_product_id)
       and not exists (
         select 1 from public.pos_sales ps
          where ps.invoice_id = i.id and ps.status = 'voided')
     group by il.product_id
     order by il.product_id
     limit v_limit
  ),
  ret as (
    select il.product_id, sum(-rl.qty) as qty, sum(-round(rl.qty * rl.unit_price, 4)) as gross,
           sum(-round(rl.qty * rl.unit_price * il.tax_rate, 4)) as tax,
           sum(-round(rl.qty * il.unit_cost, 4)) as cogs
      from public.returns r
      join public.return_lines rl on rl.return_id = r.id
      join public.invoice_lines il on il.id = rl.invoice_line_id
     where r.org_id = p_org_id
       and r.branch_id = p_branch_id
       and r.status = 'completed'
       and r.created_at::date between p_from and p_to
       and (p_after_product_id is null or il.product_id > p_after_product_id)
     group by il.product_id
     order by il.product_id
     limit v_limit
  ),
  merged as (
    select u.product_id, sum(u.qty) as qty, sum(u.gross) as gross, sum(u.tax) as tax,
           sum(u.cogs) as cogs
      from (select * from facts union all select * from live union all select * from ret) u
     group by u.product_id
     order by u.product_id
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', m.product_id,
           'qty', m.qty,
           'revenue', m.gross,
           'tax', m.tax,
           'cogs', m.cogs,
           'profit', m.gross - m.cogs) order by m.product_id), '[]'::jsonb)
    into v_rows
    from merged m;

  v_last := v_rows -> (jsonb_array_length(v_rows) - 1);

  return jsonb_build_object(
    'rows', v_rows,
    'next_after_product_id',
      case when jsonb_array_length(v_rows) = v_limit
           then (v_last ->> 'product_id')::uuid end);
end;
$$;

-- ---------------------------------------------------------------------------
-- report_best_sellers / report_slow_movers: the same source, ranked by quantity. Keyset on
-- (qty, product_id) so a page is bounded by the ranking, not by the table.
-- ---------------------------------------------------------------------------
create or replace function app.report_product_ranking(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_from             date,
  p_to               date,
  p_ascending        boolean,
  p_limit            int default 50,
  p_after_qty        numeric default null,
  p_after_product_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_rows  jsonb;
  v_last  jsonb;
begin
  -- Per branch, take the v_limit rows nearest the cursor in rank order, then merge. The global
  -- page is contained in the union of the per-branch pages, so the merge is exact.
  with facts as (
    select f.product_id, sum(f.qty) as qty, sum(f.gross) as gross, sum(f.tax) as tax,
           sum(f.cogs) as cogs
      from public.daily_product_sales f
     where f.org_id = p_org_id
       and f.branch_id = p_branch_id
       and f.business_date between p_from and least(p_to, current_date - 1)
     group by f.product_id
     having sum(f.qty) > 0
       and (p_after_product_id is null
            or (p_ascending and (sum(f.qty), f.product_id) > (p_after_qty, p_after_product_id))
            or (not p_ascending and (sum(f.qty), f.product_id) < (p_after_qty, p_after_product_id)))
     order by (case when p_ascending then sum(f.qty) end) asc,
              (case when not p_ascending then sum(f.qty) end) desc,
              f.product_id asc
     limit v_limit
  ),
  live as (
    select il.product_id, sum(il.qty) as qty, sum(il.line_subtotal) as gross,
           sum(il.line_tax) as tax, sum(round(il.qty * il.unit_cost, 4)) as cogs
      from public.invoices i
      join public.invoice_lines il on il.invoice_id = i.id
     where i.org_id = p_org_id
       and i.branch_id = p_branch_id
       and i.invoice_date = current_date
       and current_date between p_from and p_to
       and not exists (
         select 1 from public.pos_sales ps
          where ps.invoice_id = i.id and ps.status = 'voided')
     group by il.product_id
     limit v_limit
  ),
  ret as (
    select il.product_id, sum(-rl.qty) as qty, sum(-round(rl.qty * rl.unit_price, 4)) as gross,
           sum(-round(rl.qty * rl.unit_price * il.tax_rate, 4)) as tax,
           sum(-round(rl.qty * il.unit_cost, 4)) as cogs
      from public.returns r
      join public.return_lines rl on rl.return_id = r.id
      join public.invoice_lines il on il.id = rl.invoice_line_id
     where r.org_id = p_org_id
       and r.branch_id = p_branch_id
       and r.status = 'completed'
       and r.created_at::date between p_from and p_to
     group by il.product_id
     limit v_limit
  ),
  agg as (
    select u.product_id, sum(u.qty) as qty, sum(u.gross) as gross, sum(u.tax) as tax,
           sum(u.cogs) as cogs
      from (select * from facts union all select * from live union all select * from ret) u
     group by u.product_id
  ),
  page as (
    select a.*
      from agg a
     where a.qty > 0
       and (p_after_product_id is null
            or (p_ascending and (a.qty, a.product_id) > (p_after_qty, p_after_product_id))
            or (not p_ascending and (a.qty, a.product_id) < (p_after_qty, p_after_product_id)))
     order by (case when p_ascending then a.qty end) asc,
              (case when not p_ascending then a.qty end) desc,
              a.product_id asc
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.product_id, 'qty', p.qty, 'revenue', p.gross, 'tax', p.tax,
           'cogs', p.cogs, 'profit', p.gross - p.cogs)
           order by (case when p_ascending then p.qty end) asc,
                    (case when not p_ascending then p.qty end) desc,
                    p.product_id asc), '[]'::jsonb)
    into v_rows
    from page p;

  v_last := v_rows -> (jsonb_array_length(v_rows) - 1);

  return jsonb_build_object(
    'rows', v_rows,
    'next_after_qty',
      case when jsonb_array_length(v_rows) = v_limit then (v_last ->> 'qty')::numeric end,
    'next_after_product_id',
      case when jsonb_array_length(v_rows) = v_limit then (v_last ->> 'product_id')::uuid end);
end;
$$;

create or replace function app.report_best_sellers(
  p_org_id uuid, p_branch_id uuid, p_from date, p_to date,
  p_limit int default 50, p_after_qty numeric default null, p_after_product_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select app.report_product_ranking(p_org_id, p_branch_id, p_from, p_to, false, p_limit,
                                    p_after_qty, p_after_product_id);
$$;

create or replace function app.report_slow_movers(
  p_org_id uuid, p_branch_id uuid, p_from date, p_to date,
  p_limit int default 50, p_after_qty numeric default null, p_after_product_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select app.report_product_ranking(p_org_id, p_branch_id, p_from, p_to, true, p_limit,
                                    p_after_qty, p_after_product_id);
$$;

-- ---------------------------------------------------------------------------
-- report_vat: sales split by VAT rate for a period, for the ZIMRA return. It reads invoice_lines
-- directly (not the daily facts), because the per-rate split is not part of the daily fact grain
-- (ADR-0046). The same source the Z-report's vat_by_rate uses, so the two agree (test 88).
-- ---------------------------------------------------------------------------
create or replace function app.report_vat(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'tax_rate', v.tax_rate,
           'net', v.net,
           'tax', v.tax,
           'gross', v.gross,
           'line_count', v.line_count) order by v.tax_rate), '[]'::jsonb)
    from (
      select il.tax_rate, sum(il.line_subtotal) as net, sum(il.line_tax) as tax,
             sum(il.line_total) as gross, count(*) as line_count
        from public.invoices i
        join public.invoice_lines il on il.invoice_id = i.id
       where i.org_id = p_org_id
         and i.branch_id = p_branch_id
         and i.invoice_date between p_from and p_to
       group by il.tax_rate
    ) v;
$$;

-- ---------------------------------------------------------------------------
-- report_z_reports: a keyset page of Z-reports, each with its fiscal totals — how many of the
-- shift's invoices were sent, still pending, or failed, and their amounts. The fiscal totals are
-- computed at read time (the row is immutable and a fiscal status changes after the close), so the
-- page always shows the truth now (ADR-0047, test 89).
-- ---------------------------------------------------------------------------
create or replace function app.report_z_reports(
  p_org_id    uuid,
  p_branch_id uuid,
  p_limit     int default 50,
  p_after_created_at timestamptz default null,
  p_after_id  uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_rows  jsonb;
  v_last  jsonb;
begin
  with page as (
    select z.id, z.z_no, z.shift_id, z.opened_at, z.closed_at, z.opening_float, z.sale_count,
           z.void_count, z.gross_sales, z.tax_total, z.by_method, z.by_currency, z.vat_by_rate,
           z.created_at
      from public.z_reports z
     where z.org_id = p_org_id
       and z.branch_id = p_branch_id
       and (p_after_created_at is null
            or (z.created_at, z.id) < (p_after_created_at, p_after_id))
     order by z.created_at desc, z.id desc
     limit v_limit
  ),
  fiscal as (
    select ps.shift_id, fi.status,
           count(*) as invoice_count, coalesce(sum(i.total), 0) as amount
      from public.fiscal_invoices fi
      join public.pos_sales ps on ps.invoice_id = fi.invoice_id
      join public.invoices i on i.id = fi.invoice_id
     where fi.org_id = p_org_id and fi.branch_id = p_branch_id
     group by ps.shift_id, fi.status
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pg.id, 'z_no', pg.z_no, 'shift_id', pg.shift_id, 'opened_at', pg.opened_at,
           'closed_at', pg.closed_at, 'opening_float', pg.opening_float,
           'sale_count', pg.sale_count, 'void_count', pg.void_count,
           'gross_sales', pg.gross_sales, 'tax_total', pg.tax_total,
           'by_method', pg.by_method, 'by_currency', pg.by_currency,
           'vat_by_rate', pg.vat_by_rate, 'created_at', pg.created_at,
           'fiscal', jsonb_build_object(
             'sent', coalesce((select jsonb_build_object('count', f.invoice_count, 'amount', f.amount)
                                 from fiscal f where f.shift_id = pg.shift_id and f.status = 'sent'),
                              jsonb_build_object('count', 0, 'amount', 0)),
             'pending', coalesce((select jsonb_build_object('count', f.invoice_count, 'amount', f.amount)
                                    from fiscal f where f.shift_id = pg.shift_id and f.status = 'pending'),
                                 jsonb_build_object('count', 0, 'amount', 0)),
             'failed', coalesce((select jsonb_build_object('count', f.invoice_count, 'amount', f.amount)
                                   from fiscal f where f.shift_id = pg.shift_id and f.status = 'failed'),
                                jsonb_build_object('count', 0, 'amount', 0))
           )
         ) order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_rows
    from page pg;

  v_last := v_rows -> (jsonb_array_length(v_rows) - 1);

  return jsonb_build_object(
    'rows', v_rows,
    'next_after_created_at',
      case when jsonb_array_length(v_rows) = v_limit then v_last ->> 'created_at' end,
    'next_after_id',
      case when jsonb_array_length(v_rows) = v_limit then v_last ->> 'id' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- report_gl_period_profit: GL revenue minus cost of goods sold for the period, read straight from
-- journal_lines. This is what the profit-by-product report must equal (test 86).
-- ---------------------------------------------------------------------------
create or replace function app.report_gl_period_profit(
  p_org_id    uuid,
  p_branch_id uuid,
  p_from      date,
  p_to        date
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'revenue', coalesce(sum(case when a.account_type = 'revenue'
                                 then jl.base_credit - jl.base_debit end), 0),
    'cogs', coalesce(sum(case when a.code = '5000'
                              then jl.base_debit - jl.base_credit end), 0),
    'profit', coalesce(sum(case when a.account_type = 'revenue'
                                then jl.base_credit - jl.base_debit end), 0)
              - coalesce(sum(case when a.code = '5000'
                                  then jl.base_debit - jl.base_credit end), 0))
    from public.journal_lines jl
    join public.chart_of_accounts a on a.id = jl.account_id
   where jl.org_id = p_org_id
     and jl.branch_id = p_branch_id
     and jl.posting_date between p_from and p_to
     and (a.account_type = 'revenue' or a.code = '5000');
$$;

-- ---------------------------------------------------------------------------
-- report_last_sync: when the branch last synced. On the branch this is its own observation; on the
-- cloud it is the last event the cloud received. The owner console always shows it.
-- ---------------------------------------------------------------------------
create or replace function app.report_last_sync(
  p_org_id    uuid,
  p_branch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'last_cloud_contact_at', (
      select s.last_cloud_contact_at from public.sync_state s
       where s.org_id = p_org_id and s.branch_id = p_branch_id),
    'last_ingest_at', (
      select max(si.applied_at) from public.sync_inbox si
       where si.org_id = p_org_id and si.branch_id = p_branch_id),
    'last_pushed_seq', (
      select s.last_pushed_seq from public.sync_state s
       where s.org_id = p_org_id and s.branch_id = p_branch_id),
    'outbox_size', (
      select count(*) from public.sync_outbox o
       where o.org_id = p_org_id and o.branch_id = p_branch_id and o.acked_at is null));
$$;

-- Grants.
grant execute on function app.record_shift_daily_facts(uuid, uuid, uuid, uuid)
  to authenticated, service_role;
grant execute on function app.report_profit_by_product(uuid, uuid, date, date, int, uuid)
  to authenticated, service_role;
grant execute on function app.report_product_ranking(uuid, uuid, date, date, boolean, int, numeric, uuid)
  to authenticated, service_role;
grant execute on function app.report_best_sellers(uuid, uuid, date, date, int, numeric, uuid)
  to authenticated, service_role;
grant execute on function app.report_slow_movers(uuid, uuid, date, date, int, numeric, uuid)
  to authenticated, service_role;
grant execute on function app.report_vat(uuid, uuid, date, date) to authenticated, service_role;
grant execute on function app.report_z_reports(uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.report_gl_period_profit(uuid, uuid, date, date)
  to authenticated, service_role;
grant execute on function app.report_last_sync(uuid, uuid) to authenticated, service_role;
