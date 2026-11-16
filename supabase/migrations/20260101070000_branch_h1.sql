-- H1: Branch server foundation (Retail).
--
-- Additive only. Nothing here edits an applied migration or a core accounting path. A branch runs
-- the SAME migrations as CORE and Retail; this file adds only the branch-only tables and the local
-- PIN / device / sync functions a branch server needs when it has no internet.
--
-- Adds:
--   * public.device_registrations  (org + branch; a one-time code that mints a device token)
--   * public.cashier_pins          (org + branch; a HASHED cashier PIN, lockout state, manager flag)
--   * public.sync_state            (org + branch; the sync protocol version and push/pull cursor)
--
--   * app.hash_secret(...)                 — sha256 hex, for codes and device tokens
--   * app.create_device_registration(...)  — mints a one-time code, stores only its hash
--   * app.register_device(...)             — redeems the code once, returns a device token
--   * app.authenticate_device(...)         — verifies a device token (hash comparison)
--   * app.set_cashier_pin(...)             — stores a bcrypt PIN hash, never the PIN
--   * app.authenticate_cashier(...)        — verifies a PIN; locks after 5 wrong attempts
--   * app.manager_override(...)            — a manager PIN authorises an override
--   * app.branch_sync_state(...)           — the branch's protocol version and cursors
--   * app.branch_protocol_version()        — the branch's sync protocol version (constant)
--
-- Design notes (ADR-0023, ADR-0024, ADR-0025):
--   * PINs are hashed with bcrypt (extensions.crypt + gen_salt('bf')). No plaintext is stored, ever.
--   * A device registration code is single use and expires; only the hash of the code and the hash
--     of the issued device token are stored, exactly like an invite token (ADR-0024).
--   * The branch and the cloud carry a sync protocol version. A branch refuses to push to a cloud
--     whose version it does not understand, and shows a warning (ADR-0025).
--   * These tables are mutable by design (a code is consumed, a PIN is locked, a cursor advances),
--     so they are NOT immutable, unlike the ledger.

-- ---------------------------------------------------------------------------
-- Device registrations. A till enters a one-time code once and receives a device token. Only the
-- hash of the code and the hash of the token are stored; the raw values exist only in the response.
-- ---------------------------------------------------------------------------
create table public.device_registrations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  branch_id         uuid not null references public.branches (id) on delete restrict,
  till_id           text not null,
  label             text,
  -- Only a hash of the one-time code is stored. Single use, expires.
  code_hash         text not null,
  code_expires_at   timestamptz not null,
  consumed_at       timestamptz,
  -- Only a hash of the issued device token is stored. Set when the code is redeemed.
  device_token_hash text,
  token_issued_at   timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint device_registrations_code_key unique (code_hash),
  constraint device_registrations_token_key unique (device_token_hash)
);

create index device_registrations_org_branch_created_idx
  on public.device_registrations (org_id, branch_id, created_at desc, id desc);
create index device_registrations_org_created_idx
  on public.device_registrations (org_id, created_at desc, id desc);
create index device_registrations_branch_id_idx on public.device_registrations (branch_id);
create index device_registrations_till_idx
  on public.device_registrations (org_id, branch_id, till_id);

-- ---------------------------------------------------------------------------
-- Cashier PINs. A cashier signs in to the branch with a PIN; the branch verifies it locally, so a
-- sign-in works with the internet off. The PIN is stored as a bcrypt hash. Five wrong attempts lock
-- the PIN for a cooling-off window. A manager (is_manager) PIN authorises an override.
-- ---------------------------------------------------------------------------
create table public.cashier_pins (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  branch_id       uuid not null references public.branches (id) on delete restrict,
  cashier_id      uuid not null references auth.users (id) on delete cascade,
  -- bcrypt hash. The plaintext PIN is never stored.
  pin_hash        text not null,
  is_manager      boolean not null default false,
  is_active       boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint cashier_pins_attempts_check check (failed_attempts >= 0),
  constraint cashier_pins_cashier_key unique (org_id, branch_id, cashier_id)
);

