-- R4: Offline outbox and sync (Retail vertical).
--
-- Additive only. Nothing here edits an applied migration. This file:
--   * adds public.pos_sync_exceptions (branch-scoped; where a synced sale that could not post
--     strictly is recorded instead of being refused — see ADR-0016);
--   * adds app.negative_stock_allowed(), the transaction-local allow-negative hook (ADR-0015);
--   * re-creates app.consume_fifo and app.create_invoice verbatim, changing only the availability
--     guard so the hook can admit a backlog sale without flipping the warehouse setting;
--   * adds app.sync_pos_sale, the per-sale sync entry point that never rejects a completed sale.
--
-- Re-creating a function in a later migration is additive: the applied migration is untouched and
-- the newest definition wins for every later caller (AGENTS.md).

-- ---------------------------------------------------------------------------
-- Where a synced sale that could not post under the strict rules is recorded. Branch-scoped:
-- client_sale_id identifies the offline sale, kind says what went wrong, detail carries the
-- evidence. The brief's index (org_id, branch_id, created_at desc, id desc) is created below.
-- ---------------------------------------------------------------------------
create table public.pos_sync_exceptions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  branch_id      uuid not null references public.branches (id) on delete restrict,
  client_sale_id uuid not null,
  kind           text not null,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint pos_sync_exceptions_kind_check
    check (kind in ('negative_stock', 'price_variance', 'promotion_expired', 'rejected')),
  constraint pos_sync_exceptions_detail_check check (jsonb_typeof(detail) = 'object')
);

create index pos_sync_exceptions_org_branch_created_idx
  on public.pos_sync_exceptions (org_id, branch_id, created_at desc, id desc);
create index pos_sync_exceptions_org_created_idx
  on public.pos_sync_exceptions (org_id, created_at desc, id desc);
create index pos_sync_exceptions_org_id_idx on public.pos_sync_exceptions (org_id);
create index pos_sync_exceptions_branch_id_idx on public.pos_sync_exceptions (branch_id);
create index pos_sync_exceptions_client_sale_idx on public.pos_sync_exceptions (client_sale_id);

select app.apply_tenant_rls('public.pos_sync_exceptions', 'branch');

-- ---------------------------------------------------------------------------
-- The allow-negative hook (ADR-0015). A transaction-local GUC, set only by the sync retry, that
-- lets app.create_invoice and app.consume_fifo admit a movement the strict rules would refuse.
-- Transaction-local (set_config(..., true)) means it cannot leak to another request on the same
-- pooled connection, and the live-sale path never sets it.
-- ---------------------------------------------------------------------------
create or replace function app.negative_stock_allowed()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.allow_negative_stock', true), 'off')
           in ('on', 'true', '1', 'yes');
$$;

grant execute on function app.negative_stock_allowed() to authenticated, service_role;


