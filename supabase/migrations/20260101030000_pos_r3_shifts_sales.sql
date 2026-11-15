-- R3: Online POS sale (Retail vertical).
--
-- Additive only. Nothing here rewrites a core migration or a core accounting path. A POS sale is
-- a CORE invoice plus CORE payments in one transaction: app.post_pos_sale calls app.create_invoice
-- (gapless number, sorted stock locks, FIFO consumption, balanced journal) and then
-- app.allocate_payment once per tender. The deferred balance trigger still verifies the journal at
-- commit, so the ledger balances or the whole sale rolls back.
--
-- Adds:
--   * public.shifts         (branch-scoped; a cashier session at a till)
--   * public.pos_sales      (branch-scoped; PARTITIONED monthly on created_at; PK (id, created_at))
--   * public.pos_payments   (branch-scoped; one row per tender)
--   * public.pos_sale_keys  (org-scoped; the idempotency claim for client_sale_id — see ADR-0014)
--
-- ADR-0014: Postgres requires every unique constraint on a partitioned table to include the
-- partition key, so `unique (org_id, client_sale_id)` cannot be declared on pos_sales. It is
-- enforced instead on the small non-partitioned pos_sale_keys table, which post_pos_sale writes
-- first inside the same transaction. That gives the same exactly-once guarantee.

-- ---------------------------------------------------------------------------
-- Shifts. A cashier opens a till with an opening float and closes it later. Indexed by
-- (org_id, branch_id, till_id, opened_at desc) as the brief requires.
-- ---------------------------------------------------------------------------
create table public.shifts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  till_id       text not null,
  status        text not null default 'open',
  opening_float numeric(19, 4) not null default 0,
  opened_at     timestamptz not null default now(),
  opened_by     uuid,
  closed_at     timestamptz,
  closed_by     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint shifts_status_check check (status in ('open', 'closed')),
  constraint shifts_float_check check (opening_float >= 0),
  constraint shifts_closed_pair_check check ((closed_at is null) = (closed_by is null)),
  constraint shifts_open_has_no_close_check check (status <> 'open' or closed_at is null)
);

create index shifts_org_branch_till_opened_idx
  on public.shifts (org_id, branch_id, till_id, opened_at desc);
create index shifts_org_branch_created_idx
  on public.shifts (org_id, branch_id, created_at desc, id desc);
create index shifts_org_created_idx on public.shifts (org_id, created_at desc, id desc);
create index shifts_branch_id_idx on public.shifts (branch_id);
create index shifts_org_id_idx on public.shifts (org_id);

-- ---------------------------------------------------------------------------
-- POS sales. PARTITIONED monthly on created_at, so the primary key includes created_at (the same
-- rule the core ledger tables follow). One row per completed sale; it points at the CORE invoice
-- that carries the accounting.
-- ---------------------------------------------------------------------------
create table public.pos_sales (
  id               uuid not null default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  branch_id        uuid not null references public.branches (id) on delete restrict,
  shift_id         uuid references public.shifts (id) on delete restrict,
  invoice_id       uuid not null references public.invoices (id) on delete restrict,
  client_sale_id   uuid not null,
  status           text not null default 'completed',
  cashier_id       uuid,
  created_at       timestamptz not null default now(),
  primary key (id, created_at),
  constraint pos_sales_status_check check (status in ('completed', 'voided'))
) partition by range (created_at);

create index pos_sales_org_branch_created_idx
  on public.pos_sales (org_id, branch_id, created_at desc, id desc);
create index pos_sales_org_branch_shift_idx on public.pos_sales (org_id, branch_id, shift_id);
create index pos_sales_org_id_idx on public.pos_sales (org_id);
create index pos_sales_branch_id_idx on public.pos_sales (branch_id);
create index pos_sales_shift_id_idx on public.pos_sales (shift_id);
create index pos_sales_invoice_id_idx on public.pos_sales (invoice_id);
create index pos_sales_cashier_id_idx on public.pos_sales (cashier_id);

