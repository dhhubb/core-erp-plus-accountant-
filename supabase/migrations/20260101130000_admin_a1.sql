-- A1: Admin products UI — categories, products, variants, barcodes, batches.
--
-- Additive, recorded in ADR-0050 to ADR-0053. It changes no core accounting path and no core
-- function signature. It adds one nullable column to a core table (`product_variants.cost`) and a
-- set of admin CRUD/read functions under the `app` schema. Every function is SECURITY INVOKER, so
-- RLS scopes the rows the caller may touch; nothing here runs as the service role.
--
-- Business logic lives in SQL (CORE_INTERFACE): the route handlers stay thin. A product or variant
-- write also appends a master-data change (H2) so a branch pulls the catalogue on its next sync.
--
-- EAN-13 validation is application-level (this function plus the TS mirror in
-- src/verticals/admin/barcode.ts). It is deliberately NOT a table CHECK: a barcode may be an
-- internal code that is not an EAN-13, and the import wizard (H5) and R1 already store such
-- barcodes. A 13-digit barcode, however, must carry a valid check digit (ADR-0051).

-- ---------------------------------------------------------------------------
-- Variant cost. The admin shows a read-only cost per variant; it is a planning figure, not the
-- ledger's FIFO cost (which lives on the immutable stock layers). Nullable, so every existing row
-- and every import stays valid.
-- ---------------------------------------------------------------------------
alter table public.product_variants
  add column cost numeric(19, 4);

alter table public.product_variants
  add constraint product_variants_cost_check check (cost is null or cost >= 0);

comment on column public.product_variants.cost is
  'Optional planning cost per variant (NUMERIC(19,4)). Not the ledger FIFO cost, which is stored '
  'on the immutable stock layers.';

-- ---------------------------------------------------------------------------
-- EAN-13 validation. A barcode that is exactly 13 digits must satisfy the EAN-13 check digit;
-- anything else (a short internal code, a 12-digit UPC, an alphanumeric SKU-as-barcode) is
-- accepted as-is. This keeps the R1 and H5 data valid while making a real EAN-13 honest.
-- ---------------------------------------------------------------------------
create or replace function app.is_valid_ean13(p_barcode text)
returns boolean
language sql
immutable
as $$
  select case
    when p_barcode is null then false
    when btrim(p_barcode) !~ '^[0-9]{13}$' then true
    else (
      -- Weighted sum: digits at odd positions (1-based) count once, even positions count three
      -- times. The check digit makes the total a multiple of ten.
      (
        select (10 - (sum(d * case when i % 2 = 1 then 1 else 3 end) % 10)) % 10
          from generate_series(1, 12) as g(i)
          cross join lateral (select substr(btrim(p_barcode), i, 1)::int as d) s
      ) = substr(btrim(p_barcode), 13, 1)::int
    )
  end;
$$;

comment on function app.is_valid_ean13(text) is
  'True when a 13-digit barcode carries a valid EAN-13 check digit, or when the barcode is not a '
  '13-digit code at all (an internal code is accepted as-is).';

-- A helper that raises on a bad 13-digit barcode, for the write functions to share.
create or replace function app.assert_barcode(p_barcode text)
returns text
language plpgsql
immutable
as $$
begin
  if p_barcode is not null and not app.is_valid_ean13(p_barcode) then
    raise exception 'barcode % is not a valid EAN-13 check digit', p_barcode
      using errcode = '22023';
  end if;
  return nullif(btrim(coalesce(p_barcode, '')), '');
end;
$$;

comment on function app.assert_barcode(text) is
  'Normalises a barcode (trim, empty -> null) and raises when a 13-digit barcode fails the EAN-13 '
  'check digit.';

