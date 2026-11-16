-- A3: Admin operations UI — laybys, returns, shifts/Z-reports and stocktake.
--
-- Additive, recorded in ADR-0059 to ADR-0064. It changes no core accounting path, no core table and
-- no core function signature. The operational business logic already exists in R5 (app.create_layby,
-- app.complete_layby, app.cancel_layby, app.create_return, app.close_shift, app.create_stock_count,
-- app.close_stock_count, app.check_credit). This file adds only the admin *reads* the console needs,
-- plus a stock-count snapshot helper, so the pages stay thin clients over SQL.
--
-- Every function here is SECURITY INVOKER, so the caller's RLS scopes the rows; nothing here runs
-- as the service role. The console never re-implements a rule: a layby completion, a return refund
-- and a shift close all call the R5 functions, and the refund method / cancellation fee are read
-- from public.settings inside those functions, never in TypeScript.

-- ---------------------------------------------------------------------------
-- Laybys: a keyset page on (created_at, id) with the customer and an overdue flag.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_laybys(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_status           text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id            uuid,
  layby_no      text,
  status        text,
  due_date      date,
  currency      text,
  total         numeric,
  deposit_paid  numeric,
  contact_id    uuid,
  contact_name  text,
  invoice_id    uuid,
  is_overdue    boolean,
  created_at    timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  if p_status is not null and p_status not in ('open', 'completed', 'cancelled') then
    raise exception 'unknown layby status %', p_status using errcode = '22023';
  end if;

  return query
  select l.id, l.layby_no, l.status, l.due_date, l.currency, l.total, l.deposit_paid,
         l.contact_id, c.name as contact_name, l.invoice_id,
         (l.status = 'open' and l.due_date < current_date) as is_overdue,
         l.created_at
    from public.laybys l
    left join public.contacts c on c.id = l.contact_id
   where l.org_id = p_org_id
     and l.branch_id = p_branch_id
     and (p_status is null or l.status = p_status)
     and (
       p_after_created_at is null
       or (l.created_at, l.id) < (p_after_created_at, p_after_id)
     )
   order by l.created_at desc, l.id desc
   limit v_limit;
end;
$$;

comment on function app.admin_list_laybys(uuid, uuid, text, int, timestamptz, uuid) is
  'Keyset page of laybys (created_at, id) with the customer and an overdue flag.';

-- ---------------------------------------------------------------------------
-- One layby with its customer and its reservations (the goods held aside).
-- ---------------------------------------------------------------------------
create or replace function app.admin_layby_detail(p_org_id uuid, p_layby_id uuid)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_layby public.laybys%rowtype;
begin
  select * into v_layby
    from public.laybys
   where id = p_layby_id and org_id = p_org_id;
  if not found then
    raise exception 'layby % not found', p_layby_id using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', v_layby.id,
    'layby_no', v_layby.layby_no,
    'status', v_layby.status,
    'due_date', v_layby.due_date,
    'currency', v_layby.currency,
    'subtotal', v_layby.subtotal,
    'tax_total', v_layby.tax_total,
    'total', v_layby.total,
    'deposit_paid', v_layby.deposit_paid,
    'cancellation_fee', v_layby.cancellation_fee,
    'invoice_id', v_layby.invoice_id,
    'is_overdue', (v_layby.status = 'open' and v_layby.due_date < current_date),
    'created_at', v_layby.created_at,
    'customer', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone)
        from public.contacts c where c.id = v_layby.contact_id
    ),
    'reservations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'product_id', r.product_id, 'variant_id', r.variant_id,
               'qty', r.qty, 'unit_price', r.unit_price, 'unit_cost', r.unit_cost,
               'status', r.status) order by r.line_no)
        from public.layby_reservations r
       where r.layby_id = v_layby.id
    ), '[]'::jsonb)
  );
end;
$$;

comment on function app.admin_layby_detail(uuid, uuid) is
  'One layby with its customer and its reservations, for the detail page.';

