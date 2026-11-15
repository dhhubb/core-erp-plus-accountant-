-- R2: pricing and promotions (Retail vertical).
--
-- Additive only. The one core-table edit is the nullable contacts.group_id the R2 brief asks for
-- (recorded in docs/ADR.md, ADR-0011). Nothing here rewrites a core migration or a core
-- accounting path.
--
-- Adds:
--   * public.price_lists        (org-scoped; kind retail/wholesale; one of each per org)
--   * public.price_list_items   (org-scoped; unique (price_list_id, variant_id))
--   * public.customer_groups    (org-scoped; a group may point at a wholesale price list)
--   * public.promotions         (org-scoped; bogo/percent/fixed; conditions jsonb)
--   * public.discount_limits    (org-scoped; per-role cap on a manual discount)
--   * public.manual_discounts   (branch-scoped; every manual discount with its reason)
--   * contacts.group_id         (additive, nullable)
--
-- Precedence (implemented once, in app.apply_promotions):
--   1. the customer group's price list, falling back to the retail list
--   2. active promotions by priority
--   3. a manual discount, only for a role whose discount_limits row allows it, with a reason

-- ---------------------------------------------------------------------------
-- Price lists. One retail and one wholesale list per org, which is what makes the fallback
-- deterministic: a variant with no group price falls back to the single retail list.
-- ---------------------------------------------------------------------------
create table public.price_lists (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null,
  currency   text not null default 'USD',
  kind       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_lists_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint price_lists_kind_check check (kind in ('retail', 'wholesale')),
  constraint price_lists_org_kind_key unique (org_id, kind),
  -- Composite foreign keys from price_list_items and customer_groups target (org_id, id).
  constraint price_lists_org_id_key unique (org_id, id)
);

create index price_lists_org_created_idx on public.price_lists (org_id, created_at desc, id desc);

create table public.price_list_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  price_list_id uuid not null,
  variant_id    uuid not null references public.product_variants (id) on delete cascade,
  price         numeric(19, 4) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint price_list_items_price_check check (price >= 0),
  constraint price_list_items_list_variant_key unique (price_list_id, variant_id),
  constraint price_list_items_list_fkey foreign key (org_id, price_list_id)
    references public.price_lists (org_id, id) on delete cascade
);

create index price_list_items_org_variant_idx on public.price_list_items (org_id, variant_id);
create index price_list_items_org_list_idx on public.price_list_items (org_id, price_list_id);
create index price_list_items_variant_id_idx on public.price_list_items (variant_id);
create index price_list_items_org_created_idx on public.price_list_items (org_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Customer groups. A group optionally maps to a price list, which is precedence step 1.
-- ---------------------------------------------------------------------------
create table public.customer_groups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  name          text not null,
  price_list_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint customer_groups_org_name_key unique (org_id, name),
  constraint customer_groups_org_id_key unique (org_id, id),
  constraint customer_groups_list_fkey foreign key (org_id, price_list_id)
    references public.price_lists (org_id, id) on delete set null
);

create index customer_groups_org_created_idx on public.customer_groups (org_id, created_at desc, id desc);
create index customer_groups_org_list_idx on public.customer_groups (org_id, price_list_id);

-- ---------------------------------------------------------------------------
-- Promotions. Conditions is a jsonb object; the recognised keys are:
--   variant_ids   uuid[]   the promotion applies to these variants only
--   min_qty       numeric  minimum line quantity
--   min_subtotal  numeric  minimum line subtotal
--   value         numeric  percent: the percentage off; fixed: the amount off
-- ---------------------------------------------------------------------------
create table public.promotions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text not null,
  type        text not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz not null,
  is_active   boolean not null default true,
  priority    int not null default 100,
  stackable   boolean not null default false,
  conditions  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint promotions_type_check check (type in ('bogo', 'percent', 'fixed')),
  constraint promotions_valid_range_check check (valid_to > valid_from),
  constraint promotions_conditions_check check (jsonb_typeof(conditions) = 'object')
);