-- ---------------------------------------------------------------------------
-- Categories. Nested through parent_id. The tree is read whole (an org has tens of categories,
-- not millions) but still ordered so the client renders it without a second pass.
-- ---------------------------------------------------------------------------
create or replace function app.admin_category_tree(p_org_id uuid)
returns table (
  id         uuid,
  parent_id  uuid,
  name       text,
  slug       text,
  depth      int,
  path       text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
as $$
  with recursive tree as (
    select c.id, c.parent_id, c.name, c.slug, c.created_at, c.updated_at,
           0 as depth, c.name as path
      from public.categories c
     where c.org_id = p_org_id and c.parent_id is null
    union all
    select c.id, c.parent_id, c.name, c.slug, c.created_at, c.updated_at,
           t.depth + 1, t.path || ' / ' || c.name
      from public.categories c
      join tree t on t.id = c.parent_id
     where c.org_id = p_org_id
  )
  select id, parent_id, name, slug, depth, path, created_at, updated_at
    from tree
   order by path;
$$;

comment on function app.admin_category_tree(uuid) is
  'The org''s category tree, depth-first ordered by name path, so the client renders it in one pass.';

create or replace function app.create_category(
  p_org_id    uuid,
  p_name      text,
  p_slug      text,
  p_parent_id uuid default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'category name is required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_slug, '')), '') is null then
    raise exception 'category slug is required' using errcode = '22023';
  end if;

  insert into public.categories (org_id, name, slug, parent_id)
  values (p_org_id, btrim(p_name), btrim(p_slug), p_parent_id)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function app.update_category(
  p_org_id    uuid,
  p_id        uuid,
  p_name      text,
  p_slug      text,
  p_parent_id uuid default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  if p_parent_id = p_id then
    raise exception 'a category cannot be its own parent' using errcode = '22023';
  end if;

  -- Refuse a cycle: the new parent must not be a descendant of this category.
  if p_parent_id is not null and exists (
    with recursive descendants as (
      select id from public.categories where org_id = p_org_id and parent_id = p_id
      union all
      select c.id from public.categories c join descendants d on c.parent_id = d.id
       where c.org_id = p_org_id
    )
    select 1 from descendants where id = p_parent_id
  ) then
    raise exception 'a category cannot be moved under its own descendant' using errcode = '22023';
  end if;

  update public.categories
     set name = btrim(p_name),
         slug = btrim(p_slug),
         parent_id = p_parent_id,
         updated_at = now()
   where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'category not found' using errcode = 'no_data_found';
  end if;
end;
$$;

create or replace function app.delete_category(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  if exists (select 1 from public.categories where org_id = p_org_id and parent_id = p_id) then
    raise exception 'category has child categories' using errcode = '23503';
  end if;
  if exists (select 1 from public.products where org_id = p_org_id and category_id = p_id) then
    raise exception 'category is in use by products' using errcode = '23503';
  end if;

  delete from public.categories where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'category not found' using errcode = 'no_data_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Products. Create takes a name, an optional category, the unit and the weighable flag. The SKU
-- comes from the number series in SQL (never from JavaScript), so it is gapless per org.
-- ---------------------------------------------------------------------------
create or replace function app.create_product(
  p_org_id      uuid,
  p_name        text,
  p_category_id uuid default null,
  p_unit        text default 'each',
  p_is_weighable boolean default false,
  p_sku         text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id  uuid;
  v_sku text;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'product name is required' using errcode = '22023';
  end if;

  v_sku := coalesce(nullif(btrim(coalesce(p_sku, '')), ''), app.next_number(p_org_id, 'SKU'));

  insert into public.products (org_id, sku, name, category_id, unit, is_weighable)
  values (p_org_id, v_sku, btrim(p_name), p_category_id, p_unit::public.product_unit,
          coalesce(p_is_weighable, false))
  returning id into v_id;

  perform app.record_master_data_change(
    p_org_id, 'product', v_id, 'upsert',
    jsonb_build_object('sku', v_sku, 'name', btrim(p_name), 'unit', p_unit,
                       'is_weighable', coalesce(p_is_weighable, false)), 1);

  return v_id;
end;
$$;

create or replace function app.update_product(
  p_org_id       uuid,
  p_id           uuid,
  p_name         text,
  p_category_id  uuid default null,
  p_unit         text default 'each',
  p_is_weighable boolean default false,
  p_is_active    boolean default true
)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  update public.products
     set name = btrim(p_name),
         category_id = p_category_id,
         unit = p_unit::public.product_unit,
         is_weighable = coalesce(p_is_weighable, false),
         is_active = coalesce(p_is_active, true),
         updated_at = now()
   where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'product not found' using errcode = 'no_data_found';
  end if;

  perform app.record_master_data_change(
    p_org_id, 'product', p_id, 'upsert',
    jsonb_build_object('name', btrim(p_name), 'unit', p_unit,
                       'is_weighable', coalesce(p_is_weighable, false)), 1);
end;
$$;

create or replace function app.delete_product(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  -- Refuse while stock history references the product: the ledger is immutable and its FK is
  -- ON DELETE RESTRICT, so a delete would fail anyway. Give a clear message instead.
  if exists (select 1 from public.stock_ledger where org_id = p_org_id and product_id = p_id) then
    raise exception 'product has stock history and cannot be deleted' using errcode = '23503';
  end if;

  delete from public.products where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'product not found' using errcode = 'no_data_found';
  end if;

  perform app.record_master_data_change(p_org_id, 'product', p_id, 'delete', '{}'::jsonb, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Variants. sku, size, color, barcode, cost. The barcode is validated (13-digit => EAN-13) and
-- the partial unique index (org_id, barcode) WHERE barcode IS NOT NULL makes it unique per org.
-- ---------------------------------------------------------------------------
create or replace function app.create_variant(
  p_org_id     uuid,
  p_product_id uuid,
  p_name       text,
  p_size       text default null,
  p_color      text default null,
  p_barcode    text default null,
  p_cost       numeric default null,
  p_sku        text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id      uuid;
  v_sku     text;
  v_barcode text;
begin
  if not exists (select 1 from public.products where org_id = p_org_id and id = p_product_id) then
    raise exception 'product not found' using errcode = 'no_data_found';
  end if;

  v_barcode := app.assert_barcode(p_barcode);
  v_sku := coalesce(nullif(btrim(coalesce(p_sku, '')), ''), app.next_number(p_org_id, 'SKU'));

  insert into public.product_variants (org_id, product_id, sku, name, size, color, barcode, cost)
  values (p_org_id, p_product_id, v_sku, coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'default'),
          nullif(btrim(coalesce(p_size, '')), ''), nullif(btrim(coalesce(p_color, '')), ''),
          v_barcode, p_cost)
  returning id into v_id;

  perform app.record_master_data_change(
    p_org_id, 'product_variant', v_id, 'upsert',
    jsonb_build_object('product_id', p_product_id, 'sku', v_sku, 'barcode', v_barcode), 1);

  return v_id;
end;
$$;

create or replace function app.update_variant(
  p_org_id  uuid,
  p_id      uuid,
  p_name    text,
  p_size    text default null,
  p_color   text default null,
  p_barcode text default null,
  p_cost    numeric default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows    int;
  v_barcode text := app.assert_barcode(p_barcode);
begin
  update public.product_variants
     set name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'default'),
         size = nullif(btrim(coalesce(p_size, '')), ''),
         color = nullif(btrim(coalesce(p_color, '')), ''),
         barcode = v_barcode,
         cost = p_cost,
         updated_at = now()
   where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'variant not found' using errcode = 'no_data_found';
  end if;

  perform app.record_master_data_change(
    p_org_id, 'product_variant', p_id, 'upsert',
    jsonb_build_object('barcode', v_barcode), 1);
end;
$$;

create or replace function app.delete_variant(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  if exists (select 1 from public.stock_ledger where org_id = p_org_id and variant_id = p_id) then
    raise exception 'variant has stock history and cannot be deleted' using errcode = '23503';
  end if;
  if exists (select 1 from public.product_batches where org_id = p_org_id and variant_id = p_id) then
    raise exception 'variant has batches and cannot be deleted' using errcode = '23503';
  end if;

  delete from public.product_variants where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'variant not found' using errcode = 'no_data_found';
  end if;

  perform app.record_master_data_change(p_org_id, 'product_variant', p_id, 'delete', '{}'::jsonb, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Batches. A batch belongs to a variant; batch_no + expiry_date. The admin colours by days to
-- expiry, computed client-side from expiry_date.
-- ---------------------------------------------------------------------------
create or replace function app.create_batch(
  p_org_id      uuid,
  p_variant_id  uuid,
  p_batch_no    text,
  p_expiry_date date default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_batch_no, '')), '') is null then
    raise exception 'batch number is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.product_variants where org_id = p_org_id and id = p_variant_id) then
    raise exception 'variant not found' using errcode = 'no_data_found';
  end if;

  insert into public.product_batches (org_id, variant_id, batch_no, expiry_date)
  values (p_org_id, p_variant_id, btrim(p_batch_no), p_expiry_date)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function app.update_batch(
  p_org_id      uuid,
  p_id          uuid,
  p_batch_no    text,
  p_expiry_date date default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  update public.product_batches
     set batch_no = btrim(p_batch_no), expiry_date = p_expiry_date, updated_at = now()
   where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'batch not found' using errcode = 'no_data_found';
  end if;
end;
$$;

create or replace function app.delete_batch(p_org_id uuid, p_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  delete from public.product_batches where org_id = p_org_id and id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'batch not found' using errcode = 'no_data_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin reads. Keyset pagination on (created_at, id), default 50, max 100 (app.assert_page_limit).
-- Explicit column lists, never SELECT *. The admin product search reuses the till search's shape
-- (exact barcode first, then a trigram name match) but returns up to 50 rows.
-- ---------------------------------------------------------------------------
create or replace function app.admin_list_products(
  p_org_id           uuid,
  p_category_id      uuid default null,
  p_is_weighable     boolean default null,
  p_query            text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id            uuid,
  sku           text,
  name          text,
  category_id   uuid,
  unit          text,
  is_weighable  boolean,
  is_active     boolean,
  variant_count bigint,
  created_at    timestamptz,
  updated_at    timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select p.id, p.sku, p.name, p.category_id, p.unit::text, p.is_weighable, p.is_active,
         (select count(*) from public.product_variants v where v.product_id = p.id) as variant_count,
         p.created_at, p.updated_at
    from public.products p
   where p.org_id = p_org_id
     and (
       p_category_id is null
       or p.category_id = p_category_id
       or p.category_id in (
         with recursive descendants as (
           select c.id as cat_id from public.categories c
            where c.org_id = p_org_id and c.parent_id = p_category_id
           union all
           select c.id from public.categories c join descendants d on c.parent_id = d.cat_id
            where c.org_id = p_org_id
         )
         select cat_id from descendants
       )
     )
     and (p_is_weighable is null or p.is_weighable = p_is_weighable)
     and (
       nullif(btrim(coalesce(p_query, '')), '') is null
       or p.name ilike ('%' || btrim(p_query) || '%')
     )
     and (
       p_after_created_at is null
       or (p.created_at, p.id) < (p_after_created_at, p_after_id)
     )
   order by p.created_at desc, p.id desc
   limit v_limit;
end;
$$;

create or replace function app.admin_search_products(
  p_org_id uuid,
  p_query  text,
  p_limit  int default 50
)
returns table (
  product_id    uuid,
  variant_id    uuid,
  product_name  text,
  variant_name  text,
  sku           text,
  barcode       text,
  category_id   uuid,
  unit          text,
  is_weighable  boolean,
  match_type    text,
  score         real
)
language sql
stable
security invoker
as $$
  (select p.id, v.id, p.name, v.name, v.sku, v.barcode, p.category_id, p.unit::text,
          p.is_weighable, 'barcode'::text, 1.0::real
     from public.product_variants v
     join public.products p on p.id = v.product_id
    where nullif(btrim(coalesce(p_query, '')), '') is not null
      and p.org_id = p_org_id and v.org_id = p_org_id
      and v.barcode = btrim(p_query)
    limit 1)
  union all
  (select p.id, v.id, p.name, v.name, v.sku, v.barcode, p.category_id, p.unit::text,
          p.is_weighable, 'name'::text, extensions.word_similarity(btrim(p_query), p.name)::real
     from public.products p
     join public.product_variants v on v.product_id = p.id
    where nullif(btrim(coalesce(p_query, '')), '') is not null
      and p.org_id = p_org_id and v.org_id = p_org_id
      and p.name ilike ('%' || btrim(p_query) || '%')
    order by 11 desc, p.name, v.id
    limit least(greatest(coalesce(p_limit, 50), 1), 50))
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

comment on function app.admin_search_products(uuid, text, int) is
  'Admin product search. Exact barcode first, then a trigram name match, org-scoped, at most 50.';

create or replace function app.admin_list_variants(
  p_org_id           uuid,
  p_product_id       uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id            uuid,
  product_id    uuid,
  sku           text,
  name          text,
  size          text,
  color         text,
  barcode       text,
  cost          numeric,
  qty_on_hand   numeric,
  created_at    timestamptz,
  updated_at    timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select v.id, v.product_id, v.sku, v.name, v.size, v.color, v.barcode, v.cost,
         coalesce((select sum(b.qty) from public.stock_balances b
                    where b.org_id = p_org_id and b.variant_id = v.id), 0) as qty_on_hand,
         v.created_at, v.updated_at
    from public.product_variants v
   where v.org_id = p_org_id
     and v.product_id = p_product_id
     and (
       p_after_created_at is null
       or (v.created_at, v.id) < (p_after_created_at, p_after_id)
     )
   order by v.created_at desc, v.id desc
   limit v_limit;
end;
$$;

create or replace function app.admin_list_batches(
  p_org_id           uuid,
  p_product_id       uuid default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id           uuid,
  variant_id   uuid,
  product_id   uuid,
  product_name text,
  variant_name text,
  sku          text,
  batch_no     text,
  expiry_date  date,
  days_to_expiry int,
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
  select b.id, b.variant_id, v.product_id, p.name, v.name, v.sku, b.batch_no, b.expiry_date,
         (b.expiry_date - current_date) as days_to_expiry, b.created_at
    from public.product_batches b
    join public.product_variants v on v.id = b.variant_id
    join public.products p on p.id = v.product_id
   where b.org_id = p_org_id
     and (p_product_id is null or v.product_id = p_product_id)
     and (
       p_after_created_at is null
       or (b.created_at, b.id) < (p_after_created_at, p_after_id)
     )
   order by b.created_at desc, b.id desc
   limit v_limit;
end;
$$;

-- On-hand quantity for one variant, across the branches the caller can see (RLS scopes the rows).
create or replace function app.variant_stock_on_hand(p_org_id uuid, p_variant_id uuid)
returns numeric
language sql
stable
security invoker
as $$
  select coalesce(sum(b.qty), 0)
    from public.stock_balances b
   where b.org_id = p_org_id and b.variant_id = p_variant_id;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Every admin function runs as the caller (SECURITY INVOKER), so RLS still applies.
-- ---------------------------------------------------------------------------
grant execute on function app.is_valid_ean13(text) to authenticated, service_role;
grant execute on function app.assert_barcode(text) to authenticated, service_role;
grant execute on function app.admin_category_tree(uuid) to authenticated, service_role;
grant execute on function app.create_category(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function app.update_category(uuid, uuid, text, text, uuid) to authenticated, service_role;
grant execute on function app.delete_category(uuid, uuid) to authenticated, service_role;
grant execute on function app.create_product(uuid, text, uuid, text, boolean, text) to authenticated, service_role;
grant execute on function app.update_product(uuid, uuid, text, uuid, text, boolean, boolean) to authenticated, service_role;
grant execute on function app.delete_product(uuid, uuid) to authenticated, service_role;
grant execute on function app.create_variant(uuid, uuid, text, text, text, text, numeric, text) to authenticated, service_role;
grant execute on function app.update_variant(uuid, uuid, text, text, text, text, numeric) to authenticated, service_role;
grant execute on function app.delete_variant(uuid, uuid) to authenticated, service_role;
grant execute on function app.create_batch(uuid, uuid, text, date) to authenticated, service_role;
grant execute on function app.update_batch(uuid, uuid, text, date) to authenticated, service_role;
grant execute on function app.delete_batch(uuid, uuid) to authenticated, service_role;
grant execute on function app.admin_list_products(uuid, uuid, boolean, text, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.admin_search_products(uuid, text, int) to authenticated, service_role;
grant execute on function app.admin_list_variants(uuid, uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.admin_list_batches(uuid, uuid, int, timestamptz, uuid) to authenticated, service_role;
grant execute on function app.variant_stock_on_hand(uuid, uuid) to authenticated, service_role;
