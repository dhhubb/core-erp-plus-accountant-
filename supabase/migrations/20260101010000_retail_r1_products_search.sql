-- R1: products, barcodes and search.
--
-- Additive only. Nothing here edits a core migration or a core accounting path.
--
-- Adds:
--   * public.categories            (org-scoped, nested through parent_id)
--   * public.product_batches       (org-scoped batch master; batch_no + expiry_date)
--   * products.category_id, unit, is_weighable, name_search (generated)
--   * product_variants.size, color, barcode
--
-- Barcodes belong to variants, not products. The partial unique index makes a barcode unique
-- within an org when it is present, while allowing any number of variants with no barcode.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gin with schema extensions;

-- ---------------------------------------------------------------------------
-- Categories. Nested through parent_id; a category's parent must be in the same org, which the
-- composite foreign key (org_id, parent_id) enforces rather than a trigger.
-- ---------------------------------------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  parent_id  uuid,
  name       text not null,
  slug       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_org_slug_key unique (org_id, slug),
  -- A composite foreign key needs a unique constraint on the referenced columns, and the
  -- self-reference below needs it to exist at creation time.
  constraint categories_org_id_key unique (org_id, id),
  constraint categories_parent_fkey foreign key (org_id, parent_id)
    references public.categories (org_id, id) on delete restrict,
  constraint categories_no_self_parent check (parent_id is null or parent_id <> id)
);

create index categories_parent_id_idx on public.categories (parent_id);
create index categories_org_parent_idx on public.categories (org_id, parent_id);

-- ---------------------------------------------------------------------------
-- Product batches: batch master only. Stock-by-batch is deliberately not built here (see
-- docs/ADR.md, expiry tracking open item). A batch belongs to a variant.
-- ---------------------------------------------------------------------------
create table public.product_batches (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  variant_id  uuid not null references public.product_variants (id) on delete restrict,
  batch_no    text not null,
  expiry_date date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_batches_org_variant_batch_key unique (org_id, variant_id, batch_no)
);

create index product_batches_variant_id_idx on public.product_batches (variant_id);

-- ---------------------------------------------------------------------------
-- Additive columns on products.
--   unit         : how the item is sold at the till
--   is_weighable : weighable items accept decimal quantities; everything else is whole units
--   category_id  : optional
--   name_search  : generated tsvector over the product name using the 'simple' text config
-- ---------------------------------------------------------------------------
create type public.product_unit as enum ('each', 'kg', 'g', 'l', 'ml', 'pack');

alter table public.products
  add column category_id  uuid,
  add column unit         public.product_unit not null default 'each',
  add column is_weighable boolean not null default false,
  add column name_search  tsvector
    generated always as (to_tsvector('simple', coalesce(name, ''))) stored;

alter table public.products
  add constraint products_category_fkey foreign key (org_id, category_id)
    references public.categories (org_id, id) on delete restrict;

create index products_category_id_idx on public.products (category_id);
create index products_org_category_idx on public.products (org_id, category_id);

-- A weighable product must be sold in a measure unit, not 'each'. This keeps the till honest:
-- a decimal quantity only ever reaches a product that is declared weighable.
alter table public.products
  add constraint products_weighable_unit_check
    check ((is_weighable and unit <> 'each') or (not is_weighable));

-- ---------------------------------------------------------------------------
-- Additive columns on product_variants. The barcode lives here, not on products.
-- ---------------------------------------------------------------------------
alter table public.product_variants
  add column size    text,
  add column color   text,
  add column barcode text;

-- Partial unique index: a barcode is unique within an org when present; NULLs are unconstrained,
-- so a variant without a barcode is always allowed.
create unique index product_variants_org_barcode_key
  on public.product_variants (org_id, barcode)
  where barcode is not null;

-- Regular index for the equality lookup the search path uses (and to cover the partial one's
-- predicate for FK-style lookups that do not filter on barcode is not needed: barcode is not a FK).
create index product_variants_org_barcode_idx on public.product_variants (org_id, barcode);

-- ---------------------------------------------------------------------------
-- Trigram search. btree_gin lets one GIN index carry the org_id btree column and the trigram
-- name column together, so an org-scoped name search uses a single index.
-- ---------------------------------------------------------------------------
create index products_name_trgm_idx
  on public.products using gin (org_id, name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- RLS. Both new tables are org-scoped.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.categories', 'org');
select app.apply_tenant_rls('public.product_batches', 'org');

-- updated_at maintenance, matching the core convention.
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function app.set_updated_at();

create trigger product_batches_set_updated_at
  before update on public.product_batches
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Search. Exact barcode first, then a trigram-backed name match. Org-scoped through the caller's
-- RLS claims, ordered by relevance, hard-limited to 20 rows.
--
-- Returns one row per matching variant. The barcode hit is marked so the caller can prefer it.
-- SECURITY INVOKER: the caller's RLS on products/product_variants applies.
--
-- The name predicate is ILIKE '%term%'. That is the operator the (org_id, name gin_trgm_ops) GIN
-- index serves directly, so a substring search stays an index scan rather than a scan of the org's
-- whole catalogue. Relevance is word_similarity(name, term), which ranks a term found inside a
-- longer name above a merely similar one.
--
-- Every object is schema-qualified, so there is deliberately no `set search_path` clause: that
-- clause would stop the planner inlining this function, and an inlined body is what lets EXPLAIN
-- show the trigram index. The body is safe to inline because it references only qualified names.
-- ---------------------------------------------------------------------------
create or replace function app.search_products(
  p_org_id uuid,
  p_query  text,
  p_limit  int default 20
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
  (select p.id as product_id,
          v.id as variant_id,
          p.name as product_name,
          v.name as variant_name,
          v.sku as sku,
          v.barcode as barcode,
          p.category_id,
          p.unit::text as unit,
          p.is_weighable,
          'barcode'::text as match_type,
          1.0::real as score
     from public.product_variants v
     join public.products p on p.id = v.product_id
    where nullif(btrim(coalesce(p_query, '')), '') is not null
      and p.org_id = p_org_id
      and v.org_id = p_org_id
      and v.barcode = btrim(p_query)
    limit 1)
  union all
  (select p.id as product_id,
          v.id as variant_id,
          p.name as product_name,
          v.name as variant_name,
          v.sku as sku,
          v.barcode as barcode,
          p.category_id,
          p.unit::text as unit,
          p.is_weighable,
          'name'::text as match_type,
          extensions.word_similarity(btrim(p_query), p.name)::real as score
     from public.products p
     join public.product_variants v on v.product_id = p.id
    where nullif(btrim(coalesce(p_query, '')), '') is not null
      and p.org_id = p_org_id
      and v.org_id = p_org_id
      and p.name ilike ('%' || btrim(p_query) || '%')
    order by score desc, product_name, variant_id
    limit p_limit)
  limit p_limit;
$$;

comment on function app.search_products(uuid, text, int) is
  'Till search. Exact barcode match first, then a trigram name match, org-scoped and limited to 20.';
