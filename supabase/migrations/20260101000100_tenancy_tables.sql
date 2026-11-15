-- M1: tenancy tables.
--
-- Every tenant table: org_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now().
-- organizations is org-scoped; its id *is* the org id, and org_id is a generated alias so the
-- "every tenant table has org_id" invariant holds literally.

create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  -- organizations is org-scoped: its id *is* the org id. org_id is kept as a real NOT NULL
  -- column (set from id by the trigger below) so the "every tenant table has org_id" invariant
  -- holds literally for RLS and the schema checks.
  org_id        uuid not null,
  name          text not null,
  slug          text not null,
  base_currency text not null default 'USD',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint organizations_org_id_key unique (org_id),
  constraint organizations_base_currency_check check (base_currency in ('USD', 'ZAR', 'ZWG')),
  constraint organizations_slug_key unique (slug)
);
comment on column public.organizations.org_id is
  'Alias of id: organizations is org-scoped and its id is the org id.';

create or replace function app.set_org_id_from_id()
returns trigger
language plpgsql
as $$
begin
  new.org_id := new.id;
  return new;
end;
$$;

create trigger organizations_set_org_id before insert on public.organizations
  for each row execute function app.set_org_id_from_id();

create table public.branches (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete restrict,
  name       text not null,
  slug       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_org_slug_key unique (org_id, slug)
);

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'member',
  -- Branches this member may read. Org membership with an empty array sees no branch rows.
  branch_ids uuid[] not null default '{}'::uuid[],
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_role_check check (role in ('owner', 'admin', 'member')),
  constraint memberships_org_user_key unique (org_id, user_id)
);

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  email       text not null,
  role        text not null default 'member',
  branch_ids  uuid[] not null default '{}'::uuid[],
  -- Only a hash of the invite token is stored. Single use, expires after 72 hours.
  token_hash  text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint invites_role_check check (role in ('owner', 'admin', 'member')),
  constraint invites_token_hash_key unique (token_hash)
);

create table public.settings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null unique references public.organizations (id) on delete cascade,
  base_currency         text not null default 'USD',
  -- Residual after per-line rounding is posted here. Never dropped silently.
  rounding_account_code text not null default '6999',
  allow_negative_stock  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint settings_base_currency_check check (base_currency in ('USD', 'ZAR', 'ZWG'))
);

create table public.number_series (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  code       text not null,
  prefix     text not null default '',
  suffix     text,
  pad_width  int not null default 6,
  next_value bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint number_series_org_code_key unique (org_id, code),
  constraint number_series_pad_width_check check (pad_width between 1 and 12),
  constraint number_series_next_value_check check (next_value >= 1)
);

create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function app.set_updated_at();
create trigger branches_set_updated_at before update on public.branches
  for each row execute function app.set_updated_at();
create trigger memberships_set_updated_at before update on public.memberships
  for each row execute function app.set_updated_at();
create trigger invites_set_updated_at before update on public.invites
  for each row execute function app.set_updated_at();
create trigger settings_set_updated_at before update on public.settings
  for each row execute function app.set_updated_at();
create trigger number_series_set_updated_at before update on public.number_series
  for each row execute function app.set_updated_at();
