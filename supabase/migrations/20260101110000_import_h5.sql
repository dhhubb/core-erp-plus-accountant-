-- H5: Migration wizard (bring a shop's products, customers and opening stock from Pastel).
--
-- Additive only. Nothing here edits an applied migration. Two core tables are extended additively
-- (`products.external_code`, `contacts.external_code`) and one core function is RE-CREATED with an
-- extra default account (`app.create_default_accounts`); the newest definition wins, exactly as R5
-- re-created it (ADR-0019).
--
-- Adds:
--   * public.import_jobs      (branch; one row per wizard run, MUTABLE status)
--   * public.import_rows      (branch; the COPY staging table, one row per source line)
--   * public.import_mappings  (branch; the saved column mapping, one per kind per shop)
--
--   * app.import_job_create(...)      — open a job (kind + source name + mapping)
--   * app.import_validate_job(...)    — validate every staged row in SQL, per-row errors
--   * app.import_update_row(...)      — fix one row's data and revalidate it
--   * app.import_commit_job(...)      — apply the whole job in one transaction
--   * app.import_job_rows(...)        — keyset page of rows + their errors (the UI)
--   * app.import_save_mapping(...) / app.import_get_mapping(...) — the saved column mapping
--   * app.import_row_errors(...)      — the per-row validation rules (pure)
--   * app.import_natural_key(...)     — the idempotency key a row is deduped on
--   * app.ensure_retail_price_list(...) — the retail price list an imported price lands in
--
-- Design notes (ADR-0042):
--   * A job is staged with COPY (fast), validated set-based in SQL, and committed in ONE
--     transaction. A failure part-way through leaves no partial data: the whole job rolls back.
--   * Products and customers carry the Pastel code as `external_code`, a unique external key, so
--     re-running the same file updates the existing rows instead of duplicating them.
--   * Opening stock writes append-only `stock_ledger` rows of source type 'opening' and ONE
--     balanced journal (Dr Inventory, Cr Opening Balance Equity) through the balanced-journal hook.
--   * Opening-stock rows are idempotent on (product, warehouse): a row already committed for the
--     same natural key is skipped on a re-run rather than double-counted.

-- ---------------------------------------------------------------------------
-- Additive core change: an external key on products and contacts. The Pastel code lands here. The
-- unique constraint allows any number of NULLs (a normal unique constraint treats NULLs as
-- distinct), so every pre-existing row and every non-imported row is unaffected.
-- ---------------------------------------------------------------------------
alter table public.products add column external_code text;
alter table public.products
  add constraint products_org_external_code_key unique (org_id, external_code);

alter table public.contacts add column external_code text;
alter table public.contacts
  add constraint contacts_org_external_code_key unique (org_id, external_code);

-- Opening stock credits Opening Balance Equity. Added to the org-creation trigger; existing orgs
-- keep the accounts they already have (this phase only creates orgs through app.create_org).
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
    (new.id, '3900', 'Opening Balance Equity', 'equity'),
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

-- The replace above only reaches orgs created after this migration (the trigger runs on insert).
-- Give the orgs that already exist the one account it adds, so an opening-stock import on an
-- existing org does not fail on a missing 3900.
insert into public.chart_of_accounts (org_id, code, name, account_type)
select o.id, '3900', 'Opening Balance Equity', 'equity'
  from public.organizations o
on conflict (org_id, code) do nothing;

-- The journal source type an opening-stock import posts under.
alter table public.journals drop constraint journals_source_type_check;
alter table public.journals add constraint journals_source_type_check
  check (source_type in ('manual', 'invoice', 'receipt', 'payment', 'credit_note',
                         'stock_adjustment', 'reversal',
                         'layby_deposit', 'layby_cancellation', 'return_refund',
                         'opening'));

-- ---------------------------------------------------------------------------
-- Import jobs. One row per wizard run. `kind` is products | customers | opening_stock. `status`
-- moves draft -> validated | invalid -> committed. `mapping` records the column mapping the run
-- used; `result` records the commit summary.
-- ---------------------------------------------------------------------------
create table public.import_jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  kind         text not null,
  status       text not null default 'draft',
  source_name  text,
  mapping      jsonb not null default '{}'::jsonb,
  total_rows   int not null default 0,
  error_rows   int not null default 0,
  result       jsonb,
  committed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint import_jobs_kind_check check (kind in ('products', 'customers', 'opening_stock')),
  constraint import_jobs_status_check
    check (status in ('draft', 'validated', 'invalid', 'committed')),
  constraint import_jobs_mapping_check check (jsonb_typeof(mapping) = 'object'),
  constraint import_jobs_counts_check check (total_rows >= 0 and error_rows >= 0)
);