create index cashier_pins_org_branch_created_idx
  on public.cashier_pins (org_id, branch_id, created_at desc, id desc);
create index cashier_pins_org_created_idx
  on public.cashier_pins (org_id, created_at desc, id desc);
create index cashier_pins_branch_id_idx on public.cashier_pins (branch_id);
create index cashier_pins_cashier_id_idx on public.cashier_pins (cashier_id);

-- ---------------------------------------------------------------------------
-- Sync state. One row per branch. It carries the sync protocol version (ADR-0025) and the branch's
-- push/pull cursors. Decision 4 gives every event a per-branch sequence number; last_pushed_seq is
-- the highest sequence the cloud has acknowledged.
-- ---------------------------------------------------------------------------
create table public.sync_state (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  branch_id            uuid not null references public.branches (id) on delete restrict,
  protocol_version     int not null default 1,
  last_pushed_seq      bigint not null default 0,
  last_pulled_cursor   text,
  cloud_status         text not null default 'unknown',
  cloud_protocol_version int,
  last_cloud_contact_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sync_state_seq_check check (last_pushed_seq >= 0),
  constraint sync_state_cloud_status_check
    check (cloud_status in ('unknown', 'online', 'offline', 'incompatible')),
  constraint sync_state_branch_key unique (org_id, branch_id)
);

create index sync_state_org_branch_created_idx
  on public.sync_state (org_id, branch_id, created_at desc, id desc);
create index sync_state_org_created_idx
  on public.sync_state (org_id, created_at desc, id desc);
create index sync_state_branch_id_idx on public.sync_state (branch_id);

select app.apply_tenant_rls('public.device_registrations', 'branch');
select app.apply_tenant_rls('public.cashier_pins', 'branch');
select app.apply_tenant_rls('public.sync_state', 'branch');

create trigger device_registrations_set_updated_at
  before update on public.device_registrations
  for each row execute function app.set_updated_at();
create trigger cashier_pins_set_updated_at
  before update on public.cashier_pins
  for each row execute function app.set_updated_at();
