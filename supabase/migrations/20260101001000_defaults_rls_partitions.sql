-- M1: per-organisation defaults, RLS for every tenant table, immutability, partitions, audit.

-- ---------------------------------------------------------------------------
-- Per-organisation defaults, created when an organisation row is inserted.
-- ---------------------------------------------------------------------------
create or replace function app.create_default_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.settings (org_id, base_currency)
  values (new.id, new.base_currency)
  on conflict (org_id) do nothing;
  return new;
end;
$$;

create or replace function app.create_default_number_series()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.number_series (org_id, code, prefix, pad_width) values
    (new.id, 'INVOICE',     '',     6),
    (new.id, 'CREDIT_NOTE', 'CN-',  6),
    (new.id, 'SKU',         'SKU-', 8),
    (new.id, 'PO',          'PO-',  6)
  on conflict (org_id, code) do nothing;
  return new;
end;
$$;

create or replace function app.create_default_accounts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.chart_of_accounts (org_id, code, name, account_type) values
    (new.id, '1000', 'Inventory',            'asset'),
    (new.id, '1100', 'Accounts Receivable',  'asset'),
    (new.id, '1200', 'Bank',                 'asset'),
    (new.id, '2000', 'Accounts Payable',     'liability'),
    (new.id, '2100', 'VAT Output',           'liability'),
    (new.id, '2200', 'VAT Input',            'asset'),
    (new.id, '3000', 'Retained Earnings',    'equity'),
    (new.id, '4000', 'Sales Revenue',        'revenue'),
    (new.id, '5000', 'Cost of Goods Sold',   'expense'),
    (new.id, '6999', 'Rounding Differences', 'expense')
  on conflict (org_id, code) do nothing;

  -- VAT is seeded with the current rate only. The rate is to be confirmed (see docs/ADR.md).
  insert into public.tax_rates (org_id, code, name, rate, effective_from, effective_to)
  values (new.id, 'VAT15', 'VAT 15% (to be confirmed)', 0.150000, date '2020-01-01', null)
  on conflict (org_id, code, effective_from) do nothing;

  -- Base-currency exchange rate rows (rate 1) keep lookups uniform.
  insert into public.exchange_rates (org_id, currency, rate, effective_from)
  values (new.id, 'USD', 1.0000000000, date '2020-01-01')
  on conflict (org_id, currency, effective_from) do nothing;

  return new;
end;
$$;

create trigger organizations_create_settings
  after insert on public.organizations
  for each row execute function app.create_default_settings();
create trigger organizations_create_number_series
  after insert on public.organizations
  for each row execute function app.create_default_number_series();
create trigger organizations_create_accounts
  after insert on public.organizations
  for each row execute function app.create_default_accounts();