create index import_jobs_org_branch_created_idx
  on public.import_jobs (org_id, branch_id, created_at desc, id desc);
create index import_jobs_org_created_idx
  on public.import_jobs (org_id, created_at desc, id desc);
create index import_jobs_branch_id_idx on public.import_jobs (branch_id);

-- ---------------------------------------------------------------------------
-- Import rows: the staging table a chunked COPY loads into. `data` is the mapped row (JSON text
-- from the file); `errors` is the validation result; `natural_key` is the idempotency key.
-- ---------------------------------------------------------------------------
create table public.import_rows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  job_id      uuid not null references public.import_jobs (id) on delete cascade,
  row_no      int not null,
  data        jsonb not null default '{}'::jsonb,
  errors      jsonb not null default '[]'::jsonb,
  natural_key text,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint import_rows_status_check
    check (status in ('pending', 'valid', 'invalid', 'skipped', 'committed')),
  constraint import_rows_data_check check (jsonb_typeof(data) = 'object'),
  constraint import_rows_errors_check check (jsonb_typeof(errors) = 'array'),
  constraint import_rows_row_no_check check (row_no > 0),
  constraint import_rows_job_row_key unique (job_id, row_no)
);

create index import_rows_org_branch_created_idx
  on public.import_rows (org_id, branch_id, created_at desc, id desc);
create index import_rows_org_created_idx
  on public.import_rows (org_id, created_at desc, id desc);
create index import_rows_branch_id_idx on public.import_rows (branch_id);
create index import_rows_job_id_idx on public.import_rows (job_id);

-- A row that has been committed under a natural key blocks a second commit of the same key, so a
-- re-run of an opening-stock file cannot double-count. Rows with no natural key (products,
-- customers) are deduped by their external key instead, so they are not indexed here.
create unique index import_rows_committed_natural_key
  on public.import_rows (org_id, branch_id, natural_key)
  where status = 'committed' and natural_key is not null;

-- ---------------------------------------------------------------------------
-- Saved column mappings: one per kind per shop (branch). The wizard reads this back so the shop
-- does not remap Pastel's columns every time.
-- ---------------------------------------------------------------------------
create table public.import_mappings (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  branch_id  uuid not null references public.branches (id) on delete restrict,
  kind       text not null,
  mapping    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_mappings_kind_check check (kind in ('products', 'customers', 'opening_stock')),
  constraint import_mappings_mapping_check check (jsonb_typeof(mapping) = 'object'),
  constraint import_mappings_branch_kind_key unique (org_id, branch_id, kind)
);

create index import_mappings_org_branch_created_idx
  on public.import_mappings (org_id, branch_id, created_at desc, id desc);
create index import_mappings_org_created_idx
  on public.import_mappings (org_id, created_at desc, id desc);
create index import_mappings_branch_id_idx on public.import_mappings (branch_id);

create trigger import_jobs_set_updated_at before update on public.import_jobs
  for each row execute function app.set_updated_at();
create trigger import_rows_set_updated_at before update on public.import_rows
  for each row execute function app.set_updated_at();