-- ---------------------------------------------------------------------------
-- POS payments: one row per tender. A sale may take USD and ZWG together, in which case each
-- tender gets its own row here and its own CORE payment (Dr Bank, Cr AR).
--
--   amount_tendered / amount_applied / change_given are in `currency`.
--   rate is the effective rate used for that tender (1 for the base currency).
--   base_amount is amount_applied converted to base currency (USD), which is what was allocated.
-- ---------------------------------------------------------------------------
create table public.pos_payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  branch_id        uuid not null references public.branches (id) on delete restrict,
  sale_id          uuid not null,
  sale_created_at  timestamptz not null,
  method           text not null,
  currency         text not null,
  amount_tendered  numeric(19, 4) not null,
  amount_applied   numeric(19, 4) not null,
  rate             numeric(19, 10) not null default 1,
  base_amount      numeric(19, 4) not null,
  change_given     numeric(19, 4) not null default 0,
  created_at       timestamptz not null default now(),
  constraint pos_payments_method_check
    check (method in ('cash', 'card', 'mobile', 'voucher')),
  constraint pos_payments_currency_check check (currency in ('USD', 'ZWG')),
  constraint pos_payments_amounts_check
    check (amount_tendered > 0 and amount_applied > 0 and base_amount > 0 and change_given >= 0),
  constraint pos_payments_sale_fkey
    foreign key (sale_id, sale_created_at)
    references public.pos_sales (id, created_at) on delete restrict
);

create index pos_payments_org_branch_created_idx
  on public.pos_payments (org_id, branch_id, created_at desc, id desc);
create index pos_payments_sale_idx on public.pos_payments (sale_id, sale_created_at);
create index pos_payments_org_id_idx on public.pos_payments (org_id);
create index pos_payments_branch_id_idx on public.pos_payments (branch_id);

-- ---------------------------------------------------------------------------
-- The idempotency claim for a client-supplied sale id (ADR-0014). Not partitioned, so the unique
-- constraint the brief asks for can exist. post_pos_sale inserts here first: a duplicate
-- client_sale_id raises a unique violation and the retry returns the original sale.
-- ---------------------------------------------------------------------------
create table public.pos_sale_keys (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  client_sale_id uuid not null,
  sale_id        uuid,
  created_at     timestamptz not null default now(),
  constraint pos_sale_keys_org_client_key unique (org_id, client_sale_id)
);

create index pos_sale_keys_org_created_idx
  on public.pos_sale_keys (org_id, created_at desc, id desc);
create index pos_sale_keys_org_id_idx on public.pos_sale_keys (org_id);

-- ---------------------------------------------------------------------------
-- RLS. shifts, pos_sales and pos_payments are branch-scoped; pos_sale_keys is org-scoped.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.shifts', 'branch');
select app.apply_tenant_rls('public.pos_sales', 'branch');
select app.apply_tenant_rls('public.pos_payments', 'branch');
select app.apply_tenant_rls('public.pos_sale_keys', 'org');

