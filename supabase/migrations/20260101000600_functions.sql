-- M1: tenancy helper functions, number series, invite handling and the Supabase custom access
-- token hook.

-- ---------------------------------------------------------------------------
-- Org / branch access predicates used by every RLS policy.
--
-- These read the JWT claims ONLY (auth.jwt() ->> 'org_id', auth.jwt() -> 'branch_ids'). The
-- custom access token hook below builds those claims from public.memberships at token refresh
-- time. Consequence: a membership change is not visible to an existing token; it takes effect on
-- the next refresh. That is the required behaviour and is documented in the README.
-- ---------------------------------------------------------------------------

create or replace function app.has_org_access(p_org_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(p_org_id is not null and p_org_id = app.current_org_id(), false);
$$;

create or replace function app.has_branch_access(p_org_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
           app.has_org_access(p_org_id)
           and p_branch_id is not null
           and p_branch_id = any (app.current_branch_ids()),
         false);
$$;

-- ---------------------------------------------------------------------------
-- Number series: gapless invoice numbers and SKUs.
-- The row is locked with SELECT ... FOR UPDATE inside the caller's transaction. Never a Postgres
-- sequence, and never a per-org sequence.
-- ---------------------------------------------------------------------------
create or replace function app.next_number(p_org_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.number_series%rowtype;
  v_value  bigint;
  v_number text;
begin
  select * into v_row
    from public.number_series
   where org_id = p_org_id
     and code = p_code
     for update;

  if not found then
    raise exception 'number series % not found for org %', p_code, p_org_id
      using errcode = 'no_data_found';
  end if;

  v_value := v_row.next_value;
  v_number := v_row.prefix
              || lpad(v_value::text, v_row.pad_width, '0')
              || coalesce(v_row.suffix, '');

  update public.number_series
     set next_value = v_value + 1
   where org_id = p_org_id
     and code = p_code;

  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invites. Only a hash of the token is stored. Single use, expires after 72 hours.
-- ---------------------------------------------------------------------------
create or replace function app.invite_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function app.current_user_email()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email',
                  (select u.email from auth.users u where u.id = auth.uid()));
$$;

-- Create an invite. Generates the raw token, stores only its hash, returns the raw token once.
create or replace function app.create_invite(
  p_org_id     uuid,
  p_email      text,
  p_role       text default 'member',
  p_branch_ids uuid[] default '{}'::uuid[],
  p_ttl_hours  int default 72
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.invites (org_id, email, role, branch_ids, token_hash, expires_at, created_by)
  values (p_org_id,
          lower(p_email),
          p_role,
          coalesce(p_branch_ids, '{}'::uuid[]),
          app.invite_token_hash(v_token),
          now() + make_interval(hours => p_ttl_hours),
          auth.uid());

  return v_token;
end;
$$;

-- Redeem an invite. Single use; rejects unknown, expired, or already-used tokens.
-- Creates (or reactivates) a membership. Returns the membership id.
create or replace function app.accept_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite     public.invites%rowtype;
  v_membership uuid;
  v_user_id    uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'accept_invite requires an authenticated user' using errcode = '42501';
  end if;

  select * into v_invite
    from public.invites
   where token_hash = app.invite_token_hash(p_token)
     for update;

  if not found then
    raise exception 'invite token is invalid' using errcode = '22023';
  end if;

  if v_invite.used_at is not null then
    raise exception 'invite token has already been used' using errcode = '22023';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite token has expired' using errcode = '22023';
  end if;

  insert into public.memberships (org_id, user_id, role, branch_ids)
  values (v_invite.org_id, v_user_id, v_invite.role, v_invite.branch_ids)
  on conflict (org_id, user_id) do update
    set role       = excluded.role,
        branch_ids = excluded.branch_ids,
        is_active  = true
  returning id into v_membership;

  update public.invites
     set used_at = now()
   where id = v_invite.id;

  return v_membership;
end;
$$;

-- ---------------------------------------------------------------------------
-- Supabase custom access token hook. Adds org_id and branch_ids to the JWT, so membership
-- changes take effect when the token refreshes.
-- ---------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_user_id    uuid := (event ->> 'user_id')::uuid;
  v_claims     jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_membership public.memberships%rowtype;
begin
  select * into v_membership
    from public.memberships
   where user_id = v_user_id
     and is_active
   order by created_at
   limit 1;

  if found then
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_membership.org_id::text), true);
    v_claims := jsonb_set(v_claims, '{branch_ids}', to_jsonb(v_membership.branch_ids), true);
  else
    v_claims := jsonb_set(v_claims, '{org_id}', 'null'::jsonb, true);
    v_claims := jsonb_set(v_claims, '{branch_ids}', '[]'::jsonb, true);
  end if;

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