-- Create an organisation with all defaults. Used by application code and by tests.
create or replace function app.create_org(p_name text, p_slug text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_slug   text := coalesce(p_slug, lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
begin
  insert into public.organizations (name, slug)
  values (p_name, v_slug)
  returning id into v_org_id;
  return v_org_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Generic audit trigger. Writes audit_logs for invoices, payments, journals, products and
-- stock adjustments. Nothing on a request path reads it.
-- ---------------------------------------------------------------------------
create or replace function app.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row     jsonb;
  v_org_id  uuid;
  v_branch  uuid;
  v_rec_id  uuid;
  v_table   text := tg_table_name;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_org_id := nullif(v_row ->> 'org_id', '')::uuid;
  v_branch := nullif(v_row ->> 'branch_id', '')::uuid;
  v_rec_id := nullif(v_row ->> 'id', '')::uuid;

  -- tg_table_name is the partition on a partitioned table. Record the logical parent so audit rows
  -- do not vary by month. A non-partitioned table has no pg_inherits row, so the name is unchanged.
  v_table := coalesce(
    (select p.relname
       from pg_inherits i
       join pg_class p on p.oid = i.inhparent
      where i.inhrelid = tg_relid),
    tg_table_name
  );

  insert into public.audit_logs (org_id, branch_id, table_name, record_id, action, actor_id, diff)
  values (v_org_id, v_branch, v_table, v_rec_id, lower(tg_op), auth.uid(), v_row);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger invoices_audit
  after insert or update or delete on public.invoices
  for each row execute function app.write_audit_log();
create trigger payments_audit
  after insert or update or delete on public.payments
  for each row execute function app.write_audit_log();
create trigger journals_audit
  after insert on public.journals
  for each row execute function app.write_audit_log();
create trigger products_audit
  after insert or update or delete on public.products
  for each row execute function app.write_audit_log();
create trigger stock_ledger_audit
  after insert on public.stock_ledger
  for each row execute function app.write_audit_log();

-- ---------------------------------------------------------------------------
-- RLS. Org-scoped tables use app.has_org_access(org_id); branch-scoped tables use
-- app.has_branch_access(org_id, branch_id).
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.branches', 'org');
select app.apply_tenant_rls('public.memberships', 'org');
select app.apply_tenant_rls('public.invites', 'org');
select app.apply_tenant_rls('public.number_series', 'org');
select app.apply_tenant_rls('public.products', 'org');
select app.apply_tenant_rls('public.product_variants', 'org');
select app.apply_tenant_rls('public.contacts', 'org');
select app.apply_tenant_rls('public.chart_of_accounts', 'org');
select app.apply_tenant_rls('public.fiscal_periods', 'org');
select app.apply_tenant_rls('public.tax_rates', 'org');
select app.apply_tenant_rls('public.exchange_rates', 'org');
select app.apply_tenant_rls('public.purchase_orders', 'branch');

select app.apply_tenant_rls('public.warehouses', 'branch');
select app.apply_tenant_rls('public.stock_ledger', 'branch');
select app.apply_tenant_rls('public.stock_consumptions', 'branch');
select app.apply_tenant_rls('public.stock_balances', 'branch');
select app.apply_tenant_rls('public.stock_layer_balances', 'branch');
select app.apply_tenant_rls('public.stock_transfers', 'branch');
select app.apply_tenant_rls('public.journals', 'branch');
select app.apply_tenant_rls('public.journal_lines', 'branch');
select app.apply_tenant_rls('public.sales_orders', 'branch');
select app.apply_tenant_rls('public.invoices', 'branch');
select app.apply_tenant_rls('public.invoice_lines', 'branch');
select app.apply_tenant_rls('public.payments', 'branch');
select app.apply_tenant_rls('public.credit_notes', 'branch');
select app.apply_tenant_rls('public.audit_logs', 'branch');

-- organizations and settings are org-scoped with bespoke policies.
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select using (app.has_org_access(id));
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update using (app.has_org_access(id)) with check (app.has_org_access(id));
grant select, update on public.organizations to authenticated;

alter table public.settings enable row level security;
alter table public.settings force row level security;
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings
  for select using (app.has_org_access(org_id));
drop policy if exists settings_insert on public.settings;
create policy settings_insert on public.settings
  for insert with check (app.has_org_access(org_id));
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings
  for update using (app.has_org_access(org_id)) with check (app.has_org_access(org_id));
grant select, insert, update on public.settings to authenticated;

-- ---------------------------------------------------------------------------
-- Immutability. Ledger tables are append-only.
-- ---------------------------------------------------------------------------
select app.enforce_immutable('public.journals');
select app.enforce_immutable('public.journal_lines');
select app.enforce_immutable('public.stock_ledger');
select app.enforce_immutable('public.stock_consumptions');
select app.enforce_immutable('public.audit_logs');

-- These tables are written only by the SECURITY DEFINER posting functions, so INSERT is revoked
-- from authenticated as well as UPDATE and DELETE.
revoke insert, update, delete on public.journal_lines from authenticated;
revoke insert, update, delete on public.stock_consumptions from authenticated;
revoke insert, update, delete on public.audit_logs from authenticated;

-- ---------------------------------------------------------------------------
-- Partitions for the current month and the next two months.
-- ---------------------------------------------------------------------------
select app.ensure_partitions(2);