create or replace function app.consume_fifo(
  p_org_id          uuid,
  p_branch_id       uuid,
  p_warehouse_id    uuid,
  p_product_id      uuid,
  p_variant_id      uuid,
  p_qty             numeric,
  p_out_ledger_id   uuid,
  p_out_created_at  timestamptz
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_layer      record;
  v_remaining  numeric(19, 4) := p_qty;
  v_take       numeric(19, 4);
  v_cost       numeric(19, 4) := 0;
  v_last_cost  numeric(19, 4) := 0;
  v_allow_neg  boolean;
begin
  for v_layer in
    select slb.in_ledger_id, slb.in_ledger_created_at, slb.unit_cost, slb.qty_remaining
      from public.stock_layer_balances slb
     where slb.org_id = p_org_id
       and slb.warehouse_id = p_warehouse_id
       and slb.product_id = p_product_id
       and slb.variant_id is not distinct from p_variant_id
       and slb.qty_remaining > 0
     order by slb.in_ledger_created_at, slb.in_ledger_id
       for update
  loop
    exit when v_remaining <= 0;

    v_take := least(v_layer.qty_remaining, v_remaining);

    insert into public.stock_consumptions
      (org_id, branch_id, warehouse_id, product_id, variant_id,
       out_ledger_id, out_ledger_created_at, in_ledger_id, in_ledger_created_at, qty, unit_cost)
    values
      (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id,
       p_out_ledger_id, p_out_created_at, v_layer.in_ledger_id, v_layer.in_ledger_created_at,
       v_take, v_layer.unit_cost);

    update public.stock_layer_balances
       set qty_remaining = qty_remaining - v_take
     where in_ledger_id = v_layer.in_ledger_id
       and in_ledger_created_at = v_layer.in_ledger_created_at;

    v_cost := v_cost + round(v_take * v_layer.unit_cost, 4);
    v_last_cost := v_layer.unit_cost;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    -- Negative stock is rejected by default. A warehouse setting can allow it; the shortfall is
    -- then valued at the most recent inbound cost (or zero when there is no history).
    select w.allow_negative_stock into v_allow_neg
      from public.warehouses w where w.id = p_warehouse_id;

    if not (coalesce(v_allow_neg, false) or app.negative_stock_allowed()) then
      raise exception 'insufficient stock for product %: short by %', p_product_id, v_remaining
        using errcode = '23514';
    end if;

    v_cost := v_cost + round(v_remaining * v_last_cost, 4);
  end if;

  return v_cost;
end;
$$;

create or replace function app.create_invoice(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_contact_id   uuid,
  p_invoice_date date,
  p_lines        jsonb,
  p_currency     text default 'USD',
  p_sales_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_at  timestamptz := clock_timestamp();
  v_invoice_id  uuid := gen_random_uuid();
  v_invoice_no  text;
  v_currency    text := coalesce(p_currency, 'USD');
  v_rate        numeric;
  v_line        jsonb;
  v_line_no     int := 0;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_warehouse_id uuid;
  v_qty         numeric(19, 4);
  v_unit_price  numeric(19, 4);
  v_discount    numeric(19, 4);
  v_subtotal    numeric(19, 4);
  v_tax_rate_id uuid;
  v_tax_rate    numeric(9, 6);
  v_line_tax    numeric(19, 4);
  v_line_total  numeric(19, 4);
  v_sum_subtotal numeric(19, 4) := 0;
  v_sum_tax     numeric(19, 4) := 0;
  v_sum_total   numeric(19, 4) := 0;
  v_cogs        numeric(19, 4) := 0;
  v_keys        jsonb := '[]'::jsonb;
  v_key         record;
  v_avail       numeric(19, 4);
  v_allow_neg   boolean;
  v_journal     uuid;
  v_ledger_id   uuid;
  v_line_rows   jsonb := '[]'::jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_invoice requires at least one line' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_invoice_date);

  v_rate := app.rate_on(p_org_id, v_currency, p_invoice_date);
  if v_rate is null then
    raise exception 'no exchange rate for % effective on %', v_currency, p_invoice_date
      using errcode = 'no_data_found';
  end if;

  -- Pass 1: validate lines and collect the stock keys this invoice will touch.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(v_line ->> 'variant_id', '')::uuid;
    v_warehouse_id := (v_line ->> 'warehouse_id')::uuid;
    v_keys := v_keys || jsonb_build_object(
      'warehouse_id', v_warehouse_id, 'product_id', v_product_id, 'variant_id', v_variant_id
    );
  end loop;

  -- Lock stock_balances rows in ascending (warehouse_id, product_id) order before touching
  -- anything. This is what keeps concurrent invoices from deadlocking.
  perform app.lock_stock_balances(p_org_id, p_branch_id, v_keys);

  -- Availability check, aggregated per key so repeated lines are counted together.
  for v_key in
    select (l ->> 'warehouse_id')::uuid as warehouse_id,
           (l ->> 'product_id')::uuid as product_id,
           nullif(l ->> 'variant_id', '')::uuid as variant_id,
           sum((l ->> 'qty')::numeric) as needed
      from jsonb_array_elements(p_lines) as l
     group by 1, 2, 3
     order by 1, 2, 3 nulls first
  loop
    select coalesce(sum(sb.qty_remaining), 0) into v_avail
      from public.stock_layer_balances sb
     where sb.org_id = p_org_id
       and sb.warehouse_id = v_key.warehouse_id
       and sb.product_id = v_key.product_id
       and sb.variant_id is not distinct from v_key.variant_id
       and sb.qty_remaining > 0;

    select w.allow_negative_stock into v_allow_neg
      from public.warehouses w where w.id = v_key.warehouse_id;

    if v_avail < v_key.needed and not (coalesce(v_allow_neg, false) or app.negative_stock_allowed()) then
      raise exception 'insufficient stock for product %: available %, required %',
        v_key.product_id, v_avail, v_key.needed using errcode = '23514';
    end if;
  end loop;

  -- Pass 2: price the lines, consume FIFO layers and record COGS.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(v_line ->> 'variant_id', '')::uuid;
    v_warehouse_id := (v_line ->> 'warehouse_id')::uuid;
    v_qty := (v_line ->> 'qty')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;
    v_discount := coalesce((v_line ->> 'discount')::numeric, 0);

    if v_qty <= 0 then
      raise exception 'invoice line quantity must be positive' using errcode = '23514';
    end if;

    v_subtotal := round(v_qty * v_unit_price - v_discount, 4);

    -- The rate this line used. Stored on the line; never recomputed later.
    if v_line ? 'tax_rate_code' and (v_line ->> 'tax_rate_code') is not null then
      select r.id, r.rate into v_tax_rate_id, v_tax_rate
        from public.tax_rates r
       where r.org_id = p_org_id
         and r.code = (v_line ->> 'tax_rate_code')
         and r.effective_from <= p_invoice_date
         and (r.effective_to is null or r.effective_to >= p_invoice_date)
       order by r.effective_from desc
       limit 1;
    end if;
    v_tax_rate := coalesce(v_tax_rate, 0);

    v_line_tax := round(v_subtotal * v_tax_rate, 4);
    v_line_total := v_subtotal + v_line_tax;

    -- Outbound ledger row for this line, then FIFO consumption against it.
    v_ledger_id := gen_random_uuid();
    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, source_id, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, 'out',
       v_qty, 0, 'sale', v_invoice_id, v_created_at);

    declare
      v_line_cost numeric(19, 4) := app.consume_fifo(
        p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, v_qty,
        v_ledger_id, v_created_at
      );
    begin
      v_cogs := v_cogs + v_line_cost;

      v_line_rows := v_line_rows || jsonb_build_object(
        'line_no', v_line_no,
        'product_id', v_product_id,
        'variant_id', v_variant_id,
        'warehouse_id', v_warehouse_id,
        'description', v_line ->> 'description',
        'qty', v_qty,
        'unit_price', v_unit_price,
        'unit_cost', round(v_line_cost / v_qty, 4),
        'discount', v_discount,
        'tax_rate_id', v_tax_rate_id,
        'tax_rate', v_tax_rate,
        'line_subtotal', v_subtotal,
        'line_tax', v_line_tax,
        'line_total', v_line_total
      );

      insert into public.stock_balances
        (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
      values
        (p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, -v_qty, -v_line_cost)
      on conflict (org_id, warehouse_id, product_id, variant_id) do update
        set qty   = public.stock_balances.qty + excluded.qty,
            value = public.stock_balances.value + excluded.value;
    end;
    v_tax_rate_id := null;

    v_sum_subtotal := v_sum_subtotal + v_subtotal;
    v_sum_tax      := v_sum_tax + v_line_tax;
    v_sum_total    := v_sum_total + v_line_total;
  end loop;

  -- Gapless invoice number. Locked FOR UPDATE inside this transaction, so a rollback does not
  -- consume a number.
  v_invoice_no := app.next_number(p_org_id, 'INVOICE');

  -- Dr AR / Cr Revenue / Cr VAT Output / Dr COGS / Cr Inventory.
  v_journal := app.post_journal(
    p_org_id, p_branch_id, p_invoice_date, 'invoice', v_invoice_id, 'Invoice ' || v_invoice_no,
    v_currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '1100', 'debit', v_sum_total, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Accounts receivable'),
      jsonb_build_object('account_code', '4000', 'credit', v_sum_subtotal, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Sales revenue'),
      jsonb_build_object('account_code', '2100', 'credit', v_sum_tax, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'VAT output'),
      jsonb_build_object('account_code', '5000', 'debit', v_cogs, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Cost of goods sold'),
      jsonb_build_object('account_code', '1000', 'credit', v_cogs, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Inventory')
    )
  );

  insert into public.invoices
    (id, org_id, branch_id, contact_id, sales_order_id, invoice_no, invoice_date, currency,
     exchange_rate, subtotal, tax_total, total, journal_id, journal_created_at, created_at)
  select v_invoice_id, p_org_id, p_branch_id, p_contact_id, p_sales_order_id, v_invoice_no,
         p_invoice_date, v_currency, v_rate, v_sum_subtotal, v_sum_tax, v_sum_total,
         v_journal, j.created_at, v_created_at
    from public.journals j
   where j.id = v_journal;

  insert into public.invoice_lines
    (org_id, branch_id, invoice_id, line_no, product_id, variant_id,
     warehouse_id, description, qty, unit_price, unit_cost, discount, tax_rate_id, tax_rate,
     line_subtotal, line_tax, line_total)
  select p_org_id, p_branch_id, v_invoice_id,
         (l ->> 'line_no')::int,
         (l ->> 'product_id')::uuid,
         nullif(l ->> 'variant_id', '')::uuid,
         (l ->> 'warehouse_id')::uuid,
         l ->> 'description',
         (l ->> 'qty')::numeric,
         (l ->> 'unit_price')::numeric,
         (l ->> 'unit_cost')::numeric,
         (l ->> 'discount')::numeric,
         nullif(l ->> 'tax_rate_id', '')::uuid,
         (l ->> 'tax_rate')::numeric,
         (l ->> 'line_subtotal')::numeric,
         (l ->> 'line_tax')::numeric,
         (l ->> 'line_total')::numeric
    from jsonb_array_elements(v_line_rows) as l;

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_no', v_invoice_no,
    'subtotal', v_sum_subtotal,
    'tax_total', v_sum_tax,
    'total', v_sum_total
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The sync entry point. One call per offline sale, inside its own transaction (the route opens a
-- transaction per sale, so one bad sale cannot block the batch).
--
--   p_lines:   jsonb array of { barcode | variant_id, qty, unit_price } — the price the till
--              charged. It is kept; it is never re-resolved.
--   p_tenders: jsonb array of { method, currency, amount_tendered }.
--   p_local_time: the till's clock at the moment of the sale, used to work out whether a
--              promotion was in force then.
--
-- Policy (ADR-0016): never reject a completed sale. A duplicate returns the original receipt. A
-- short-stock sale posts through the allow-negative hook and is logged. A price or promotion that
-- has moved on is honoured and logged. Only a genuinely malformed sale is an `exception`.
--
-- Returns { outcome: 'committed' | 'duplicate' | 'exception', receipt: {...}|null,
--           exceptions: [{ kind, detail }] }.
-- ---------------------------------------------------------------------------
create or replace function app.sync_pos_sale(
  p_org_id         uuid,
  p_branch_id      uuid,
  p_warehouse_id   uuid,
  p_shift_id       uuid,
  p_client_sale_id uuid,
  p_lines          jsonb,
  p_tenders        jsonb,
  p_contact_id     uuid default null,
  p_sale_date      date default null,
  p_local_time     timestamptz default null,
  p_tax_code       text default 'VAT15'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing     uuid;
  v_receipt      jsonb;
  v_outcome      text := 'committed';
  v_line         jsonb;
  v_variant_id   uuid;
  v_qty          numeric(19, 4);
  v_charged      numeric(19, 4);
  v_current      numeric(19, 4);
  v_at_sale      numeric(19, 4);
  v_expired_promo record;
  v_exceptions   jsonb := '[]'::jsonb;
  v_detail       jsonb;
  v_sale_at      timestamptz := coalesce(p_local_time, now());
  v_error        text;
begin
  if p_client_sale_id is null then
    raise exception 'sync_pos_sale requires a client_sale_id' using errcode = '23514';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'sync_pos_sale requires at least one line' using errcode = '23514';
  end if;
  if p_tenders is null or jsonb_typeof(p_tenders) <> 'array' or jsonb_array_length(p_tenders) = 0 then
    raise exception 'sync_pos_sale requires at least one tender' using errcode = '23514';
  end if;

  -- A sale that already posted is a duplicate: return the original receipt, post nothing.
  select k.sale_id into v_existing
    from public.pos_sale_keys k
   where k.org_id = p_org_id
     and k.client_sale_id = p_client_sale_id;

  if v_existing is not null then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'receipt', app.pos_sale_receipt(v_existing),
      'exceptions', '[]'::jsonb
    );
  end if;

  -- Price and promotion reconciliation. The charged price always stands; these rows only record
  -- that the world moved on while the till was offline.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    continue when not (v_line ? 'unit_price') or (v_line ->> 'unit_price') is null;

    v_charged := (v_line ->> 'unit_price')::numeric;
    v_qty := coalesce((v_line ->> 'qty')::numeric, 1);

    if v_line ? 'variant_id' and (v_line ->> 'variant_id') is not null then
      v_variant_id := (v_line ->> 'variant_id')::uuid;
    else
      select pv.id into v_variant_id
        from public.product_variants pv
       where pv.org_id = p_org_id
         and pv.barcode = (v_line ->> 'barcode')
       limit 1;
    end if;

    continue when v_variant_id is null;

    select pr.unit_price into v_current
      from app.get_price(p_org_id, v_variant_id, null, now(), v_qty) as pr;
    select pr.unit_price into v_at_sale
      from app.get_price(p_org_id, v_variant_id, null, v_sale_at, v_qty) as pr;

    -- Did a promotion that was live at sale time expire since? If so the gap between the charged
    -- price and the current price is explained, and the expired promotion is what we log.
    v_expired_promo := null;
    if v_at_sale is not null and v_charged = v_at_sale
       and v_current is not null and v_charged < v_current then
      select p.id, p.name into v_expired_promo
        from public.promotions p
       where p.org_id = p_org_id
         and p.valid_from <= v_sale_at
         and p.valid_to >= v_sale_at
         and (p.valid_to < now() or not p.is_active)
       order by p.priority
       limit 1;
    end if;

    if v_expired_promo is not null then
      v_detail := jsonb_build_object(
        'promotion_id', v_expired_promo.id, 'name', v_expired_promo.name,
        'charged', v_charged, 'current', v_current, 'sale_time', v_sale_at
      );
      insert into public.pos_sync_exceptions (org_id, branch_id, client_sale_id, kind, detail)
      values (p_org_id, p_branch_id, p_client_sale_id, 'promotion_expired', v_detail);
      v_exceptions := v_exceptions || jsonb_build_object('kind', 'promotion_expired', 'detail', v_detail);
    elsif v_current is not null and v_charged <> v_current then
      v_detail := jsonb_build_object(
        'variant_id', v_variant_id, 'qty', v_qty,
        'charged', v_charged, 'current', v_current
      );
      insert into public.pos_sync_exceptions (org_id, branch_id, client_sale_id, kind, detail)
      values (p_org_id, p_branch_id, p_client_sale_id, 'price_variance', v_detail);
      v_exceptions := v_exceptions || jsonb_build_object('kind', 'price_variance', 'detail', v_detail);
    end if;
  end loop;

  -- Post it. Strict rules first; a short-stock sale is retried once with the allow-negative hook
  -- (ADR-0015), so a completed sale is never refused. The nested block is a subtransaction: a
  -- failure rolls back cleanly and the retry starts from nothing.
  begin
    v_receipt := app.post_pos_sale(
      p_org_id, p_branch_id, p_warehouse_id, p_shift_id, p_client_sale_id, p_lines, p_tenders,
      p_contact_id, p_sale_date, null, p_tax_code
    );
  exception when others then
    if sqlerrm like 'insufficient stock%' then
      perform set_config('app.allow_negative_stock', 'on', true);
      v_receipt := app.post_pos_sale(
        p_org_id, p_branch_id, p_warehouse_id, p_shift_id, p_client_sale_id, p_lines, p_tenders,
        p_contact_id, p_sale_date, null, p_tax_code
      );
      v_detail := jsonb_build_object('reason', sqlerrm);
      insert into public.pos_sync_exceptions (org_id, branch_id, client_sale_id, kind, detail)
      values (p_org_id, p_branch_id, p_client_sale_id, 'negative_stock', v_detail);
      v_exceptions := v_exceptions || jsonb_build_object('kind', 'negative_stock', 'detail', v_detail);
    else
      v_outcome := 'exception';
      v_error := sqlerrm;
      v_detail := jsonb_build_object('reason', v_error);
      insert into public.pos_sync_exceptions (org_id, branch_id, client_sale_id, kind, detail)
      values (p_org_id, p_branch_id, p_client_sale_id, 'rejected', v_detail);
      v_exceptions := v_exceptions || jsonb_build_object('kind', 'rejected', 'detail', v_detail);
    end if;
  end;

  return jsonb_build_object(
    'outcome', v_outcome,
    'receipt', case when v_outcome = 'committed' then v_receipt else null end,
    'exceptions', v_exceptions
  );
end;
$$;

grant execute on function app.sync_pos_sale(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, date, timestamptz, text)
  to authenticated, service_role;

-- Partitions for the current month and the next two months.
select app.ensure_partitions(2);