grant usage on schema app to authenticated, anon, service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Partitioning infrastructure.
--
-- journals, journal_lines, stock_ledger, stock_consumptions and audit_logs are RANGE partitioned
-- monthly on created_at. Their primary keys include created_at, so a child row can carry
-- journal_created_at (or the equivalent) for a composite foreign key to the parent. There are no
-- default partitions: an insert outside the covered range fails loudly rather than landing in a
-- catch-all.
-- ---------------------------------------------------------------------------

-- Create missing monthly partitions for every range-partitioned table in public, for the current
-- month plus p_months_ahead further months. Idempotent.
create or replace function app.ensure_partitions(p_months_ahead int default 2)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent  record;
  v_start   date := date_trunc('month', now())::date;
  v_i       int;
  v_from    date;
  v_to      date;
  v_name    text;
  v_created int := 0;
begin
  if p_months_ahead < 0 then
    raise exception 'p_months_ahead must be >= 0';
  end if;

  for v_parent in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_partitioned_table pt on pt.partrelid = c.oid
     where n.nspname = 'public'
       and c.relkind = 'p'
  loop
    for v_i in 0 .. p_months_ahead loop
      v_from := (v_start + make_interval(months => v_i))::date;
      v_to   := (v_start + make_interval(months => v_i + 1))::date;
      v_name := v_parent.relname || '_' || to_char(v_from, 'YYYYMM');

      if not exists (
        select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = v_name
      ) then
        execute format(
          'create table public.%I partition of public.%I for values from (%L) to (%L)',
          v_name, v_parent.relname, v_from, v_to
        );
        v_created := v_created + 1;
      end if;
    end loop;
  end loop;

  return v_created;
end;
$$;

comment on function app.ensure_partitions(int) is
  'Creates monthly range partitions for every partitioned table in public. Run ahead of time, '
  'e.g. select app.ensure_partitions(2);';

-- ---------------------------------------------------------------------------
-- Immutability guard. Ledger tables are append-only: a correction is a reversing row, never an
-- UPDATE or DELETE.
-- ---------------------------------------------------------------------------
create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'table %.% is append-only; % is not allowed',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- Attaches the immutability trigger and revokes UPDATE/DELETE from the Data API roles. On a
-- partitioned parent the trigger is cloned onto existing and future partitions automatically.
create or replace function app.enforce_immutable(p_table regclass)
returns void
language plpgsql
as $$
declare
  v_table text := p_table::text;
begin
  execute format('drop trigger if exists %I on %s', 'reject_mutation', v_table);
  execute format(
    'create trigger %I before update or delete on %s for each row execute function app.reject_mutation()',
    'reject_mutation', v_table
  );
  execute format('revoke update, delete on %s from authenticated', v_table);
  execute format('revoke update, delete on %s from anon', v_table);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS helper. Applies ENABLE + FORCE ROW LEVEL SECURITY and the standard four policies to a
-- tenant table. FORCE means the table owner (postgres) is also subject to the policies, so a
-- policy bug cannot be hidden by owning the table.
-- ---------------------------------------------------------------------------
create or replace function app.apply_tenant_rls(
  p_table       regclass,
  p_scope       text,     -- 'org' | 'branch'
  p_allow_write boolean default true
)
returns void
language plpgsql
as $$
declare
  v_table text := p_table::text;
  v_name  text := replace(replace(v_table, 'public.', ''), '"', '');
  v_scope_sql text;
begin
  if p_scope not in ('org', 'branch') then
    raise exception 'unknown RLS scope %', p_scope;
  end if;

  v_scope_sql := case p_scope
    when 'org'    then 'app.has_org_access(org_id)'
    else               'app.has_branch_access(org_id, branch_id)'
  end;

  execute format('alter table %s enable row level security', v_table);
  execute format('alter table %s force row level security', v_table);

  execute format('drop policy if exists %I on %s', v_name || '_select', v_table);
  execute format('drop policy if exists %I on %s', v_name || '_insert', v_table);
  execute format('drop policy if exists %I on %s', v_name || '_update', v_table);
  execute format('drop policy if exists %I on %s', v_name || '_delete', v_table);

  execute format('create policy %I on %s for select using (%s)',
                 v_name || '_select', v_table, v_scope_sql);

  if p_allow_write then
    execute format('create policy %I on %s for insert with check (%s)',
                   v_name || '_insert', v_table, v_scope_sql);
    execute format('create policy %I on %s for update using (%s) with check (%s)',
                   v_name || '_update', v_table, v_scope_sql, v_scope_sql);
    execute format('create policy %I on %s for delete using (%s)',
                   v_name || '_delete', v_table, v_scope_sql);
  end if;

  execute format('grant select, insert, update, delete on %s to authenticated', v_table);
end;
$$;

grant execute on function app.ensure_partitions(int) to authenticated, service_role;
