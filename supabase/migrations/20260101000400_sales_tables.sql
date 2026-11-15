-- M1/M4: sales, purchasing and audit tables.
--
-- contacts, purchase_orders               -> org scoped
-- sales_orders, invoices, invoice_lines,
-- payments, credit_notes, audit_logs       -> branch scoped
--
-- audit_logs is partitioned monthly on created_at and is append-only.

create table public.contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  kind       text not null,
  name       text not null,
  email      text,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_kind_check check (kind in ('customer', 'supplier', 'both'))
);

create table public.sales_orders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  contact_id  uuid references public.contacts (id) on delete restrict,
  status      text not null default 'draft',
  total       numeric(19, 4) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint sales_orders_status_check check (status in ('draft', 'confirmed', 'invoiced', 'cancelled')),
  constraint sales_orders_total_check check (total >= 0)
);

create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  branch_id      uuid not null references public.branches (id) on delete restrict,
  contact_id     uuid references public.contacts (id) on delete restrict,
  sales_order_id uuid references public.sales_orders (id) on delete set null,
  invoice_no     text not null,
  invoice_date   date not null,
  currency       text not null default 'USD',
  exchange_rate  numeric(19, 10) not null default 1,
  subtotal       numeric(19, 4) not null default 0,
  tax_total      numeric(19, 4) not null default 0,
  total          numeric(19, 4) not null default 0,
  amount_paid    numeric(19, 4) not null default 0,
  journal_id     uuid,
  journal_created_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint invoices_org_no_key unique (org_id, invoice_no),
  constraint invoices_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint invoices_totals_check check (subtotal >= 0 and tax_total >= 0 and total >= 0),
  constraint invoices_paid_check check (amount_paid >= 0),
  constraint invoices_journal_pair_check check ((journal_id is null) = (journal_created_at is null)),
  constraint invoices_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

create table public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete restrict,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  invoice_id    uuid not null references public.invoices (id) on delete cascade,
  line_no       int not null,
  product_id    uuid not null references public.products (id) on delete restrict,
  variant_id    uuid references public.product_variants (id) on delete restrict,
  warehouse_id  uuid not null references public.warehouses (id) on delete restrict,
  description   text,
  qty           numeric(19, 4) not null,
  unit_price    numeric(19, 4) not null,
  unit_cost     numeric(19, 4) not null default 0,
  discount      numeric(19, 4) not null default 0,
  tax_rate_id   uuid references public.tax_rates (id) on delete restrict,
  -- the rate this line actually used; never recomputed later
  tax_rate      numeric(9, 6) not null default 0,
  line_subtotal numeric(19, 4) not null default 0,
  line_tax      numeric(19, 4) not null default 0,
  line_total    numeric(19, 4) not null default 0,
  created_at    timestamptz not null default now(),
  constraint invoice_lines_qty_check check (qty > 0),
  constraint invoice_lines_price_check check (unit_price >= 0 and discount >= 0),
  constraint invoice_lines_invoice_line_key unique (invoice_id, line_no)
);

create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete restrict,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  contact_id    uuid references public.contacts (id) on delete restrict,
  invoice_id    uuid references public.invoices (id) on delete restrict,
  amount        numeric(19, 4) not null,
  currency      text not null default 'USD',
  exchange_rate numeric(19, 10) not null default 1,
  method        text not null default 'bank',
  paid_at       timestamptz not null default now(),
  journal_id    uuid,
  journal_created_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint payments_amount_check check (amount > 0),
  constraint payments_currency_check check (currency in ('USD', 'ZAR', 'ZWG')),
  constraint payments_journal_pair_check check ((journal_id is null) = (journal_created_at is null)),
  constraint payments_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

create table public.credit_notes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete restrict,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  invoice_id    uuid references public.invoices (id) on delete restrict,
  credit_no     text not null,
  reason        text,
  total         numeric(19, 4) not null default 0,
  journal_id    uuid,
  journal_created_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint credit_notes_org_no_key unique (org_id, credit_no),
  constraint credit_notes_total_check check (total >= 0),
  constraint credit_notes_journal_pair_check check ((journal_id is null) = (journal_created_at is null)),
  constraint credit_notes_journal_fkey
    foreign key (journal_id, journal_created_at)
    references public.journals (id, created_at) on delete restrict
);

create table public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  contact_id   uuid references public.contacts (id) on delete restrict,
  po_no        text not null,
  status       text not null default 'draft',
  total        numeric(19, 4) not null default 0,
  expected_date date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint purchase_orders_org_no_key unique (org_id, po_no),
  constraint purchase_orders_status_check
    check (status in ('draft', 'ordered', 'received', 'cancelled')),
  constraint purchase_orders_total_check check (total >= 0)
);

create table public.audit_logs (
  id          uuid not null default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  branch_id   uuid references public.branches (id) on delete restrict,
  table_name  text not null,
  record_id   uuid,
  action      text not null,
  actor_id    uuid,
  diff        jsonb,
  created_at  timestamptz not null default now(),
  primary key (id, created_at),
  constraint audit_logs_action_check check (action in ('insert', 'update', 'delete'))
) partition by range (created_at);

create trigger contacts_set_updated_at before update on public.contacts
  for each row execute function app.set_updated_at();
create trigger sales_orders_set_updated_at before update on public.sales_orders
  for each row execute function app.set_updated_at();
create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();
create trigger payments_set_updated_at before update on public.payments
  for each row execute function app.set_updated_at();
create trigger credit_notes_set_updated_at before update on public.credit_notes
  for each row execute function app.set_updated_at();
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function app.set_updated_at();