create index promotions_org_created_idx on public.promotions (org_id, created_at desc, id desc);
-- The candidate read is "active promotions for this org", so the partial index carries both.
create index promotions_org_valid_to_idx on public.promotions (org_id, valid_to) where is_active;

-- ---------------------------------------------------------------------------
-- Manual discount limits, one row per role. A role with no row has a limit of zero, so a manual
-- discount is opt-in per role.
-- ---------------------------------------------------------------------------
create table public.discount_limits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  role        text not null,
  max_percent numeric(9, 4) not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint discount_limits_role_check check (role in ('owner', 'admin', 'member')),
  constraint discount_limits_org_role_key unique (org_id, role),
  constraint discount_limits_max_check check (max_percent >= 0 and max_percent <= 100)
);

create index discount_limits_org_created_idx on public.discount_limits (org_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Manual discounts that were actually applied. Branch-scoped: it hangs off an invoice.
-- ---------------------------------------------------------------------------
create table public.manual_discounts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  branch_id  uuid not null references public.branches (id) on delete restrict,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  line_no    int not null,
  role       text not null,
  amount     numeric(19, 4) not null,
  reason     text not null,
  created_at timestamptz not null default now(),
  constraint manual_discounts_amount_check check (amount > 0),
  constraint manual_discounts_reason_check check (btrim(reason) <> '')
);

create index manual_discounts_org_branch_created_idx
  on public.manual_discounts (org_id, branch_id, created_at desc, id desc);
create index manual_discounts_invoice_id_idx on public.manual_discounts (invoice_id);
create index manual_discounts_branch_id_idx on public.manual_discounts (branch_id);
create index manual_discounts_org_id_idx on public.manual_discounts (org_id);

-- ---------------------------------------------------------------------------
-- Additive core change: contacts.group_id. Nullable, so every existing row and every core code
-- path is unaffected.
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column group_id uuid;

alter table public.contacts
  add constraint contacts_group_fkey foreign key (org_id, group_id)
    references public.customer_groups (org_id, id) on delete set null;

create index contacts_org_group_idx on public.contacts (org_id, group_id);
create index contacts_group_id_idx on public.contacts (group_id);

-- ---------------------------------------------------------------------------
-- RLS. Every new table is org-scoped except manual_discounts, which is branch-scoped.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.price_lists', 'org');
select app.apply_tenant_rls('public.price_list_items', 'org');
select app.apply_tenant_rls('public.customer_groups', 'org');
select app.apply_tenant_rls('public.promotions', 'org');
select app.apply_tenant_rls('public.discount_limits', 'org');
select app.apply_tenant_rls('public.manual_discounts', 'branch');

-- updated_at maintenance, matching the core convention.
create trigger price_lists_set_updated_at
  before update on public.price_lists
  for each row execute function app.set_updated_at();
create trigger price_list_items_set_updated_at
  before update on public.price_list_items
  for each row execute function app.set_updated_at();
create trigger customer_groups_set_updated_at
  before update on public.customer_groups
  for each row execute function app.set_updated_at();
create trigger promotions_set_updated_at
  before update on public.promotions
  for each row execute function app.set_updated_at();
create trigger discount_limits_set_updated_at
  before update on public.discount_limits
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Candidate promotions for the org, as jsonb. This is exactly what the Redis cache holds
-- (key promos:{org_id}, TTL 300s). Every evaluation still checks the validity window, so a cache
-- entry that has gone stale cannot apply an expired promotion.
-- ---------------------------------------------------------------------------
create or replace function app.promotion_candidates(p_org_id uuid)
returns jsonb
language sql
stable
security invoker
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',         p.id,
               'type',       p.type,
               'priority',   p.priority,
               'stackable',  p.stackable,
               'valid_from', p.valid_from,
               'valid_to',   p.valid_to,
               'is_active',  p.is_active,
               'conditions', p.conditions
             )
             order by p.priority, p.id
           ),
           '[]'::jsonb
         )
    from public.promotions p
   where p.org_id = p_org_id
     and p.is_active;
