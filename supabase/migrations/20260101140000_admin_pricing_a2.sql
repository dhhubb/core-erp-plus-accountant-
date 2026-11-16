-- A2: Admin pricing UI — price lists, customer groups, promotions, live preview.
--
-- Additive, recorded in ADR-0054 to ADR-0058. It changes no core accounting path, no R2 table and
-- no R2 function signature. It adds a set of admin read/write functions under the `app` schema.
-- Every function is SECURITY INVOKER, so RLS scopes the rows the caller may touch; nothing here
-- runs as the service role.
--
-- The precedence rules themselves are NOT re-implemented here. The admin calls the R2 functions
-- (app.get_price, app.assert_manual_discount) so the console and the till cannot drift. This file
-- only adds the reads and the catalogue-management writes the console needs.
--
-- R2's `price_lists` carries `unique (org_id, kind)`, so an org has at most one `retail` and one
-- `wholesale` list, each with its own currency (USD / ZAR / ZWG). The console therefore shows the
-- org's lists (creating one of a kind that already exists is a 422), not an open-ended list
-- collection (ADR-0056).

-- ---------------------------------------------------------------------------
-- Price lists: keyset page on (created_at, id) with the item count.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_price_lists(
  p_org_id           uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id         uuid,
  name       text,
  kind       text,
  currency   text,
  is_active  boolean,
  item_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select pl.id, pl.name, pl.kind, pl.currency, pl.is_active,
         (select count(*) from public.price_list_items it
           where it.org_id = pl.org_id and it.price_list_id = pl.id) as item_count,
         pl.created_at, pl.updated_at
    from public.price_lists pl
   where pl.org_id = p_org_id
     and (
       p_after_created_at is null
       or (pl.created_at, pl.id) < (p_after_created_at, p_after_id)
     )
   order by pl.created_at desc, pl.id desc
   limit v_limit;
end;
$$;

comment on function app.admin_list_price_lists(uuid, int, timestamptz, uuid) is
  'Keyset page of the org''s price lists (created_at, id) with the item count.';

create or replace function app.create_price_list(
  p_org_id   uuid,
  p_name     text,
  p_kind     text,
  p_currency text default 'USD'
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  insert into public.price_lists (org_id, name, kind, currency)
  values (p_org_id, p_name, p_kind, p_currency)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.update_price_list(
  p_org_id   uuid,
  p_id       uuid,
  p_name     text,
  p_currency text,
  p_is_active boolean
)
returns void
language plpgsql
security invoker
as $$
begin
  update public.price_lists
     set name      = p_name,
         currency  = p_currency,
         is_active = p_is_active
   where org_id = p_org_id and id = p_id;
  if not found then
    raise exception 'price list % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

create or replace function app.delete_price_list(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  delete from public.price_lists where org_id = p_org_id and id = p_id;
  if not found then
    raise exception 'price list % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Price list items: keyset page with margin vs cost.
--
-- Cost is the A1 planning cost (product_variants.cost) when set, else the weighted average cost of
-- the on-hand stock layers (stock_balances.value / stock_balances.qty). It is a read-time figure;
-- the ledger's FIFO cost is untouched (ADR-0053).
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_price_list_items(
  p_org_id           uuid,
  p_price_list_id    uuid,
  p_category_id      uuid default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id             uuid,
  price_list_id  uuid,
  variant_id     uuid,
  product_id     uuid,
  product_name   text,
  variant_name   text,
  sku            text,
  barcode        text,
  category_id    uuid,
  category_name  text,
  price          numeric,
  cost           numeric,
  margin         numeric,
  margin_percent numeric,
  currency       text,
  created_at     timestamptz,
  updated_at     timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  with recursive descendants as (
    select c.id as cat_id
      from public.categories c
     where c.org_id = p_org_id and c.id = p_category_id
    union all
    select c.id
      from public.categories c
      join descendants d on c.parent_id = d.cat_id
     where c.org_id = p_org_id
  ),
  base as (
    select it.id, it.price_list_id, it.variant_id, v.product_id, p.name as product_name,
           v.name as variant_name, v.sku, v.barcode, p.category_id, cat.name as category_name,
           it.price, pl.currency, it.created_at, it.updated_at,
           coalesce(
             v.cost,
             (select case when sum(b.qty) > 0 then round(sum(b.value) / sum(b.qty), 4) else null end
                from public.stock_balances b
               where b.org_id = p_org_id and b.variant_id = v.id)
           ) as cost
      from public.price_list_items it
      join public.price_lists pl on pl.id = it.price_list_id and pl.org_id = it.org_id
      join public.product_variants v on v.id = it.variant_id
      join public.products p on p.id = v.product_id
      left join public.categories cat on cat.id = p.category_id
     where it.org_id = p_org_id
       and it.price_list_id = p_price_list_id
       and (p_category_id is null or p.category_id in (select cat_id from descendants))
       and (
         p_after_created_at is null
         or (it.created_at, it.id) < (p_after_created_at, p_after_id)
       )
     order by it.created_at desc, it.id desc
     limit v_limit
  )
  select b.id, b.price_list_id, b.variant_id, b.product_id, b.product_name, b.variant_name,
         b.sku, b.barcode, b.category_id, b.category_name, b.price, b.cost,
         case when b.cost is null then null else round(b.price - b.cost, 4) end,
         case when b.cost is null or b.price = 0 then null
              else round((b.price - b.cost) / b.price * 100, 4) end,
         b.currency, b.created_at, b.updated_at
    from base b;
end;
$$;

comment on function app.admin_list_price_list_items(uuid, uuid, uuid, int, timestamptz, uuid) is
  'Keyset page of a price list''s items (created_at, id) with margin vs cost, optional category '
  'filter (includes descendants).';

create or replace function app.admin_update_price_list_item(
  p_org_id uuid,
  p_id     uuid,
  p_price  numeric
)
returns void
language plpgsql
security invoker
as $$
begin
  update public.price_list_items
     set price = p_price
   where org_id = p_org_id and id = p_id;
  if not found then
    raise exception 'price list item % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

-- Bulk re-price every item in a category (and its descendants) by a percentage change.
create or replace function app.admin_bulk_price_by_category(
  p_org_id        uuid,
  p_price_list_id uuid,
  p_category_id   uuid,
  p_percent       numeric
)
returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  with recursive descendants as (
    select c.id as cat_id
      from public.categories c
     where c.org_id = p_org_id and c.id = p_category_id
    union all
    select c.id
      from public.categories c
      join descendants d on c.parent_id = d.cat_id
     where c.org_id = p_org_id
  )
  update public.price_list_items it
     set price = greatest(round(it.price * (1 + p_percent / 100), 4), 0)
    from public.product_variants v
    join public.products p on p.id = v.product_id
   where it.org_id = p_org_id
     and it.price_list_id = p_price_list_id
     and it.variant_id = v.id
     and p.category_id in (select cat_id from descendants);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer groups: keyset page with the member count.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_customer_groups(
  p_org_id           uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id             uuid,
  name           text,
  price_list_id  uuid,
  price_list_name text,
  member_count   bigint,
  created_at     timestamptz,
  updated_at     timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select g.id, g.name, g.price_list_id, pl.name,
         (select count(*) from public.contacts c
           where c.org_id = g.org_id and c.group_id = g.id) as member_count,
         g.created_at, g.updated_at
    from public.customer_groups g
    left join public.price_lists pl on pl.id = g.price_list_id
   where g.org_id = p_org_id
     and (
       p_after_created_at is null
       or (g.created_at, g.id) < (p_after_created_at, p_after_id)
     )
   order by g.created_at desc, g.id desc
   limit v_limit;
end;
$$;

create or replace function app.create_customer_group(
  p_org_id        uuid,
  p_name          text,
  p_price_list_id uuid default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  insert into public.customer_groups (org_id, name, price_list_id)
  values (p_org_id, p_name, p_price_list_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.update_customer_group(
  p_org_id        uuid,
  p_id            uuid,
  p_name          text,
  p_price_list_id uuid
)
returns void
language plpgsql
security invoker
as $$
begin
  update public.customer_groups
     set name = p_name, price_list_id = p_price_list_id
   where org_id = p_org_id and id = p_id;
  if not found then
    raise exception 'customer group % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

create or replace function app.delete_customer_group(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  delete from public.customer_groups where org_id = p_org_id and id = p_id;
  if not found then
    raise exception 'customer group % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

-- The contacts in a group (keyset on created_at, id).
create or replace function app.admin_list_group_members(
  p_org_id           uuid,
  p_group_id         uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id         uuid,
  name       text,
  email      text,
  phone      text,
  created_at timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select c.id, c.name, c.email, c.phone, c.created_at
    from public.contacts c
   where c.org_id = p_org_id
     and c.group_id = p_group_id
     and (
       p_after_created_at is null
       or (c.created_at, c.id) < (p_after_created_at, p_after_id)
     )
   order by c.created_at desc, c.id desc
   limit v_limit;
end;
$$;

-- Assign (or, with p_assign = false, unassign) contacts to a group. Returns the rows changed.
create or replace function app.admin_assign_group_members(
  p_org_id      uuid,
  p_group_id    uuid,
  p_contact_ids uuid[],
  p_assign      boolean default true
)
returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  update public.contacts
     set group_id = case when p_assign then p_group_id else null end
   where org_id = p_org_id
     and id = any (p_contact_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Promotions: keyset page with is_active / type filters.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_promotions(
  p_org_id           uuid,
  p_is_active        boolean default null,
  p_type             text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id         uuid,
  name       text,
  type       text,
  valid_from timestamptz,
  valid_to   timestamptz,
  is_active  boolean,
  priority   int,
  stackable  boolean,
  conditions jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select p.id, p.name, p.type, p.valid_from, p.valid_to, p.is_active, p.priority, p.stackable,
         p.conditions, p.created_at, p.updated_at
    from public.promotions p
   where p.org_id = p_org_id
     and (p_is_active is null or p.is_active = p_is_active)
     and (p_type is null or p.type = p_type)
     and (
       p_after_created_at is null
       or (p.created_at, p.id) < (p_after_created_at, p_after_id)
     )
   order by p.created_at desc, p.id desc
   limit v_limit;
end;
$$;

-- Drag-to-reorder: assign priority by array position (1-based). Returns the rows changed.
create or replace function app.admin_reorder_promotions(
  p_org_id      uuid,
  p_ordered_ids uuid[]
)
returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  update public.promotions p
     set priority = ordered.ord
    from (
      select id as pid, ordinality::int as ord
        from unnest(p_ordered_ids) with ordinality as t(id, ordinality)
    ) ordered
   where p.org_id = p_org_id
     and p.id = ordered.pid;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live price preview. Calls app.get_price (so the console and the till cannot drift) and returns
-- the precedence breakdown: 1. price list, 2. promotion, 3. manual discount with the role limit.
--
-- The manual discount is validated through app.assert_manual_discount, so a discount above the
-- role's limit, or one with no reason, raises (test 106). The maximum allowed amount is returned
-- either way, so the console can show the ceiling before the operator commits.
-- ---------------------------------------------------------------------------
create or replace function app.admin_price_preview(
  p_org_id          uuid,
  p_variant_id      uuid,
  p_group_id        uuid,
  p_at_time         timestamptz,
  p_role            text default null,
  p_qty             numeric default 1,
  p_manual_discount numeric default null,
  p_reason          text default null
)
returns table (
  variant_id             uuid,
  currency               text,
  list_price             numeric,
  unit_price             numeric,
  discount               numeric,
  source_price_list_id   uuid,
  source_price_list_name text,
  source_price_list_kind text,
  source_promotion_id    uuid,
  source_promotion_name  text,
  manual_discount        numeric,
  manual_max_amount      numeric,
  effective_price        numeric,
  steps                  jsonb
)
language plpgsql
stable
security invoker
as $$
declare
  v_price      record;
  v_list_name  text;
  v_list_kind  text;
  v_promo_name text;
  v_manual     numeric := 0;
  v_max        numeric := 0;
  v_max_amount numeric := 0;
  v_subtotal   numeric;
  v_effective  numeric;
begin
  select * into v_price
    from app.get_price(p_org_id, p_variant_id, p_group_id, p_at_time, coalesce(p_qty, 1));

  select pl.name, pl.kind into v_list_name, v_list_kind
    from public.price_lists pl
   where pl.org_id = p_org_id and pl.id = v_price.source_price_list_id;

  select pr.name into v_promo_name
    from public.promotions pr
   where pr.org_id = p_org_id and pr.id = v_price.source_promotion_id;

  v_subtotal := round(coalesce(v_price.list_price, 0) * coalesce(p_qty, 1), 4);

  if p_role is not null then
    select dl.max_percent into v_max
      from public.discount_limits dl
     where dl.org_id = p_org_id and dl.role = p_role;
    v_max := coalesce(v_max, 0);
    v_max_amount := round(v_subtotal * v_max / 100, 4);
  end if;

  if p_manual_discount is not null and p_manual_discount > 0 then
    v_manual := app.assert_manual_discount(
      p_org_id, coalesce(p_role, 'member'), v_subtotal, p_manual_discount, p_reason
    );
  end if;

  v_effective := round(coalesce(v_price.unit_price, 0) - v_manual / nullif(coalesce(p_qty, 1), 0), 4);

  return query select
    p_variant_id,
    v_price.currency,
    v_price.list_price,
    v_price.unit_price,
    coalesce(v_price.discount, 0),
    v_price.source_price_list_id,
    v_list_name,
    v_list_kind,
    v_price.source_promotion_id,
    v_promo_name,
    v_manual,
    v_max_amount,
    v_effective,
    jsonb_build_array(
      jsonb_build_object(
        'step', 1, 'name', 'Price list', 'detail', coalesce(v_list_kind, 'none'),
        'amount', v_price.list_price, 'source_id', v_price.source_price_list_id
      ),
      jsonb_build_object(
        'step', 2, 'name', 'Promotion', 'detail', coalesce(v_promo_name, 'none'),
        'amount', -coalesce(v_price.discount, 0), 'source_id', v_price.source_promotion_id
      ),
      jsonb_build_object(
        'step', 3, 'name', 'Manual discount', 'detail', coalesce(p_role, 'none'),
        'amount', -v_manual, 'limit', v_max_amount
      )
    );
end;
$$;

comment on function app.admin_price_preview(uuid, uuid, uuid, timestamptz, text, numeric, numeric, text) is
  'Live price preview for the console: app.get_price plus the precedence breakdown and the role''s '
  'manual-discount ceiling.';

-- ---------------------------------------------------------------------------
-- Grants. Every function runs as the caller (SECURITY INVOKER), so RLS still applies.
-- ---------------------------------------------------------------------------
grant execute on function app.admin_list_price_lists(uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.create_price_list(uuid, text, text, text) to authenticated, service_role;
grant execute on function app.update_price_list(uuid, uuid, text, text, boolean) to authenticated, service_role;
grant execute on function app.delete_price_list(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_price_list_items(uuid, uuid, uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.admin_update_price_list_item(uuid, uuid, numeric) to authenticated, service_role;
grant execute on function app.admin_bulk_price_by_category(uuid, uuid, uuid, numeric) to authenticated, service_role;
grant execute on function app.admin_list_customer_groups(uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.create_customer_group(uuid, text, uuid) to authenticated, service_role;
grant execute on function app.update_customer_group(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function app.delete_customer_group(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_group_members(uuid, uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.admin_assign_group_members(uuid, uuid, uuid[], boolean) to authenticated, service_role;
grant execute on function app.admin_list_promotions(uuid, boolean, text, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.admin_reorder_promotions(uuid, uuid[]) to authenticated, service_role;
grant execute on function app.admin_price_preview(uuid, uuid, uuid, timestamptz, text, numeric, numeric, text) to authenticated, service_role;
