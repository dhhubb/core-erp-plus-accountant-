-- M3: inventory engine functions.
--
-- FIFO: consume the oldest inbound layer first. Every consumption is a new stock_consumptions
-- row; a layer row is never updated.
--
-- Lock order: when a transaction touches several stock rows, stock_balances and
-- stock_layer_balances rows are locked in ascending (warehouse_id, product_id) order. This is
-- what keeps concurrent sales deadlock-free.

-- ---------------------------------------------------------------------------
-- Lock the stock_balances rows for a set of stock keys, in ascending
-- (warehouse_id, product_id, variant_id) order.
--
--   p_keys: jsonb array of { "warehouse_id": uuid, "product_id": uuid, "variant_id": uuid|null }
--
-- The rows are locked one key at a time in sorted order. Locking them in a single statement would
-- not guarantee acquisition order, because the planner locks rows as it reads them rather than
-- after sorting.
-- ---------------------------------------------------------------------------
create or replace function app.lock_stock_balances(
  p_org_id    uuid,
  p_branch_id uuid,
  p_keys      jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key record;
begin
  for v_key in
    select distinct
           (k ->> 'warehouse_id')::uuid as warehouse_id,
           (k ->> 'product_id')::uuid   as product_id,
           nullif(k ->> 'variant_id', '')::uuid as variant_id
      from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) as k
     order by 1, 2, 3 nulls first
  loop
    insert into public.stock_balances (org_id, branch_id, warehouse_id, product_id, variant_id)
    values (p_org_id, p_branch_id, v_key.warehouse_id, v_key.product_id, v_key.variant_id)
    on conflict (org_id, warehouse_id, product_id, variant_id) do nothing;

    perform 1
      from public.stock_balances sb
     where sb.org_id = p_org_id
       and sb.warehouse_id = v_key.warehouse_id
       and sb.product_id = v_key.product_id
       and sb.variant_id is not distinct from v_key.variant_id
       for update;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- post_receipt: inbound stock layer plus journal (Dr Inventory, Cr Accounts Payable).