$$;

-- ---------------------------------------------------------------------------
-- Apply promotions to one priced line. This is the single implementation of precedence step 2,
-- so the SQL path (candidates read from the table) and the cached path (candidates read from
-- Redis) cannot drift.
--
-- Rule: the highest-priority matching promotion is the primary. Any further promotion applies
-- only when both it and the primary are stackable, so promotions do not stack unless stackable.
-- ---------------------------------------------------------------------------
create or replace function app.apply_promotions(
  p_org_id     uuid,
  p_variant_id uuid,
  p_unit_price numeric,
  p_qty        numeric,
  p_at_time    timestamptz,
  p_candidates jsonb
)
returns table (discount numeric, promotion_id uuid)
language plpgsql
stable
security invoker
as $$
declare
  v_promo            jsonb;
  v_cond             jsonb;
  v_type             text;
  v_value            numeric;
  v_qty              numeric := coalesce(p_qty, 1);
  v_subtotal         numeric := round(coalesce(p_unit_price, 0) * coalesce(p_qty, 1), 4);
  v_line_discount    numeric;
  v_total            numeric := 0;
  v_primary          uuid;
  v_primary_stack    boolean;
  v_seen_primary     boolean := false;
  v_variant_ids      uuid[];
begin
  for v_promo in
    select value
      from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
     order by (value ->> 'priority')::int, (value ->> 'id')
  loop
    if not coalesce((v_promo ->> 'is_active')::boolean, false) then
      continue;
    end if;
    if (v_promo ->> 'valid_from')::timestamptz > p_at_time then
      continue;
    end if;
    if (v_promo ->> 'valid_to')::timestamptz <= p_at_time then
      continue;
    end if;

    v_cond := coalesce(v_promo -> 'conditions', '{}'::jsonb);

    if v_cond ? 'variant_ids' then
      v_variant_ids := (
        select array_agg(x::uuid) from jsonb_array_elements_text(v_cond -> 'variant_ids') as x
      );
      if not (p_variant_id = any (v_variant_ids)) then
        continue;
      end if;
    end if;
    if v_cond ? 'min_qty' and v_qty < (v_cond ->> 'min_qty')::numeric then
      continue;
    end if;
    if v_cond ? 'min_subtotal' and v_subtotal < (v_cond ->> 'min_subtotal')::numeric then
      continue;
    end if;

    -- Stacking rule: only the primary may be non-stackable, and a follower must be stackable.
    if v_seen_primary
       and not (coalesce((v_promo ->> 'stackable')::boolean, false) and v_primary_stack) then
      continue;
    end if;

    v_type  := v_promo ->> 'type';
    v_value := coalesce((v_cond ->> 'value')::numeric, 0);

    v_line_discount := case v_type
      when 'percent' then round(v_subtotal * v_value / 100, 4)
      when 'fixed'   then least(v_value, v_subtotal)
      when 'bogo'    then round(floor(v_qty / 2) * coalesce(p_unit_price, 0), 4)
      else 0
    end;

    if v_line_discount > 0 then
      v_total := v_total + v_line_discount;
      if not v_seen_primary then
        v_primary       := (v_promo ->> 'id')::uuid;
        v_primary_stack := coalesce((v_promo ->> 'stackable')::boolean, false);
        v_seen_primary  := true;
      end if;
    end if;
  end loop;

  return query select least(v_total, v_subtotal)::numeric, v_primary;
end;
$$;

