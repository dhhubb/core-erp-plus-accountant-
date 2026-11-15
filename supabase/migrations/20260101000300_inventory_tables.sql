-- M1/M3: inventory tables.
--
-- products, product_variants                             -> org scoped
-- warehouses, stock_ledger, stock_consumptions,
-- stock_balances, stock_layer_balances, stock_transfers   -> branch scoped
--
-- stock_ledger and stock_consumptions are append-only and partitioned monthly on created_at.
-- stock_balances and stock_layer_balances are mutable caches; both can be rebuilt from the
-- immutable ledger.

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  sku        text not null,
  name       text not null,
  uom        text not null default 'ea',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_org_sku_key unique (org_id, sku)
);

create table public.product_variants (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  sku        text not null,
  name       text not null,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_org_sku_key unique (org_id, sku)
);

create table public.warehouses (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  branch_id            uuid not null references public.branches (id) on delete restrict,
  code                 text not null,
  name                 text not null,
  -- Negative stock is rejected by default; a warehouse setting can allow it.
  allow_negative_stock boolean not null default false,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint warehouses_org_branch_code_key unique (org_id, branch_id, code)
);

-- Append-only movement log. An inbound row (direction 'in') is a FIFO layer.
create table public.stock_ledger (
  id           uuid not null default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  variant_id   uuid references public.product_variants (id) on delete restrict,
  direction    text not null,
  qty          numeric(19, 4) not null,
  unit_cost    numeric(19, 4) not null default 0,
  source_type  text not null,
  source_id    uuid,
  memo         text,
  created_at   timestamptz not null default now(),
  primary key (id, created_at),
  constraint stock_ledger_direction_check check (direction in ('in', 'out')),
  constraint stock_ledger_qty_check check (qty > 0),
  constraint stock_ledger_unit_cost_check check (unit_cost >= 0),
  constraint stock_ledger_source_type_check
    check (source_type in ('receipt', 'sale', 'adjustment', 'transfer', 'credit_note', 'opening'))
) partition by range (created_at);

-- Append-only record of which inbound layer each outbound movement consumed, and how much.
-- Neither the layer nor the consumption is ever updated.
create table public.stock_consumptions (
  id                    uuid not null default gen_random_uuid(),
  org_id                uuid not null references public.organizations (id) on delete restrict,
  branch_id             uuid not null references public.branches (id) on delete restrict,
  warehouse_id          uuid not null references public.warehouses (id) on delete restrict,
  product_id            uuid not null references public.products (id) on delete restrict,
  variant_id            uuid references public.product_variants (id) on delete restrict,
  -- the outbound movement
  out_ledger_id         uuid not null,
  out_ledger_created_at timestamptz not null,
  -- the inbound layer it consumed
  in_ledger_id          uuid not null,
  in_ledger_created_at  timestamptz not null,
  qty                   numeric(19, 4) not null,
  unit_cost             numeric(19, 4) not null,
  created_at            timestamptz not null default now(),
  primary key (id, created_at),
  constraint stock_consumptions_qty_check check (qty > 0),
  constraint stock_consumptions_unit_cost_check check (unit_cost >= 0),
  constraint stock_consumptions_out_fkey
    foreign key (out_ledger_id, out_ledger_created_at)
    references public.stock_ledger (id, created_at) on delete restrict,
  constraint stock_consumptions_in_fkey
    foreign key (in_ledger_id, in_ledger_created_at)
    references public.stock_ledger (id, created_at) on delete restrict
) partition by range (created_at);

-- Mutable cache: on-hand quantity and value per warehouse/product. Rebuildable from stock_ledger.
create table public.stock_balances (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  variant_id   uuid references public.product_variants (id) on delete restrict,
  qty          numeric(19, 4) not null default 0,
  value        numeric(19, 4) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- One balance row per warehouse/product/variant. NULLS NOT DISTINCT so the variant-less case is
-- covered by the same uniqueness rule.
create unique index stock_balances_key
  on public.stock_balances (org_id, warehouse_id, product_id, variant_id) nulls not distinct;

-- Mutable cache: remaining quantity per inbound layer. Rebuildable from stock_ledger minus
-- stock_consumptions.
create table public.stock_layer_balances (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  branch_id            uuid not null references public.branches (id) on delete restrict,
  warehouse_id         uuid not null references public.warehouses (id) on delete restrict,
  product_id           uuid not null references public.products (id) on delete restrict,
  variant_id           uuid references public.product_variants (id) on delete restrict,
  in_ledger_id         uuid not null,
  in_ledger_created_at timestamptz not null,
  unit_cost            numeric(19, 4) not null,
  qty_remaining        numeric(19, 4) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint stock_layer_balances_qty_check check (qty_remaining >= 0),
  constraint stock_layer_balances_in_fkey
    foreign key (in_ledger_id, in_ledger_created_at)
    references public.stock_ledger (id, created_at) on delete restrict
);
create unique index stock_layer_balances_key
  on public.stock_layer_balances (in_ledger_id, in_ledger_created_at);

create table public.stock_transfers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  branch_id         uuid not null references public.branches (id) on delete restrict,
  from_warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  to_warehouse_id   uuid not null references public.warehouses (id) on delete restrict,
  product_id        uuid not null references public.products (id) on delete restrict,
  variant_id        uuid references public.product_variants (id) on delete restrict,
  qty               numeric(19, 4) not null,
  status            text not null default 'draft',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint stock_transfers_qty_check check (qty > 0),
  constraint stock_transfers_status_check check (status in ('draft', 'posted', 'cancelled')),
  constraint stock_transfers_warehouses_check check (from_warehouse_id <> to_warehouse_id)
);

create trigger products_set_updated_at before update on public.products
  for each row execute function app.set_updated_at();
create trigger product_variants_set_updated_at before update on public.product_variants
  for each row execute function app.set_updated_at();
create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function app.set_updated_at();
create trigger stock_balances_set_updated_at before update on public.stock_balances
  for each row execute function app.set_updated_at();
create trigger stock_layer_balances_set_updated_at before update on public.stock_layer_balances
  for each row execute function app.set_updated_at();
create trigger stock_transfers_set_updated_at before update on public.stock_transfers
  for each row execute function app.set_updated_at();