create trigger sync_state_set_updated_at
  before update on public.sync_state
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- A generic secret hash (sha256 hex). Used for one-time codes and device tokens, exactly as
-- app.invite_token_hash hashes an invite token. Never reversible.
-- ---------------------------------------------------------------------------
create or replace function app.hash_secret(p_secret text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(p_secret, 'sha256'), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- The branch's sync protocol version. A constant: bump it only with a migration that also updates
-- the TypeScript constant (src/branch/config.ts) and an ADR.
-- ---------------------------------------------------------------------------
create or replace function app.branch_protocol_version()
returns int
language sql
immutable
as $$
  select 1;
$$;

-- ---------------------------------------------------------------------------
-- Mint a one-time device registration code. Generates the raw code, stores only its hash, and
-- returns the raw code once. It expires after p_ttl_hours (24 by default).
-- ---------------------------------------------------------------------------
create or replace function app.create_device_registration(
  p_org_id    uuid,
  p_branch_id uuid,
  p_till_id   text,
  p_ttl_hours int default 24
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(encode(extensions.gen_random_bytes(8), 'hex'));
begin
  insert into public.device_registrations
    (org_id, branch_id, till_id, code_hash, code_expires_at)
  values (p_org_id, p_branch_id, p_till_id,
          app.hash_secret(v_code),
          now() + make_interval(hours => p_ttl_hours));
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redeem a one-time code and issue a device token. Single use: the code is consumed and only the
-- hash of the issued token is stored. A consumed, expired or unknown code is rejected.
-- ---------------------------------------------------------------------------
create or replace function app.register_device(
  p_org_id    uuid,
  p_branch_id uuid,
  p_code      text,
  p_label     text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.device_registrations%rowtype;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select * into v_row
    from public.device_registrations
   where org_id = p_org_id
     and branch_id = p_branch_id
     and code_hash = app.hash_secret(p_code)
   for update;

  if not found then
    raise exception 'device registration code is invalid' using errcode = '22023';
  end if;
  if v_row.consumed_at is not null then
    raise exception 'device registration code has already been used' using errcode = '22023';
  end if;
  if v_row.code_expires_at <= now() then
    raise exception 'device registration code has expired' using errcode = '22023';
  end if;

  update public.device_registrations
     set consumed_at       = now(),
         device_token_hash = app.hash_secret(v_token),
         token_issued_at   = now(),
         label             = coalesce(p_label, label)
   where id = v_row.id;

  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verify a device token. Returns the registration id, or raises when the token is unknown or the
-- device has been revoked. The comparison is on the hash, so the raw token is never stored.
-- ---------------------------------------------------------------------------
create or replace function app.authenticate_device(
  p_org_id    uuid,
  p_branch_id uuid,
  p_token     text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.device_registrations
   where org_id = p_org_id
     and branch_id = p_branch_id
     and device_token_hash = app.hash_secret(p_token)
     and revoked_at is null;

  if v_id is null then
    raise exception 'device token is invalid' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Set (or reset) a cashier PIN. The PIN is hashed with bcrypt; the plaintext is never stored. A
-- reset clears any lockout. is_manager marks a manager PIN, which can authorise an override.
-- ---------------------------------------------------------------------------
create or replace function app.set_cashier_pin(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_cashier_id uuid,
  p_pin        text,
  p_is_manager boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_pin is null or length(p_pin) < 4 then
    raise exception 'PIN must be at least 4 characters' using errcode = '22023';
  end if;

  insert into public.cashier_pins
    (org_id, branch_id, cashier_id, pin_hash, is_manager, failed_attempts, locked_until)
  values (p_org_id, p_branch_id, p_cashier_id,
          extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
          coalesce(p_is_manager, false), 0, null)
  on conflict (org_id, branch_id, cashier_id) do update
    set pin_hash        = excluded.pin_hash,
        is_manager      = excluded.is_manager,
        failed_attempts = 0,
        locked_until    = null,
        is_active       = true
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verify a cashier PIN. Works entirely locally, so a sign-in needs no internet. Five wrong attempts
-- lock the PIN for a cooling-off window. Returns the outcome as jsonb rather than raising, so a
-- caller can show "wrong PIN" and "locked" distinctly. The row is locked FOR UPDATE, so two tills
-- cannot race the attempt counter.
-- ---------------------------------------------------------------------------
create or replace function app.authenticate_cashier(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_cashier_id uuid,
  p_pin        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row          public.cashier_pins%rowtype;
  v_ok           boolean;
  v_attempts     int;
  v_locked_until timestamptz;
begin
  select * into v_row
    from public.cashier_pins
   where org_id = p_org_id
     and branch_id = p_branch_id
     and cashier_id = p_cashier_id
   for update;

  if not found then
    raise exception 'cashier PIN is not set' using errcode = '22023';
  end if;
  if not v_row.is_active then
    raise exception 'cashier is inactive' using errcode = '22023';
  end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'locked', true,
      'failed_attempts', v_row.failed_attempts,
      'locked_until', v_row.locked_until,
      'is_manager', v_row.is_manager
    );
  end if;

  v_ok := extensions.crypt(p_pin, v_row.pin_hash) = v_row.pin_hash;

  if v_ok then
    update public.cashier_pins
       set failed_attempts = 0,
           locked_until    = null,
           last_login_at   = now()
     where id = v_row.id;
    return jsonb_build_object(
      'ok', true, 'locked', false, 'failed_attempts', 0,
      'is_manager', v_row.is_manager, 'cashier_id', v_row.cashier_id
    );
  end if;

  v_attempts := v_row.failed_attempts + 1;
  if v_attempts >= 5 then
    v_locked_until := now() + interval '15 minutes';
    update public.cashier_pins
       set failed_attempts = 0, locked_until = v_locked_until
     where id = v_row.id;
    return jsonb_build_object(
      'ok', false, 'locked', true, 'failed_attempts', 0,
      'locked_until', v_locked_until, 'is_manager', v_row.is_manager
    );
  end if;

  update public.cashier_pins set failed_attempts = v_attempts where id = v_row.id;
  return jsonb_build_object(
    'ok', false, 'locked', false, 'failed_attempts', v_attempts,
    'is_manager', v_row.is_manager
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- A manager override. The override is authorised only by a manager's own PIN, verified locally.
-- Returns true when the PIN belongs to an active manager and is correct; otherwise false. A wrong
-- manager PIN counts against the manager's lockout like any other PIN.
-- ---------------------------------------------------------------------------
create or replace function app.manager_override(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_manager_id uuid,
  p_pin        text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  v_result := app.authenticate_cashier(p_org_id, p_branch_id, p_manager_id, p_pin);
  return coalesce((v_result ->> 'ok')::boolean, false)
     and coalesce((v_result ->> 'is_manager')::boolean, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- The branch's sync state. Ensures a row exists and returns it as jsonb. The branch reads its
-- protocol version and cursors here; the cloud status is a branch observation, not a cloud fact.
-- ---------------------------------------------------------------------------
create or replace function app.branch_sync_state(
  p_org_id    uuid,
  p_branch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sync_state%rowtype;
begin
  insert into public.sync_state (org_id, branch_id, protocol_version)
  values (p_org_id, p_branch_id, app.branch_protocol_version())
  on conflict (org_id, branch_id) do nothing;

  select * into v_row
    from public.sync_state
   where org_id = p_org_id and branch_id = p_branch_id;

  return jsonb_build_object(
    'protocol_version', v_row.protocol_version,
    'last_pushed_seq', v_row.last_pushed_seq,
    'last_pulled_cursor', v_row.last_pulled_cursor,
    'cloud_status', v_row.cloud_status,
    'cloud_protocol_version', v_row.cloud_protocol_version,
    'last_cloud_contact_at', v_row.last_cloud_contact_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Record the outcome of a cloud contact. The branch's observation of the cloud is stored so a
-- health read does not have to reach the cloud. A version mismatch marks the cloud incompatible,
-- and the branch will refuse to push until it is upgraded (ADR-0025).
-- ---------------------------------------------------------------------------
create or replace function app.record_cloud_contact(
  p_org_id          uuid,
  p_branch_id       uuid,
  p_cloud_version   int,
  p_online          boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  v_status := case
    when not p_online then 'offline'
    when p_cloud_version is null then 'online'
    when p_cloud_version <> app.branch_protocol_version() then 'incompatible'
    else 'online'
  end;

  insert into public.sync_state
    (org_id, branch_id, protocol_version, cloud_status, cloud_protocol_version, last_cloud_contact_at)
  values (p_org_id, p_branch_id, app.branch_protocol_version(), v_status, p_cloud_version, now())
  on conflict (org_id, branch_id) do update
    set cloud_status           = excluded.cloud_status,
        cloud_protocol_version = excluded.cloud_protocol_version,
        last_cloud_contact_at  = excluded.last_cloud_contact_at;

  return jsonb_build_object('cloud_status', v_status, 'cloud_protocol_version', p_cloud_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
grant execute on function app.hash_secret(text) to authenticated, service_role;
grant execute on function app.branch_protocol_version() to authenticated, service_role;
grant execute on function app.create_device_registration(uuid, uuid, text, int)
  to authenticated, service_role;
grant execute on function app.register_device(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function app.authenticate_device(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.set_cashier_pin(uuid, uuid, uuid, text, boolean)
  to authenticated, service_role;
grant execute on function app.authenticate_cashier(uuid, uuid, uuid, text)
  to authenticated, service_role;
grant execute on function app.manager_override(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function app.branch_sync_state(uuid, uuid) to authenticated, service_role;
grant execute on function app.record_cloud_contact(uuid, uuid, int, boolean)
  to authenticated, service_role;