-- ---------------------------------------------------------------------------
-- Price one variant for a customer group at a point in time.
--
--   * the group's price list, falling back to the retail list when the variant is not on it
--     (precedence step 1)
--   * active promotions applied by app.apply_promotions (precedence step 2)
--
-- Returns the effective unit price plus the sources it used. security invoker, and every object
-- is schema-qualified, so there is deliberately no `set search_path` clause (it would block
-- inlining, which is what lets EXPLAIN show the price_list_items index).
-- ---------------------------------------------------------------------------
create or replace function app.get_price(
  p_org_id     uuid,
  p_variant_id uuid,
  p_group_id   uuid,
  p_at_time    timestamptz,
  p_qty        numeric default 1
)
returns table (
  unit_price            numeric,
  list_price            numeric,
  discount              numeric,
  source_price_list_id  uuid,
  source_promotion_id   uuid,
  currency              text
)
language sql
stable
security invoker
as $$
  with candidate_lists as (
    -- The group's list first, then the retail list. A variant missing from the group's list
    -- therefore falls back to its retail price rather than resolving to nothing.
    select g.price_list_id, 1 as priority
      from public.customer_groups g
     where g.org_id = p_org_id
       and g.id = p_group_id
       and g.price_list_id is not null
    union all
    select pl.id, 2
      from public.price_lists pl
     where pl.org_id = p_org_id
       and pl.kind = 'retail'
       and pl.is_active
  ),
  base as (
    select it.price as list_price, it.price_list_id, pl.currency
      from candidate_lists cl
      join public.price_list_items it
        on it.org_id = p_org_id
       and it.price_list_id = cl.price_list_id
       and it.variant_id = p_variant_id
      join public.price_lists pl on pl.id = it.price_list_id
     order by cl.priority
     limit 1
  ),
  promo as (
    select a.discount, a.promotion_id
      from base b
      cross join lateral app.apply_promotions(
        p_org_id, p_variant_id, b.list_price, coalesce(p_qty, 1), p_at_time,
        app.promotion_candidates(p_org_id)
      ) a
  )
  select round((b.list_price - coalesce(p.discount, 0)) / nullif(coalesce(p_qty, 1), 0), 4),
         b.list_price,
         coalesce(p.discount, 0),
         b.price_list_id,
         p.promotion_id,
         b.currency
    from base b
    left join promo p on true;
$$;

comment on function app.get_price(uuid, uuid, uuid, timestamptz, numeric) is
  'Effective unit price for a variant: group price list (else retail), then promotions by priority.';

-- ---------------------------------------------------------------------------
-- Batch price resolution: one round trip for a whole cart. Candidates are supplied by the caller,
-- so the cached path passes the Redis copy and the SQL path passes app.promotion_candidates.
-- ---------------------------------------------------------------------------
create or replace function app.get_prices(
  p_org_id      uuid,
  p_group_id    uuid,
  p_variant_ids uuid[],
  p_qtys        numeric[],
  p_at_time     timestamptz,
  p_candidates  jsonb
)
returns table (
  variant_id           uuid,
  unit_price           numeric,
  list_price           numeric,
  discount             numeric,
  source_price_list_id uuid,
  source_promotion_id  uuid,
  currency             text
)
language sql
stable
security invoker
as $$
  with input as (
    select v as variant_id, coalesce(q, 1) as qty, ord
      from unnest(p_variant_ids, p_qtys) with ordinality as t(v, q, ord)
  ),
  candidate_lists as (
    select g.price_list_id, 1 as priority
      from public.customer_groups g
     where g.org_id = p_org_id
       and g.id = p_group_id
       and g.price_list_id is not null
    union all
    select pl.id, 2
      from public.price_lists pl
     where pl.org_id = p_org_id
       and pl.kind = 'retail'
       and pl.is_active
  ),
  base as (
    select i.variant_id, i.qty, i.ord, it.price, it.price_list_id, pl.currency
      from input i
      cross join lateral (
        select it.price, it.price_list_id
          from candidate_lists cl
          join public.price_list_items it
            on it.org_id = p_org_id
           and it.price_list_id = cl.price_list_id
           and it.variant_id = i.variant_id
         order by cl.priority
         limit 1
      ) it
      join public.price_lists pl on pl.id = it.price_list_id
  )
  select b.variant_id,
         round((b.price - coalesce(a.discount, 0)) / nullif(b.qty, 0), 4),
         b.price,
         coalesce(a.discount, 0),
         b.price_list_id,
         a.promotion_id,
         b.currency
    from base b
    cross join lateral app.apply_promotions(
      p_org_id, b.variant_id, b.price, b.qty, p_at_time, coalesce(p_candidates, '[]'::jsonb)
    ) a
   order by b.ord;
