-- Bootstrap a plain PostgreSQL 17 cluster so the Supabase-shaped migrations apply unchanged.
--
-- This is a local test-environment shim only. It creates the pieces the migrations expect from a
-- real Supabase project: the `anon`, `authenticated` and `service_role` roles, the `auth` schema
-- with `auth.uid()` / `auth.jwt()` / `auth.users`, and the `extensions` schema. It is idempotent
-- and is run once before `supabase db reset`-equivalent migrations.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists extensions;

-- A real Supabase project grants the API roles usage on `public` and on every new object created
-- there (auto_expose_new_tables). Mirror that so the migrations' own GRANTs are sufficient.
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant usage on schema extensions to anon, authenticated, service_role, postgres;
grant all on schema auth to supabase_auth_admin;

-- The minimal auth.users table the migrations reference. A real project has many more columns.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);
alter table auth.users owner to supabase_auth_admin;

-- auth.uid(): the request's subject, read from the same GUC PostgREST sets.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

-- auth.jwt(): the request's full claims object.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