create trigger import_mappings_set_updated_at before update on public.import_mappings
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- The per-row validation rules. Pure: it reads only the row's mapped data, so it is deterministic
-- and cheap (a set-based UPDATE can call it once per row).
-- ---------------------------------------------------------------------------
create or replace function app.import_row_errors(p_kind text, p_data jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_text   text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_array(jsonb_build_object('field', '_row', 'message', 'the row is empty'));
  end if;

  if p_kind = 'products' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'the Pastel code (external code) is required');
    end if;
    if btrim(coalesce(p_data ->> 'name', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'name', 'message', 'name is required');
    end if;
    -- Unit is optional (it defaults to 'each'), so only a value that is present and wrong fails.
    v_text := lower(btrim(coalesce(p_data ->> 'unit', '')));
    if v_text <> '' and v_text not in ('each', 'kg', 'g', 'l', 'ml', 'pack') then
      v_errors := v_errors || jsonb_build_object('field', 'unit',
        'message', 'unit must be one of each, kg, g, l, ml, pack');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'price', '')), '') is not null
       and btrim(p_data ->> 'price') !~ '^[0-9]+(\.[0-9]+)?$' then
      v_errors := v_errors || jsonb_build_object('field', 'price',
        'message', 'price must be a non-negative number');
    end if;

  elsif p_kind = 'customers' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'the Pastel code (external code) is required');
    end if;
    if btrim(coalesce(p_data ->> 'name', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'name', 'message', 'name is required');
    end if;
    v_text := lower(btrim(coalesce(p_data ->> 'kind', '')));
    if v_text <> '' and v_text not in ('customer', 'supplier', 'both') then
      v_errors := v_errors || jsonb_build_object('field', 'kind',
        'message', 'kind must be customer, supplier or both');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'email', '')), '') is not null
       and position('@' in (p_data ->> 'email')) = 0 then
      v_errors := v_errors || jsonb_build_object('field', 'email',
        'message', 'email must contain @');
    end if;

  elsif p_kind = 'opening_stock' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = ''
       and btrim(coalesce(p_data ->> 'sku', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'a product external code or SKU is required');
    end if;
    if btrim(coalesce(p_data ->> 'qty', '')) !~ '^[0-9]+(\.[0-9]+)?$'
       or btrim(coalesce(p_data ->> 'qty', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'qty',
        'message', 'quantity must be a positive number');
    elsif btrim(p_data ->> 'qty')::numeric <= 0 then
      v_errors := v_errors || jsonb_build_object('field', 'qty',
        'message', 'quantity must be greater than zero');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'unit_cost', '')), '') is not null
       and btrim(p_data ->> 'unit_cost') !~ '^[0-9]+(\.[0-9]+)?$' then
      v_errors := v_errors || jsonb_build_object('field', 'unit_cost',
        'message', 'unit cost must be a non-negative number');
    end if;

  else
    raise exception 'unknown import kind %', p_kind using errcode = '22023';
  end if;

  return v_errors;
end;
$$;

-- The natural (idempotency) key a row is deduped on. Only opening stock has one: the same product
-- into the same warehouse must never be double-counted by a re-run. Products and customers are
-- deduped by their external key, so they return NULL here.
create or replace function app.import_natural_key(p_kind text, p_data jsonb)
returns text
language sql
immutable
as $$
  select case
    when p_kind = 'opening_stock' then
      'opening_stock:'
      || coalesce(nullif(btrim(coalesce(p_data ->> 'external_code', '')), ''),
                  nullif(btrim(coalesce(p_data ->> 'sku', '')), ''), '')
      || '@'
      || coalesce(nullif(btrim(coalesce(p_data ->> 'warehouse_code', '')), ''), 'default')
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- Bulk number allocation. A 5,000-row import needs 5,000 SKUs, and one locked
-- `SELECT ... FOR UPDATE` per row costs ~0.14 ms (700 ms for the file). This locks the series
-- ONCE and returns a contiguous, gapless block, which is the same guarantee `app.next_number`
-- gives, without the per-row round trip. It reads `number_series` directly, so it is for series
-- that are not carved into branch blocks (SKU, PO, ...); invoice numbers still go through
-- `app.next_number` -> `app.claim_invoice_number`.
-- ---------------------------------------------------------------------------
create or replace function app.next_numbers(p_org_id uuid, p_code text, p_count int)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.number_series%rowtype;
  v_start bigint;
  v_out   text[] := '{}';
  i       int;