-- ---------------------------------------------------------------------------
create or replace function app.post_receipt(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid,
  p_qty          numeric,
  p_unit_cost    numeric,
  p_posting_date date,
  p_ap_account   text default '2000',
  p_inventory_account text default '1000'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total    numeric(19, 4);
  v_journal  uuid;
  v_ledger   uuid := gen_random_uuid();
  v_created  timestamptz := clock_timestamp();
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'receipt quantity must be positive' using errcode = '23514';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'receipt unit cost must not be negative' using errcode = '23514';
  end if;

  v_total := round(p_qty * p_unit_cost, 4);

  -- Journal first: a receipt always posts Dr Inventory / Cr Accounts Payable.
  v_journal := app.post_journal(
    p_org_id, p_branch_id, p_posting_date, 'receipt', null, 'Stock receipt', 'USD',
    jsonb_build_array(
      jsonb_build_object('account_code', p_inventory_account, 'debit', v_total,
                         'description', 'Inventory received'),
      jsonb_build_object('account_code', p_ap_account, 'credit', v_total,
                         'description', 'Accounts payable')
    )
  );

  -- Inbound layer.
  insert into public.stock_ledger
    (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
     source_type, source_id, created_at)
  values
    (v_ledger, p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, 'in', p_qty,
     p_unit_cost, 'receipt', v_journal, v_created);

  insert into public.stock_layer_balances
    (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id, in_ledger_created_at,
     unit_cost, qty_remaining)
  values
    (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, v_ledger, v_created,
     p_unit_cost, p_qty)
  on conflict (in_ledger_id, in_ledger_created_at) do update
    set qty_remaining = public.stock_layer_balances.qty_remaining + excluded.qty_remaining;

  -- Keep the mutable on-hand cache in step.
  insert into public.stock_balances (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
  values (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, p_qty, v_total)
  on conflict (org_id, warehouse_id, product_id, variant_id) do update
    set qty   = public.stock_balances.qty + excluded.qty,
        value = public.stock_balances.value + excluded.value;

  return v_ledger;
end;
$$;

-- ---------------------------------------------------------------------------
-- consume_fifo: consume the oldest remaining layers first for one warehouse/product.
-- Returns the total cost consumed. Writes a stock_consumptions row per layer touched.
-- ---------------------------------------------------------------------------
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
  v_layer     record;
  v_remaining numeric(19, 4) := p_qty;
  v_take      numeric(19, 4);
  v_cost      numeric(19, 4) := 0;
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
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception 'insufficient stock for product %: short by %', p_product_id, v_remaining
      using errcode = '23514';
  end if;

  return v_cost;
end;
$$;

-- ---------------------------------------------------------------------------
-- post_stock_adjustment: a signed adjustment. Positive p_qty is a write-on; negative is a
-- write-off. Writes the ledger rows and a balanced journal in one transaction.
-- ---------------------------------------------------------------------------
create or replace function app.post_stock_adjustment(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_variant_id   uuid,
  p_qty          numeric,
  p_unit_cost    numeric,
  p_posting_date date,
  p_memo         text default 'Stock adjustment'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ledger_id  uuid := gen_random_uuid();
  v_created_at timestamptz := clock_timestamp();
  v_cost       numeric(19, 4);
  v_journal    uuid;
  v_allow_neg  boolean;
  v_on_hand    numeric(19, 4);
begin
  if p_qty is null or p_qty = 0 then
    raise exception 'adjustment quantity must not be zero' using errcode = '23514';
  end if;

  perform app.lock_stock_balances(
    p_org_id,
    p_branch_id,
    jsonb_build_array(jsonb_build_object(
      'warehouse_id', p_warehouse_id, 'product_id', p_product_id, 'variant_id', p_variant_id))
  );

  if p_qty > 0 then
    v_cost := round(p_qty * coalesce(p_unit_cost, 0), 4);

    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, memo, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, 'in',
       p_qty, coalesce(p_unit_cost, 0), 'adjustment', p_memo, v_created_at);

    insert into public.stock_layer_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id,
       in_ledger_created_at, unit_cost, qty_remaining)
    values
      (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, v_ledger_id,
       v_created_at, coalesce(p_unit_cost, 0), p_qty)
    on conflict (in_ledger_id, in_ledger_created_at) do update
      set qty_remaining = public.stock_layer_balances.qty_remaining + excluded.qty_remaining;

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    values
      (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, p_qty, v_cost)
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
      set qty   = public.stock_balances.qty + excluded.qty,
          value = public.stock_balances.value + excluded.value;

    v_journal := app.post_journal(
      p_org_id, p_branch_id, p_posting_date, 'stock_adjustment', v_ledger_id, p_memo, 'USD',
      jsonb_build_array(
        jsonb_build_object('account_code', '1000', 'debit', v_cost, 'description', 'Inventory increase'),
        jsonb_build_object('account_code', '5000', 'credit', v_cost, 'description', 'Adjustment expense')
      )
    );
  else
    select sb.qty into v_on_hand
      from public.stock_balances sb
     where sb.org_id = p_org_id
       and sb.warehouse_id = p_warehouse_id
       and sb.product_id = p_product_id
       and sb.variant_id is not distinct from p_variant_id;

    select sl.allow_negative_stock into v_allow_neg
      from public.warehouses sl where sl.id = p_warehouse_id;

    if coalesce(v_on_hand, 0) + p_qty < 0 and not coalesce(v_allow_neg, false) then
      raise exception 'adjustment would drive stock negative for product %', p_product_id
        using errcode = '23514';
    end if;

    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, memo, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, 'out',
       -p_qty, coalesce(p_unit_cost, 0), 'adjustment', p_memo, v_created_at);

    v_cost := app.consume_fifo(
      p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, -p_qty,
      v_ledger_id, v_created_at
    );

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    values
      (p_org_id, p_branch_id, p_warehouse_id, p_product_id, p_variant_id, p_qty, -v_cost)
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
      set qty   = public.stock_balances.qty + excluded.qty,
          value = public.stock_balances.value + excluded.value;

    v_journal := app.post_journal(
      p_org_id, p_branch_id, p_posting_date, 'stock_adjustment', v_ledger_id, p_memo, 'USD',
      jsonb_build_array(
        jsonb_build_object('account_code', '5000', 'debit', v_cost, 'description', 'Adjustment expense'),
        jsonb_build_object('account_code', '1000', 'credit', v_cost, 'description', 'Inventory decrease')
      )
    );
  end if;

  return v_ledger_id;
end;
$$;