-- ---------------------------------------------------------------------------
-- Returns: a keyset page on (created_at, id).
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_returns(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id                  uuid,
  return_no           text,
  status              text,
  original_invoice_id uuid,
  refund_method       text,
  total               numeric,
  credit_note_id      uuid,
  created_at          timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select r.id, r.return_no, r.status, r.original_invoice_id, r.refund_method, r.total,
         r.credit_note_id, r.created_at
    from public.returns r
   where r.org_id = p_org_id
     and r.branch_id = p_branch_id
     and (
       p_after_created_at is null
       or (r.created_at, r.id) < (p_after_created_at, p_after_id)
     )
   order by r.created_at desc, r.id desc
   limit v_limit;
end;
$$;

comment on function app.admin_list_returns(uuid, uuid, int, timestamptz, uuid) is
  'Keyset page of returns (created_at, id).';

-- ---------------------------------------------------------------------------
-- The returnable lines of an invoice: qty sold, qty already returned and the remainder. The console
-- shows this before a return is created; app.create_return locks these lines FOR UPDATE and applies
-- the same arithmetic, so the read and the write cannot disagree.
-- ---------------------------------------------------------------------------
create or replace function app.admin_invoice_returnable_lines(
  p_org_id     uuid,
  p_invoice_id uuid
)
returns table (
  invoice_line_id uuid,
  line_no         int,
  product_id      uuid,
  variant_id      uuid,
  description     text,
  qty_sold        numeric,
  qty_returned    numeric,
  qty_returnable  numeric,
  unit_price      numeric,
  unit_cost       numeric
)
language sql
stable
security invoker
as $$
  select il.id,
         il.line_no,
         il.product_id,
         il.variant_id,
         coalesce(il.description, p.name) as description,
         il.qty as qty_sold,
         coalesce(ret.qty_returned, 0) as qty_returned,
         il.qty - coalesce(ret.qty_returned, 0) as qty_returnable,
         il.unit_price,
         il.unit_cost
    from public.invoice_lines il
    join public.products p on p.id = il.product_id
    left join lateral (
      select sum(rl.qty) as qty_returned
        from public.return_lines rl
        join public.returns r on r.id = rl.return_id
       where rl.invoice_line_id = il.id
         and r.status = 'completed'
    ) ret on true
   where il.org_id = p_org_id
     and il.invoice_id = p_invoice_id
   order by il.line_no;
$$;

comment on function app.admin_invoice_returnable_lines(uuid, uuid) is
  'The returnable lines of an invoice: qty sold, qty already returned, and the remainder.';

-- ---------------------------------------------------------------------------
-- Shifts: a keyset page on (created_at, id) with the Z-report id when the shift is closed.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_shifts(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_status           text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id            uuid,
  till_id       text,
  status        text,
  opening_float numeric,
  opened_at     timestamptz,
  closed_at     timestamptz,
  z_report_id   uuid,
  z_no          text,
  created_at    timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  if p_status is not null and p_status not in ('open', 'closed') then
    raise exception 'unknown shift status %', p_status using errcode = '22023';
  end if;

  return query
  select s.id, s.till_id, s.status, s.opening_float, s.opened_at, s.closed_at,
         z.id as z_report_id, z.z_no, s.created_at
    from public.shifts s
    left join public.z_reports z on z.shift_id = s.id
   where s.org_id = p_org_id
     and s.branch_id = p_branch_id
     and (p_status is null or s.status = p_status)
     and (
       p_after_created_at is null
       or (s.created_at, s.id) < (p_after_created_at, p_after_id)
     )
   order by s.created_at desc, s.id desc
   limit v_limit;
end;
$$;

comment on function app.admin_list_shifts(uuid, uuid, text, int, timestamptz, uuid) is
  'Keyset page of shifts (created_at, id) with the Z-report id when closed.';

-- ---------------------------------------------------------------------------
-- One immutable Z-report by id, for the read-only view and the 58mm print.
-- ---------------------------------------------------------------------------
create or replace function app.admin_z_report(p_org_id uuid, p_z_report_id uuid)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_z public.z_reports%rowtype;
begin
  select * into v_z
    from public.z_reports
   where id = p_z_report_id and org_id = p_org_id;
  if not found then
    raise exception 'z-report % not found', p_z_report_id using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', v_z.id,
    'z_no', v_z.z_no,
    'branch_id', v_z.branch_id,
    'shift_id', v_z.shift_id,
    'opened_at', v_z.opened_at,
    'closed_at', v_z.closed_at,
    'opening_float', v_z.opening_float,
    'sale_count', v_z.sale_count,
    'void_count', v_z.void_count,
    'gross_sales', v_z.gross_sales,
    'tax_total', v_z.tax_total,
    'by_method', v_z.by_method,
    'by_currency', v_z.by_currency,
    'vat_by_rate', v_z.vat_by_rate,
    'created_at', v_z.created_at
  );
end;
$$;

comment on function app.admin_z_report(uuid, uuid) is
  'One immutable Z-report by id, read straight from the primary key.';

-- ---------------------------------------------------------------------------
-- The branch's warehouses, for the stocktake and layby pickers. A branch has a handful, so this is
-- a plain ordered list, not a keyset page.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_warehouses(p_org_id uuid, p_branch_id uuid)
returns table (id uuid, code text, name text, allow_negative_stock boolean)
language sql
stable
security invoker
as $$
  select w.id, w.code, w.name, w.allow_negative_stock
    from public.warehouses w
   where w.org_id = p_org_id
     and w.branch_id = p_branch_id
     and w.is_active
   order by w.code;
$$;

comment on function app.admin_list_warehouses(uuid, uuid) is
  'The branch''s active warehouses, ordered by code, for the admin pickers.';

-- ---------------------------------------------------------------------------
-- Stock counts: a keyset page on (created_at, id).
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_stock_counts(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id           uuid,
  count_no     text,
  status       text,
  warehouse_id uuid,
  counted_at   date,
  line_count   bigint,
  closed_at    timestamptz,
  journal_id   uuid,
  created_at   timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select sc.id, sc.count_no, sc.status, sc.warehouse_id, sc.counted_at,
         (select count(*) from public.stock_count_items i
           where i.count_id = sc.id and i.count_created_at = sc.created_at) as line_count,
         sc.closed_at, sc.journal_id, sc.created_at
    from public.stock_counts sc
   where sc.org_id = p_org_id
     and sc.branch_id = p_branch_id
     and (
       p_after_created_at is null
       or (sc.created_at, sc.id) < (p_after_created_at, p_after_id)
     )
   order by sc.created_at desc, sc.id desc
   limit v_limit;
end;
$$;

comment on function app.admin_list_stock_counts(uuid, uuid, int, timestamptz, uuid) is
  'Keyset page of stock counts (created_at, id) with the line count.';

-- ---------------------------------------------------------------------------
-- One stock count with its variance summary (how many lines, and the money either way).
-- ---------------------------------------------------------------------------
create or replace function app.admin_stock_count_detail(
  p_org_id           uuid,
  p_count_id         uuid,
  p_count_created_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_count public.stock_counts%rowtype;
  v_lines int;
  v_variance_lines int;
  v_increase numeric(19, 4);
  v_decrease numeric(19, 4);
begin
  select * into v_count
    from public.stock_counts
   where id = p_count_id and created_at = p_count_created_at and org_id = p_org_id;
  if not found then
    raise exception 'stock count % not found', p_count_id using errcode = 'P0002';
  end if;

  select count(*),
         count(*) filter (where counted_qty <> system_qty),
         coalesce(sum(greatest(counted_qty - system_qty, 0) * unit_cost), 0),
         coalesce(sum(greatest(system_qty - counted_qty, 0) * unit_cost), 0)
    into v_lines, v_variance_lines, v_increase, v_decrease
    from public.stock_count_items
   where count_id = p_count_id and count_created_at = p_count_created_at;

  return jsonb_build_object(
    'id', v_count.id,
    'count_no', v_count.count_no,
    'status', v_count.status,
    'warehouse_id', v_count.warehouse_id,
    'counted_at', v_count.counted_at,
    'closed_at', v_count.closed_at,
    'journal_id', v_count.journal_id,
    'created_at', v_count.created_at,
    'line_count', v_lines,
    'variance_lines', v_variance_lines,
    'inventory_increase', v_increase,
    'inventory_decrease', v_decrease
  );
end;
$$;

comment on function app.admin_stock_count_detail(uuid, uuid, timestamptz) is
  'One stock count with its variance summary.';

-- ---------------------------------------------------------------------------
-- The current system quantity and average cost per item in a warehouse. The console prefills the
-- count lines from this, so the operator only types what they counted.
-- ---------------------------------------------------------------------------
create or replace function app.admin_stock_count_snapshot(
  p_org_id       uuid,
  p_warehouse_id uuid
)
returns table (
  product_id uuid,
  variant_id uuid,
  system_qty numeric,
  unit_cost  numeric
)
language sql
stable
security invoker
as $$
  select sb.product_id,
         sb.variant_id,
         sb.qty as system_qty,
         case when sb.qty > 0 then round(sb.value / sb.qty, 4) else 0 end as unit_cost
    from public.stock_balances sb
   where sb.org_id = p_org_id
     and sb.warehouse_id = p_warehouse_id
   order by sb.product_id, sb.variant_id nulls first;
$$;

comment on function app.admin_stock_count_snapshot(uuid, uuid) is
  'The current system quantity and average cost per item in a warehouse, to prefill a count.';

-- ---------------------------------------------------------------------------
-- Import a stock count's counted lines, set-based. The R5 route imported with COPY, but COPY FROM
-- is not supported under row-level security (SQLSTATE 0A000), and every admin path runs as
-- `authenticated` with RLS forced. A set-based INSERT ... SELECT from the JSON array does the same
-- work inside the RLS-scoped transaction, so the admin path stays SECURITY INVOKER (ADR-0063).
-- ---------------------------------------------------------------------------
create or replace function app.admin_import_stock_count_lines(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_count_id         uuid,
  p_count_created_at timestamptz,
  p_lines            jsonb
)
returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a JSON array' using errcode = '22023';
  end if;

  -- The header must exist in the caller's scope (RLS) before lines are attached.
  perform 1 from public.stock_counts
   where id = p_count_id and created_at = p_count_created_at and org_id = p_org_id;
  if not found then
    raise exception 'stock count % not found', p_count_id using errcode = 'P0002';
  end if;

  insert into public.stock_count_items
    (org_id, branch_id, count_id, count_created_at, line_no, product_id, variant_id,
     counted_qty, system_qty, unit_cost)
  select p_org_id, p_branch_id, p_count_id, p_count_created_at, l.ord::int,
         (l.value ->> 'product_id')::uuid,
         nullif(l.value ->> 'variant_id', '')::uuid,
         (l.value ->> 'counted_qty')::numeric,
         coalesce((l.value ->> 'system_qty')::numeric, 0),
         coalesce((l.value ->> 'unit_cost')::numeric, 0)
    from jsonb_array_elements(p_lines) with ordinality as l(value, ord);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.admin_import_stock_count_lines(uuid, uuid, uuid, timestamptz, jsonb) is
  'Set-based import of a stock count''s counted lines; works under RLS where COPY FROM does not.';

-- ---------------------------------------------------------------------------
-- Grants. Every function is SECURITY INVOKER, so the grant to authenticated is enough; RLS still
-- scopes the rows.
-- ---------------------------------------------------------------------------
grant execute on function app.admin_list_laybys(uuid, uuid, text, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.admin_layby_detail(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_returns(uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.admin_invoice_returnable_lines(uuid, uuid)
  to authenticated, service_role;
grant execute on function app.admin_list_shifts(uuid, uuid, text, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.admin_z_report(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_warehouses(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_stock_counts(uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.admin_stock_count_detail(uuid, uuid, timestamptz)
  to authenticated, service_role;
grant execute on function app.admin_stock_count_snapshot(uuid, uuid)
  to authenticated, service_role;
grant execute on function app.admin_import_stock_count_lines(uuid, uuid, uuid, timestamptz, jsonb)
  to authenticated, service_role;