begin
  if p_count is null or p_count < 0 then
    raise exception 'count must not be negative' using errcode = '23514';
  end if;
  if p_count = 0 then
    return v_out;
  end if;

  select * into v_row from public.number_series
   where org_id = p_org_id and code = p_code
   for update;
  if not found then
    raise exception 'number series % not found for org %', p_code, p_org_id
      using errcode = 'no_data_found';
  end if;

  v_start := v_row.next_value;
  for i in 0 .. p_count - 1 loop
    v_out := v_out || (v_row.prefix || lpad((v_start + i)::text, v_row.pad_width, '0')
                       || coalesce(v_row.suffix, ''));
  end loop;

  update public.number_series
     set next_value = v_start + p_count
   where org_id = p_org_id and code = p_code;

  return v_out;
end;
$$;

-- The retail price list an imported price lands in. Created on first use.
create or replace function app.ensure_retail_price_list(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.price_lists
   where org_id = p_org_id and kind = 'retail';
  if v_id is not null then
    return v_id;
  end if;

  insert into public.price_lists (org_id, name, kind)
  values (p_org_id, 'Retail', 'retail')
  on conflict (org_id, kind) do update set name = excluded.name
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Open a job.
-- ---------------------------------------------------------------------------
create or replace function app.import_job_create(
  p_org_id      uuid,
  p_branch_id   uuid,
  p_kind        text,
  p_source_name text default null,
  p_mapping     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;
  if p_kind not in ('products', 'customers', 'opening_stock') then
    raise exception 'unknown import kind %', p_kind using errcode = '22023';
  end if;

  insert into public.import_jobs (org_id, branch_id, kind, source_name, mapping)
  values (p_org_id, p_branch_id, p_kind, p_source_name, coalesce(p_mapping, '{}'::jsonb))
  returning id into v_id;

  return jsonb_build_object('job_id', v_id, 'status', 'draft', 'kind', p_kind);
end;
$$;

-- ---------------------------------------------------------------------------
-- Validate every staged row for a job. Set-based: one UPDATE computes each row's errors, status
-- and natural key. Rows already committed under the same natural key are marked `skipped`.
-- ---------------------------------------------------------------------------
create or replace function app.import_validate_job(
  p_org_id    uuid,
  p_branch_id uuid,
  p_job_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      public.import_jobs;
  v_total    int;
  v_invalid  int;
  v_skipped  int;
  v_status   text;
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;

  select * into v_job from public.import_jobs
   where id = p_job_id and org_id = p_org_id and branch_id = p_branch_id
   for update;
  if not found then
    raise exception 'import job % not found', p_job_id using errcode = 'no_data_found';
  end if;
  if v_job.status = 'committed' then
    raise exception 'import job % is already committed', p_job_id using errcode = '23514';
  end if;

  update public.import_rows r
     set errors = app.import_row_errors(v_job.kind, r.data),
         natural_key = app.import_natural_key(v_job.kind, r.data),
         status = case
           when app.import_natural_key(v_job.kind, r.data) is not null
                and exists (
                  select 1 from public.import_rows c
                   where c.org_id = r.org_id
                     and c.branch_id = r.branch_id
                     and c.status = 'committed'
                     and c.natural_key = app.import_natural_key(v_job.kind, r.data))
             then 'skipped'
           when jsonb_array_length(app.import_row_errors(v_job.kind, r.data)) = 0 then 'valid'
           else 'invalid'
         end
   where r.job_id = p_job_id
     and r.org_id = p_org_id
     and r.branch_id = p_branch_id;

  -- A row whose referenced product or warehouse does not exist cannot be committed; report it by
  -- row number like any other validation error, rather than failing at commit time.
  if v_job.kind = 'opening_stock' then
    update public.import_rows r
       set errors = r.errors || jsonb_build_object('field', 'product',
             'message', 'no product matches this external code or SKU'),
           status = 'invalid'
     where r.job_id = p_job_id
       and r.status = 'valid'
       and not exists (
         select 1 from public.products p
          where p.org_id = p_org_id
            and (p.external_code = nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
                 or p.sku = nullif(btrim(coalesce(r.data ->> 'sku', '')), '')));

    update public.import_rows r
       set errors = r.errors || jsonb_build_object('field', 'warehouse_code',
             'message', 'no warehouse matches this code'),
           status = 'invalid'
     where r.job_id = p_job_id
       and r.status = 'valid'
       and nullif(btrim(coalesce(r.data ->> 'warehouse_code', '')), '') is not null
       and not exists (
         select 1 from public.warehouses w
          where w.org_id = p_org_id
            and w.branch_id = p_branch_id
            and w.code = btrim(r.data ->> 'warehouse_code'));

    -- Two rows in the same file with the same natural key would double-count on commit. Report
    -- the second and later ones by row number rather than failing at commit time.
    update public.import_rows r
       set errors = r.errors || jsonb_build_object('field', 'qty',
             'message', 'duplicate product and warehouse within this file'),
           status = 'invalid'
     where r.job_id = p_job_id
       and r.status = 'valid'
       and exists (
         select 1 from public.import_rows earlier
          where earlier.job_id = r.job_id
            and earlier.status in ('valid', 'invalid')
            and earlier.natural_key = r.natural_key
            and earlier.row_no < r.row_no);
  end if;

  select count(*),
         count(*) filter (where status = 'invalid'),
         count(*) filter (where status = 'skipped')
    into v_total, v_invalid, v_skipped
    from public.import_rows
   where job_id = p_job_id;

  v_status := case when v_invalid > 0 then 'invalid' else 'validated' end;

  update public.import_jobs
     set status = v_status, total_rows = v_total, error_rows = v_invalid
   where id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id, 'status', v_status,
    'total_rows', v_total, 'invalid_rows', v_invalid, 'skipped_rows', v_skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fix one row's data and revalidate just that row. The caller revalidates the job afterwards.
-- ---------------------------------------------------------------------------
create or replace function app.import_update_row(
  p_org_id    uuid,
  p_branch_id uuid,
  p_row_id    uuid,
  p_data      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.import_rows;
  v_job public.import_jobs;
  v_errors jsonb;
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'row data must be a JSON object' using errcode = '22023';
  end if;

  select * into v_row from public.import_rows
   where id = p_row_id and org_id = p_org_id and branch_id = p_branch_id
   for update;
  if not found then
    raise exception 'import row % not found', p_row_id using errcode = 'no_data_found';
  end if;

  select * into v_job from public.import_jobs where id = v_row.job_id;
  if v_job.status = 'committed' then
    raise exception 'import job % is already committed', v_job.id using errcode = '23514';
  end if;

  v_errors := app.import_row_errors(v_job.kind, p_data);

  update public.import_rows
     set data = p_data,
         errors = v_errors,
         status = case when jsonb_array_length(v_errors) = 0 then 'valid' else 'invalid' end
   where id = p_row_id;

  return jsonb_build_object('row_id', p_row_id, 'row_no', v_row.row_no,
                            'status', case when jsonb_array_length(v_errors) = 0
                                           then 'valid' else 'invalid' end,
                            'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- Commit the whole job in one transaction. Any invalid row blocks it. A failure part-way through
-- (for example a SKU that collides with another row) rolls the whole job back, so no partial data
-- is left behind.
-- ---------------------------------------------------------------------------
create or replace function app.import_commit_job(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_job_id       uuid,
  p_posting_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job       public.import_jobs;
  v_invalid   int;
  v_created   int := 0;
  v_updated   int := 0;
  v_skipped   int := 0;
  v_committed int := 0;
  v_journal   uuid;
  v_total     numeric(19, 4) := 0;
  v_price_list uuid;
  v_date      date := coalesce(p_posting_date, current_date);
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;

  select * into v_job from public.import_jobs
   where id = p_job_id and org_id = p_org_id and branch_id = p_branch_id
   for update;
  if not found then
    raise exception 'import job % not found', p_job_id using errcode = 'no_data_found';
  end if;
  if v_job.status = 'committed' then
    raise exception 'import job % is already committed', p_job_id using errcode = '23514';
  end if;

  select count(*) into v_invalid from public.import_rows
   where job_id = p_job_id and status = 'invalid';
  if v_invalid > 0 then
    raise exception 'import job % has % invalid rows; fix them and revalidate before committing',
      p_job_id, v_invalid using errcode = '23514';
  end if;

  select count(*) into v_skipped from public.import_rows
   where job_id = p_job_id and status = 'skipped';

  if v_job.kind = 'products' then
    v_price_list := app.ensure_retail_price_list(p_org_id);

    -- Resolve the mapped rows ONCE. The temp table is materialised, so the JSON is parsed once and
    -- the product upsert, the variants and the prices all read the same set. It is dropped at
    -- commit; the drops below make a second call in the same transaction safe.
    drop table if exists import_src;
    create temporary table import_src on commit drop as
      select r.id as row_id,
             nullif(btrim(coalesce(r.data ->> 'external_code', '')), '') as external_code,
             nullif(btrim(coalesce(r.data ->> 'sku', '')), '') as sku,
             btrim(coalesce(r.data ->> 'name', '')) as name,
             lower(btrim(coalesce(r.data ->> 'unit', 'each')))::public.product_unit as unit,
             nullif(btrim(coalesce(r.data ->> 'price', '')), '')::numeric(19, 4) as price,
             nullif(btrim(coalesce(r.data ->> 'barcode', '')), '') as barcode
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid';

    -- Hand out one SKU per row that did not supply one, from a single locked block.
    alter table import_src add column generated_sku text;
    with need as (
      select row_id, row_number() over (order by row_id) as rn
        from import_src where sku is null
    ),
    nums as (
      select row_number() over () as rn, sku
        from unnest(app.next_numbers(
               p_org_id, 'SKU',
               (select count(*)::int from import_src where sku is null))) as sku
    )
    update import_src s
       set generated_sku = nums.sku
      from need join nums on nums.rn = need.rn
     where s.row_id = need.row_id;

    -- Upsert the product by its external key, so a re-run updates rather than duplicates.
    drop table if exists import_products;
    create temporary table import_products on commit drop as
      with up as (
        insert into public.products (org_id, sku, name, unit, is_weighable, external_code)
        select p_org_id,
               coalesce(s.sku, s.generated_sku),
               s.name,
               s.unit,
               s.unit in ('kg', 'g', 'l', 'ml'),
               s.external_code
          from import_src s
        on conflict (org_id, external_code) do update
           set name = excluded.name,
               unit = excluded.unit,
               is_weighable = excluded.is_weighable,
               updated_at = now()
        returning id, external_code, sku, name, (xmax = 0) as inserted
      )
      select * from up;

    select count(*) filter (where inserted), count(*) filter (where not inserted)
      into v_created, v_updated
      from import_products;

    create index on import_products (external_code);

    -- One default variant per product, so an imported product is sellable at the till.
    insert into public.product_variants (org_id, product_id, sku, name, barcode)
    select p_org_id, p.id, p.sku, p.name, s.barcode
      from import_products p
      join import_src s on s.external_code = p.external_code
    on conflict (org_id, sku) do update
       set name = excluded.name, barcode = excluded.barcode, updated_at = now();

    -- The price lands in the org's retail price list.
    insert into public.price_list_items (org_id, price_list_id, variant_id, price)
    select p_org_id, v_price_list, v.id, s.price
      from import_src s
      join import_products p on p.external_code = s.external_code
      join public.product_variants v on v.org_id = p_org_id and v.product_id = p.id
     where s.price is not null
    on conflict (price_list_id, variant_id) do update
       set price = excluded.price, updated_at = now();

  elsif v_job.kind = 'customers' then
    with up as (
      insert into public.contacts (org_id, kind, name, email, phone, external_code)
      select p_org_id,
             coalesce(nullif(lower(btrim(coalesce(r.data ->> 'kind', ''))), ''), 'customer'),
             btrim(coalesce(r.data ->> 'name', '')),
             nullif(btrim(coalesce(r.data ->> 'email', '')), ''),
             nullif(btrim(coalesce(r.data ->> 'phone', '')), ''),
             nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid'
      on conflict (org_id, external_code) do update
         set name = excluded.name, email = excluded.email, phone = excluded.phone,
             updated_at = now()
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted)
      into v_created, v_updated
      from up;

  elsif v_job.kind = 'opening_stock' then
    -- Resolve the product and warehouse ONCE into a materialised temp table. The lookup is a
    -- plain equality on an indexed column (external_code, then sku), never an OR across two
    -- columns, so a 1,200-row file does not degrade to a nested loop over every product.
    drop table if exists import_open;
    create temporary table import_open on commit drop as
      select r.id as row_id,
             coalesce(
               (select p.id from public.products p
                 where p.org_id = p_org_id
                   and p.external_code = nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
                 limit 1),
               (select p.id from public.products p
                 where p.org_id = p_org_id
                   and p.sku = nullif(btrim(coalesce(r.data ->> 'sku', '')), '')
                 limit 1)) as product_id,
             -- Stock is tracked per variant, so an opening layer must name one. Prefer the
             -- variant the row's barcode names; otherwise the product's earliest variant, which
             -- is the one the products import created as its default.
             coalesce(
               (select v.id from public.product_variants v
                 where v.org_id = p_org_id
                   and v.barcode = nullif(btrim(coalesce(r.data ->> 'barcode', '')), '')
                 limit 1),
               (select v.id from public.product_variants v
                 where v.org_id = p_org_id
                   and v.product_id = coalesce(
                     (select p.id from public.products p
                       where p.org_id = p_org_id
                         and p.external_code = nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
                       limit 1),
                     (select p.id from public.products p
                       where p.org_id = p_org_id
                         and p.sku = nullif(btrim(coalesce(r.data ->> 'sku', '')), '')
                       limit 1))
                 order by v.created_at, v.id
                 limit 1)) as variant_id,
             coalesce(
               (select w.id from public.warehouses w
                 where w.org_id = p_org_id and w.branch_id = p_branch_id
                   and w.code = nullif(btrim(coalesce(r.data ->> 'warehouse_code', '')), '')),
               (select w.id from public.warehouses w
                 where w.org_id = p_org_id and w.branch_id = p_branch_id and w.is_active
                 order by w.created_at, w.id limit 1)) as warehouse_id,
             (r.data ->> 'qty')::numeric(19, 4) as qty,
             coalesce(nullif(btrim(coalesce(r.data ->> 'unit_cost', '')), '')::numeric(19, 4), 0)
               as unit_cost
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid';

    create temporary table import_ins on commit drop as
      with ins as (
        insert into public.stock_ledger
          (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
           source_type, source_id, memo, created_at)
        select gen_random_uuid(), p_org_id, p_branch_id, x.warehouse_id, x.product_id, x.variant_id,
               'in', x.qty, x.unit_cost, 'opening', p_job_id, 'Opening stock import', now()
          from import_open x
        returning id, created_at, warehouse_id, product_id, variant_id, qty, unit_cost
      )
      select * from ins;

    insert into public.stock_layer_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id,
       in_ledger_created_at, unit_cost, qty_remaining)
    select p_org_id, p_branch_id, i.warehouse_id, i.product_id, i.variant_id, i.id, i.created_at,
           i.unit_cost, i.qty
      from import_ins i;

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    select p_org_id, p_branch_id, i.warehouse_id, i.product_id, i.variant_id,
           sum(i.qty), sum(round(i.qty * i.unit_cost, 4))
      from import_ins i
     group by i.warehouse_id, i.product_id, i.variant_id
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
       set qty = public.stock_balances.qty + excluded.qty,
           value = public.stock_balances.value + excluded.value,
           updated_at = now();

    select coalesce(sum(round(i.qty * i.unit_cost, 4)), 0)
      into v_total
      from import_ins i;

    select count(*) into v_created from public.import_rows
     where job_id = p_job_id and status = 'valid';

    -- One balanced journal for the whole opening stock, through the balanced-journal hook.
    if v_total > 0 then
      v_journal := app.post_balanced_journal(
        p_org_id, p_branch_id, v_date, 'opening', p_job_id, 'Opening stock import', 'USD',
        jsonb_build_array(
          jsonb_build_object('account_code', '1000', 'debit', v_total,
                             'description', 'Opening stock'),
          jsonb_build_object('account_code', '3900', 'credit', v_total,
                             'description', 'Opening balance equity')));
    end if;

  else
    raise exception 'unknown import kind %', v_job.kind using errcode = '22023';
  end if;

  update public.import_rows
     set status = 'committed'
   where job_id = p_job_id and status = 'valid';
  get diagnostics v_committed = row_count;

  update public.import_jobs
     set status = 'committed',
         committed_at = now(),
         result = jsonb_build_object(
           'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
           'committed_rows', v_committed, 'journal_id', v_journal,
           'total_value', v_total)
   where id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id, 'status', 'committed', 'kind', v_job.kind,
    'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
    'committed_rows', v_committed, 'journal_id', v_journal,
    'total_value', v_total::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- The UI read: a keyset page of rows and their errors, ordered by row number.
-- ---------------------------------------------------------------------------
create or replace function app.import_job_rows(
  p_org_id      uuid,
  p_branch_id   uuid,
  p_job_id      uuid,
  p_limit       int default 50,
  p_after_row_no int default 0
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
  v_next  int;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_id', x.id, 'row_no', x.row_no, 'status', x.status,
           'data', x.data, 'errors', x.errors) order by x.row_no), '[]'::jsonb),
         max(x.row_no)
    into v_rows, v_next
    from (
      select r.id, r.row_no, r.status, r.data, r.errors
        from public.import_rows r
       where r.job_id = p_job_id
         and r.org_id = p_org_id
         and r.branch_id = p_branch_id
         and r.row_no > coalesce(p_after_row_no, 0)
       order by r.row_no
       limit v_limit
    ) x;

  return jsonb_build_object(
    'job_id', p_job_id,
    'rows', v_rows,
    'next_after_row_no', case when jsonb_array_length(v_rows) = v_limit then v_next else null end);
end;
$$;

-- The saved column mapping for a shop.
create or replace function app.import_save_mapping(
  p_org_id    uuid,
  p_branch_id uuid,
  p_kind      text,
  p_mapping   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;
  if p_kind not in ('products', 'customers', 'opening_stock') then
    raise exception 'unknown import kind %', p_kind using errcode = '22023';
  end if;
  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' then
    raise exception 'mapping must be a JSON object' using errcode = '22023';
  end if;

  insert into public.import_mappings (org_id, branch_id, kind, mapping)
  values (p_org_id, p_branch_id, p_kind, p_mapping)
  on conflict (org_id, branch_id, kind) do update
     set mapping = excluded.mapping, updated_at = now();

  return p_mapping;
end;
$$;

create or replace function app.import_get_mapping(
  p_org_id    uuid,
  p_branch_id uuid,
  p_kind      text
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (select m.mapping from public.import_mappings m
      where m.org_id = p_org_id and m.branch_id = p_branch_id and m.kind = p_kind),
    '{}'::jsonb);
$$;

-- RLS and grants.
select app.apply_tenant_rls('public.import_jobs', 'branch');
select app.apply_tenant_rls('public.import_rows', 'branch');
select app.apply_tenant_rls('public.import_mappings', 'branch');

grant execute on function app.next_numbers(uuid, text, int) to authenticated, service_role;
grant execute on function app.import_row_errors(text, jsonb) to authenticated, service_role;
grant execute on function app.import_natural_key(text, jsonb) to authenticated, service_role;
grant execute on function app.ensure_retail_price_list(uuid) to authenticated, service_role;
grant execute on function app.import_job_create(uuid, uuid, text, text, jsonb)
  to authenticated, service_role;
grant execute on function app.import_validate_job(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.import_update_row(uuid, uuid, uuid, jsonb)
  to authenticated, service_role;
grant execute on function app.import_commit_job(uuid, uuid, uuid, date) to authenticated, service_role;
grant execute on function app.import_job_rows(uuid, uuid, uuid, int, int)
  to authenticated, service_role;
grant execute on function app.import_save_mapping(uuid, uuid, text, jsonb)
  to authenticated, service_role;
grant execute on function app.import_get_mapping(uuid, uuid, text) to authenticated, service_role;
