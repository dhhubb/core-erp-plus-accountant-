-- M4: sales and purchase functions.
--
-- All business logic lives here; TypeScript route handlers stay thin.
-- create_invoice takes a gapless number, locks stock in sorted order, checks availability,
-- consumes FIFO layers, inserts the invoice and its lines, and posts the journal. All or nothing.

-- ---------------------------------------------------------------------------
-- create_invoice.
--
--   p_lines: jsonb array of
--     { product_id, variant_id?, warehouse_id, qty, unit_price, discount?, tax_rate_code? }
--
-- Returns { invoice_id, invoice_no, total }.
-- ---------------------------------------------------------------------------
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

    if v_avail < v_key.needed and not coalesce(v_allow_neg, false) then
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
-- allocate_payment: apply a payment to an invoice. It cannot exceed the open balance.
-- Posts Dr Bank, Cr AR.
-- ---------------------------------------------------------------------------
create or replace function app.allocate_payment(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_invoice_id   uuid,
  p_amount       numeric,
  p_payment_date date,
  p_method       text default 'bank',
  p_contact_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice    public.invoices%rowtype;
  v_open       numeric(19, 4);
  v_payment_id uuid := gen_random_uuid();
  v_created_at timestamptz := clock_timestamp();
  v_journal    uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'payment amount must be positive' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_payment_date);

  select * into v_invoice
    from public.invoices
   where id = p_invoice_id
     for update;

  if not found then
    raise exception 'invoice % not found', p_invoice_id using errcode = 'no_data_found';
  end if;

  v_open := v_invoice.total - v_invoice.amount_paid;
  if p_amount > v_open then
    raise exception 'payment % exceeds open balance % on invoice %',
      p_amount, v_open, p_invoice_id using errcode = '23514';
  end if;

  v_journal := app.post_journal(
    p_org_id, p_branch_id, p_payment_date, 'payment', v_payment_id, 'Payment', v_invoice.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '1200', 'debit', p_amount, 'currency', v_invoice.currency,
                         'exchange_rate', v_invoice.exchange_rate, 'description', 'Bank'),
      jsonb_build_object('account_code', '1100', 'credit', p_amount, 'currency', v_invoice.currency,
                         'exchange_rate', v_invoice.exchange_rate, 'description', 'Accounts receivable')
    )
  );

  insert into public.payments
    (id, org_id, branch_id, contact_id, invoice_id, amount, currency,
     exchange_rate, method, paid_at, journal_id, journal_created_at, created_at)
  select v_payment_id, p_org_id, p_branch_id, coalesce(p_contact_id, v_invoice.contact_id),
         p_invoice_id, p_amount, v_invoice.currency, v_invoice.exchange_rate,
         p_method, p_payment_date::timestamptz, v_journal, j.created_at, v_created_at
    from public.journals j
   where j.id = v_journal;

  update public.invoices
     set amount_paid = amount_paid + p_amount
   where id = p_invoice_id;

  return v_payment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_credit_note: reverses revenue, VAT and AR, returns stock at the original FIFO cost, and