$$;

-- ---------------------------------------------------------------------------
-- Manual discount guard (precedence step 3). A role with no discount_limits row has a limit of
-- zero, so a manual discount is opt-in per role. A discount always needs a reason.
-- ---------------------------------------------------------------------------
create or replace function app.assert_manual_discount(
  p_org_id    uuid,
  p_role      text,
  p_subtotal  numeric,
  p_discount  numeric,
  p_reason    text
)
returns numeric
language plpgsql
stable
security invoker
as $$
declare
  v_max        numeric;
  v_max_amount numeric;
begin
  if p_discount is null or p_discount <= 0 then
    return 0;
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a manual discount requires a reason' using errcode = '23514';
  end if;

  select dl.max_percent into v_max
    from public.discount_limits dl
   where dl.org_id = p_org_id
     and dl.role = p_role;

  v_max := coalesce(v_max, 0);
  v_max_amount := round(coalesce(p_subtotal, 0) * v_max / 100, 4);

  if p_discount > v_max_amount then
    raise exception 'manual discount % exceeds the limit for role % (max % percent = %)',
      p_discount, p_role, v_max, v_max_amount
      using errcode = '23514';
  end if;

  return p_discount;
end;
$$;

-- ---------------------------------------------------------------------------
-- Record a manual discount against an invoice line. Precedence step 3: the guard runs first, so
-- a discount above the role's limit, or one without a reason, never reaches this table.
-- ---------------------------------------------------------------------------
create or replace function app.record_manual_discount(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_invoice_id uuid,
  p_line_no    int,
  p_role       text,
  p_subtotal   numeric,
  p_discount   numeric,
  p_reason     text
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  perform app.assert_manual_discount(p_org_id, p_role, p_subtotal, p_discount, p_reason);

  insert into public.manual_discounts
    (org_id, branch_id, invoice_id, line_no, role, amount, reason)
  values (p_org_id, p_branch_id, p_invoice_id, p_line_no, p_role, p_discount, btrim(p_reason))
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Display-only currency conversion. The sale itself stores the rate it used (invoices.exchange_rate
-- and journal_lines.exchange_rate), so this never feeds posting.
-- ---------------------------------------------------------------------------
create or replace function app.convert_for_display(
  p_org_id uuid,
  p_amount numeric,
  p_from   text,
  p_to     text,
  p_date   date
)
returns numeric
language sql
stable
security invoker
as $$
  select case
           when r_from is null or r_to is null or r_to = 0 then null
           else round(p_amount * r_from / r_to, 4)
         end
    from (
      select app.rate_on(p_org_id, p_from, p_date) as r_from,
             app.rate_on(p_org_id, p_to, p_date)   as r_to
    ) rates;
$$;

grant execute on function app.promotion_candidates(uuid) to authenticated, service_role;
grant execute on function app.apply_promotions(uuid, uuid, numeric, numeric, timestamptz, jsonb)
  to authenticated, service_role;
grant execute on function app.get_price(uuid, uuid, uuid, timestamptz, numeric)
  to authenticated, service_role;
grant execute on function app.get_prices(uuid, uuid, uuid[], numeric[], timestamptz, jsonb)
  to authenticated, service_role;
grant execute on function app.assert_manual_discount(uuid, text, numeric, numeric, text)
  to authenticated, service_role;
grant execute on function app.record_manual_discount(uuid, uuid, uuid, int, text, numeric, numeric, text)
  to authenticated, service_role;
grant execute on function app.convert_for_display(uuid, numeric, text, text, date)
  to authenticated, service_role;