create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Open a shift. One open shift per till at a time.
-- ---------------------------------------------------------------------------
create or replace function app.open_shift(
  p_org_id        uuid,
  p_branch_id     uuid,
  p_till_id       text,
  p_opening_float numeric default 0,
  p_opened_by     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_till_id is null or btrim(p_till_id) = '' then
    raise exception 'open_shift requires a till id' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.shifts s
     where s.org_id = p_org_id
       and s.branch_id = p_branch_id
       and s.till_id = p_till_id
       and s.status = 'open'
  ) then
    raise exception 'till % already has an open shift', p_till_id using errcode = '23514';
  end if;

  insert into public.shifts
    (org_id, branch_id, till_id, opening_float, opened_by)
  values
    (p_org_id, p_branch_id, p_till_id, coalesce(p_opening_float, 0),
     coalesce(p_opened_by, auth.uid()))
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Close a shift.
-- ---------------------------------------------------------------------------
create or replace function app.close_shift(
  p_org_id  uuid,
  p_shift_id uuid,
  p_closed_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.shifts
     set status    = 'closed',
         closed_at = now(),
         closed_by = coalesce(p_closed_by, auth.uid())
   where id = p_shift_id
     and org_id = p_org_id
     and status = 'open';

  if not found then
    raise exception 'shift % is not open for org %', p_shift_id, p_org_id
      using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The POS sale: one CORE invoice + one CORE payment per tender + the POS rows, in one
-- transaction. Everything below happens inside the caller's transaction, so a failure anywhere
-- (including the deferred balance check at commit) leaves no partial rows.
--
--   p_lines:   jsonb array of { barcode | (product_id, variant_id), qty, unit_price? }
--   p_tenders: jsonb array of { method, currency, amount_tendered }
--
-- Returns { sale_id, invoice_id, invoice_no, subtotal, tax_total, total, change_total,
--           lines: [...], payments: [...] }.
-- ---------------------------------------------------------------------------
create or replace function app.post_pos_sale(
  p_org_id        uuid,
  p_branch_id     uuid,
  p_warehouse_id  uuid,
  p_shift_id      uuid,
  p_client_sale_id uuid,
  p_lines         jsonb,
  p_tenders       jsonb,
  p_contact_id    uuid default null,
  p_sale_date     date default null,
  p_cashier_id    uuid default null,
  p_tax_code      text default 'VAT15'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_date     date := coalesce(p_sale_date, current_date);
  v_created_at    timestamptz := clock_timestamp();
  v_claim_id      uuid;
  v_existing_sale uuid;
  v_sale_id       uuid := gen_random_uuid();
  v_invoice       jsonb;
  v_invoice_id    uuid;
  v_invoice_no    text;
  v_total         numeric(19, 4);
  v_line          jsonb;
  v_variant_id    uuid;
  v_product_id    uuid;
  v_qty           numeric(19, 4);
  v_unit_price    numeric(19, 4);
  v_inv_lines     jsonb := '[]'::jsonb;
  v_remaining     numeric(19, 4);
  v_tender        jsonb;
  v_tender_count  int;
  v_tender_no     int := 0;
  v_method        text;
  v_currency      text;
  v_rate          numeric(19, 10);
  v_tendered      numeric(19, 4);
  v_tendered_base numeric(19, 4);
  v_applied_base  numeric(19, 4);
  v_applied_ccy   numeric(19, 4);
  v_change_ccy    numeric(19, 4);
  v_change_total  numeric(19, 4) := 0;
  v_payments      jsonb := '[]'::jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'post_pos_sale requires at least one line' using errcode = '23514';
  end if;
  if p_tenders is null or jsonb_typeof(p_tenders) <> 'array' or jsonb_array_length(p_tenders) = 0 then
    raise exception 'post_pos_sale requires at least one tender' using errcode = '23514';
  end if;
  if p_client_sale_id is null then
    raise exception 'post_pos_sale requires a client_sale_id' using errcode = '23514';
  end if;

  -- Idempotency claim first. A retried client_sale_id hits the unique constraint; return the
  -- original sale instead of ringing a second one.
  insert into public.pos_sale_keys (org_id, client_sale_id)
  values (p_org_id, p_client_sale_id)
  on conflict (org_id, client_sale_id) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    select k.sale_id into v_existing_sale
      from public.pos_sale_keys k
     where k.org_id = p_org_id and k.client_sale_id = p_client_sale_id;

    if v_existing_sale is null then
      raise exception 'sale for client_sale_id % is still in flight', p_client_sale_id
        using errcode = '40001';
    end if;

    return app.pos_sale_receipt(v_existing_sale);
  end if;

  -- Resolve every line to a CORE invoice line, pricing by barcode through the R2 pricing
  -- functions when no explicit unit price is supplied.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'sale line quantity must be positive' using errcode = '23514';
    end if;

    if v_line ? 'variant_id' and (v_line ->> 'variant_id') is not null then
      v_variant_id := (v_line ->> 'variant_id')::uuid;
      select pv.product_id into v_product_id
        from public.product_variants pv
       where pv.id = v_variant_id and pv.org_id = p_org_id;
    else
      select pv.id, pv.product_id into v_variant_id, v_product_id
        from public.product_variants pv
       where pv.org_id = p_org_id
         and pv.barcode = (v_line ->> 'barcode')
       limit 1;
    end if;

    if v_variant_id is null or v_product_id is null then
      raise exception 'no product variant for barcode %', v_line ->> 'barcode'
        using errcode = 'no_data_found';
    end if;

    if v_line ? 'unit_price' and (v_line ->> 'unit_price') is not null then
      v_unit_price := (v_line ->> 'unit_price')::numeric;
    else
      select pr.unit_price into v_unit_price
        from app.get_price(p_org_id, v_variant_id, null, v_created_at, v_qty) as pr;
    end if;

    if v_unit_price is null then
      raise exception 'no price for variant %: pass unit_price or set a price list entry',
        v_variant_id using errcode = 'no_data_found';
    end if;

    v_inv_lines := v_inv_lines || jsonb_build_object(
      'product_id', v_product_id,
      'variant_id', v_variant_id,
      'warehouse_id', p_warehouse_id,
      'qty', v_qty,
      'unit_price', v_unit_price,
      'tax_rate_code', p_tax_code
    );
  end loop;

  -- The CORE invoice: gapless number, sorted stock locks, FIFO consumption, balanced journal.
  v_invoice := app.create_invoice(
    p_org_id, p_branch_id, p_contact_id, v_sale_date, v_inv_lines, 'USD', null
  );
  v_invoice_id := (v_invoice ->> 'invoice_id')::uuid;
  v_invoice_no := v_invoice ->> 'invoice_no';
  v_total      := (v_invoice ->> 'total')::numeric;

  insert into public.pos_sales
    (id, org_id, branch_id, shift_id, invoice_id, client_sale_id, status, cashier_id, created_at)
  values
    (v_sale_id, p_org_id, p_branch_id, p_shift_id, v_invoice_id, p_client_sale_id, 'completed',
     coalesce(p_cashier_id, auth.uid()), v_created_at);

  update public.pos_sale_keys set sale_id = v_sale_id where id = v_claim_id;

  -- One CORE payment per tender, applied in order and capped at the open balance. The last tender
  -- covers the remainder; anything beyond it is change in that tender's currency.
  v_remaining := v_total;
  v_tender_count := jsonb_array_length(p_tenders);

  for v_tender in select * from jsonb_array_elements(p_tenders)
  loop
    v_tender_no := v_tender_no + 1;
    v_method   := coalesce(v_tender ->> 'method', 'cash');
    v_currency := coalesce(v_tender ->> 'currency', 'USD');
    v_tendered := (v_tender ->> 'amount_tendered')::numeric;

    if v_tendered is null or v_tendered <= 0 then
      raise exception 'tender % amount must be positive', v_tender_no using errcode = '23514';
    end if;
    if v_remaining <= 0 and v_tender_no > 1 then
      raise exception 'tender % is not needed: the sale is already covered', v_tender_no
        using errcode = '23514';
    end if;

    v_rate := app.rate_on(p_org_id, v_currency, v_sale_date);
    if v_rate is null then
      raise exception 'no exchange rate for % effective on %', v_currency, v_sale_date
        using errcode = 'no_data_found';
    end if;

    v_tendered_base := round(v_tendered * v_rate, 4);

    -- The last tender takes whatever is left, even if it over-tenders (that is change).
    if v_tender_no = v_tender_count then
      v_applied_base := v_remaining;
    else
      v_applied_base := least(v_tendered_base, v_remaining);
    end if;

    if v_applied_base <= 0 then
      raise exception 'tender % applies nothing to the sale', v_tender_no using errcode = '23514';
    end if;

    v_applied_ccy := round(v_applied_base / v_rate, 4);
    v_change_ccy  := round(v_tendered - v_applied_ccy, 4);
    if v_change_ccy < 0 then
      v_change_ccy := 0;
    end if;

    -- CORE payment: Dr Bank, Cr AR, capped at the open balance.
    perform app.allocate_payment(
      p_org_id, p_branch_id, v_invoice_id, v_applied_base, v_sale_date, v_method, p_contact_id
    );

    insert into public.pos_payments
      (org_id, branch_id, sale_id, sale_created_at, method, currency, amount_tendered,
       amount_applied, rate, base_amount, change_given, created_at)
    values
      (p_org_id, p_branch_id, v_sale_id, v_created_at, v_method, v_currency, v_tendered,
       v_applied_ccy, v_rate, v_applied_base, v_change_ccy, v_created_at);

    v_payments := v_payments || jsonb_build_object(
      'method', v_method,
      'currency', v_currency,
      'amount_tendered', v_tendered,
      'amount_applied', v_applied_ccy,
      'rate', v_rate,
      'base_amount', v_applied_base,
      'change_given', v_change_ccy
    );

    v_change_total := v_change_total + v_change_ccy;
    v_remaining := v_remaining - v_applied_base;
  end loop;

  if v_remaining > 0 then
    raise exception 'the tenders leave % of the sale unpaid', v_remaining using errcode = '23514';
  end if;

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'invoice_id', v_invoice_id,
    'invoice_no', v_invoice_no,
    'subtotal', (v_invoice ->> 'subtotal')::numeric,
    'tax_total', (v_invoice ->> 'tax_total')::numeric,
    'total', v_total,
    'change_total', v_change_total,
    'currency', 'USD',
    'lines', coalesce(
      (select jsonb_agg(jsonb_build_object(
                'line_no', il.line_no,
                'description', il.description,
                'qty', il.qty,
                'unit_price', il.unit_price,
                'line_subtotal', il.line_subtotal,
                'line_tax', il.line_tax,
                'line_total', il.line_total,
                'tax_rate', il.tax_rate
              ) order by il.line_no)
         from public.invoice_lines il
        where il.invoice_id = v_invoice_id),
      '[]'::jsonb),
    'payments', v_payments
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Read back a receipt for an existing sale. Used by the idempotent retry path so a repeated
-- client_sale_id returns the original receipt rather than an error.
-- ---------------------------------------------------------------------------
create or replace function app.pos_sale_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale      public.pos_sales%rowtype;
  v_invoice   public.invoices%rowtype;
  v_payments  jsonb;
  v_lines     jsonb;
  v_change    numeric(19, 4);
begin
  select * into v_sale from public.pos_sales where id = p_sale_id;
  if not found then
    raise exception 'pos sale % not found', p_sale_id using errcode = 'no_data_found';
  end if;

  select * into v_invoice from public.invoices where id = v_sale.invoice_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'method', pp.method,
           'currency', pp.currency,
           'amount_tendered', pp.amount_tendered,
           'amount_applied', pp.amount_applied,
           'rate', pp.rate,
           'base_amount', pp.base_amount,
           'change_given', pp.change_given
         ) order by pp.created_at, pp.id), '[]'::jsonb),
         coalesce(sum(pp.change_given), 0)
    into v_payments, v_change
    from public.pos_payments pp
   where pp.sale_id = p_sale_id
     and pp.sale_created_at = v_sale.created_at;

  select coalesce(jsonb_agg(jsonb_build_object(
           'line_no', il.line_no,
           'description', il.description,
           'qty', il.qty,
           'unit_price', il.unit_price,
           'line_subtotal', il.line_subtotal,
           'line_tax', il.line_tax,
           'line_total', il.line_total,
           'tax_rate', il.tax_rate
         ) order by il.line_no), '[]'::jsonb)
    into v_lines
    from public.invoice_lines il
   where il.invoice_id = v_sale.invoice_id;

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'invoice_id', v_sale.invoice_id,
    'invoice_no', v_invoice.invoice_no,
    'subtotal', v_invoice.subtotal,
    'tax_total', v_invoice.tax_total,
    'total', v_invoice.total,
    'change_total', v_change,
    'currency', v_invoice.currency,
    'lines', v_lines,
    'payments', v_payments
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Keyset page over a shift's sales, for the till's "recent sales" list. Default 50, maximum 100,
-- never OFFSET. Explicit column list.
-- ---------------------------------------------------------------------------
create or replace function app.list_pos_sales(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_shift_id         uuid default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns setof public.pos_sales
language plpgsql
stable
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select s.id, s.org_id, s.branch_id, s.shift_id, s.invoice_id, s.client_sale_id, s.status,
         s.cashier_id, s.created_at
    from public.pos_sales s
   where s.org_id = p_org_id
     and s.branch_id = p_branch_id
     and (p_shift_id is null or s.shift_id = p_shift_id)
     and (
       p_after_created_at is null
       or (s.created_at, s.id) < (p_after_created_at, p_after_id)
     )
   order by s.created_at desc, s.id desc
   limit v_limit;
end;
$$;

grant execute on function app.open_shift(uuid, uuid, text, numeric, uuid)
  to authenticated, service_role;
grant execute on function app.close_shift(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.post_pos_sale(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, date, uuid, text)
  to authenticated, service_role;
grant execute on function app.pos_sale_receipt(uuid) to authenticated, service_role;
grant execute on function app.list_pos_sales(uuid, uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;

-- Partitions for the current month and the next two months.
select app.ensure_partitions(2);