-- posts a reversing journal. The stock is returned as a new inbound layer at the cost that the
-- original line used, not at today's cost.
-- ---------------------------------------------------------------------------
create or replace function app.create_credit_note(
  p_org_id             uuid,
  p_branch_id          uuid,
  p_invoice_id         uuid,
  p_lines              jsonb,
  p_credit_date        date,
  p_reason             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice     public.invoices%rowtype;
  v_credit_id   uuid := gen_random_uuid();
  v_credit_no   text;
  v_created_at  timestamptz := clock_timestamp();
  v_line        jsonb;
  v_inv_line    public.invoice_lines%rowtype;
  v_qty         numeric(19, 4);
  v_subtotal    numeric(19, 4);
  v_tax         numeric(19, 4);
  v_total       numeric(19, 4);
  v_cogs        numeric(19, 4) := 0;
  v_sum_subtotal numeric(19, 4) := 0;
  v_sum_tax     numeric(19, 4) := 0;
  v_sum_total   numeric(19, 4) := 0;
  v_journal     uuid;
  v_ledger_id   uuid;
  v_keys        jsonb := '[]'::jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_credit_note requires at least one line' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_credit_date);

  select * into v_invoice
    from public.invoices
   where id = p_invoice_id;

  if not found then
    raise exception 'invoice % not found', p_invoice_id using errcode = 'no_data_found';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_inv_line
      from public.invoice_lines il
     where il.invoice_id = p_invoice_id
       and il.line_no = (v_line ->> 'line_no')::int;

    if not found then
      raise exception 'invoice line % not found on invoice %', v_line ->> 'line_no', p_invoice_id
        using errcode = 'no_data_found';
    end if;

    v_keys := v_keys || jsonb_build_object(
      'warehouse_id', v_inv_line.warehouse_id,
      'product_id', v_inv_line.product_id,
      'variant_id', v_inv_line.variant_id
    );
  end loop;

  perform app.lock_stock_balances(p_org_id, p_branch_id, v_keys);

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_inv_line
      from public.invoice_lines il
     where il.invoice_id = p_invoice_id
       and il.line_no = (v_line ->> 'line_no')::int;

    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty <= 0 or v_qty > v_inv_line.qty then
      raise exception 'credit quantity % is invalid for invoice line %',
        v_qty, v_inv_line.line_no using errcode = '23514';
    end if;

    -- Return stock at the original FIFO cost recorded on the invoice line.
    v_subtotal := round(v_qty * v_inv_line.unit_price - (v_inv_line.discount * v_qty / v_inv_line.qty), 4);
    v_tax      := round(v_subtotal * v_inv_line.tax_rate, 4);
    v_total    := v_subtotal + v_tax;
    v_cogs     := v_cogs + round(v_qty * v_inv_line.unit_cost, 4);

    v_ledger_id := gen_random_uuid();
    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, source_id, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, v_inv_line.warehouse_id, v_inv_line.product_id,
       v_inv_line.variant_id, 'in', v_qty, v_inv_line.unit_cost, 'credit_note', v_credit_id,
       v_created_at);

    insert into public.stock_layer_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id, in_ledger_created_at,
       unit_cost, qty_remaining)
    values
      (p_org_id, p_branch_id, v_inv_line.warehouse_id, v_inv_line.product_id, v_inv_line.variant_id,
       v_ledger_id, v_created_at, v_inv_line.unit_cost, v_qty)
    on conflict (in_ledger_id, in_ledger_created_at) do update
      set qty_remaining = public.stock_layer_balances.qty_remaining + excluded.qty_remaining;

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    values
      (p_org_id, p_branch_id, v_inv_line.warehouse_id, v_inv_line.product_id,
       v_inv_line.variant_id, v_qty, round(v_qty * v_inv_line.unit_cost, 4))
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
      set qty   = public.stock_balances.qty + excluded.qty,
          value = public.stock_balances.value + excluded.value;

    v_sum_subtotal := v_sum_subtotal + v_subtotal;
    v_sum_tax      := v_sum_tax + v_tax;
    v_sum_total    := v_sum_total + v_total;
  end loop;

  v_credit_no := app.next_number(p_org_id, 'CREDIT_NOTE');

  -- Dr Revenue / Dr VAT Output / Cr AR, and Dr Inventory / Cr COGS for the returned stock.
  v_journal := app.post_journal(
    p_org_id, p_branch_id, p_credit_date, 'credit_note', v_credit_id,
    coalesce(p_reason, 'Credit note ' || v_credit_no), v_invoice.currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '4000', 'debit', v_sum_subtotal,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'Sales revenue reversed'),
      jsonb_build_object('account_code', '2100', 'debit', v_sum_tax,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'VAT output reversed'),
      jsonb_build_object('account_code', '1100', 'credit', v_sum_total,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'Accounts receivable'),
      jsonb_build_object('account_code', '1000', 'debit', v_cogs,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'Inventory returned'),
      jsonb_build_object('account_code', '5000', 'credit', v_cogs,
                         'currency', v_invoice.currency, 'exchange_rate', v_invoice.exchange_rate,
                         'description', 'Cost of goods sold reversed')
    )
  );

  insert into public.credit_notes
    (id, org_id, branch_id, invoice_id, credit_no, reason, total, journal_id,
     journal_created_at, created_at)
  select v_credit_id, p_org_id, p_branch_id, p_invoice_id, v_credit_no,
         p_reason, v_sum_total, v_journal, j.created_at, v_created_at
    from public.journals j
   where j.id = v_journal;

  return jsonb_build_object('credit_note_id', v_credit_id, 'credit_no', v_credit_no,
                            'total', v_sum_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- Keyset pagination over (created_at, id). Default 50, maximum 100. Never OFFSET.
-- ---------------------------------------------------------------------------
create or replace function app.assert_page_limit(p_limit int)
returns int
language plpgsql
immutable
as $$
begin
  if p_limit is null then
    return 50;
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100 (got %)', p_limit using errcode = '22023';
  end if;
  return p_limit;
end;
$$;
