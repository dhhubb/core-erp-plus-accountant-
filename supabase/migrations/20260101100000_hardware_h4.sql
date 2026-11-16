-- H4: Hardware and receipts (printer settings for the till).
--
-- Additive only. Nothing here edits an applied migration or a core table. The only new state is the
-- per-branch printer configuration the till and the branch relay read: whether the till prints
-- through the browser dialog or relays ESC/POS bytes to a network printer on the shop LAN.
--
-- Adds:
--   * public.printer_settings (org + branch; one row per branch)
--
--   * app.set_printer_settings(...) — upsert the branch's printer configuration
--   * app.get_printer_settings(...) — read it (mode, host, port)
--
-- Design notes (ADR-0039):
--   * The settings live in the database, not in the browser, so every till in a branch prints the
--     same way and a re-imaged till needs no setup.
--   * The relay itself is NOT in SQL: a branch server opens the TCP socket to the printer and writes
--     the raw ESC/POS bytes (decision 16, outbound only). The database stores only the destination.

-- ---------------------------------------------------------------------------
-- Per-branch printer configuration. `mode` is 'browser' (the till's window.print) or 'network'
-- (relay ESC/POS bytes to host:port). host/port are only meaningful in network mode.
-- ---------------------------------------------------------------------------
create table public.printer_settings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  mode        text not null default 'browser',
  host        text,
  port        int not null default 9100,
  -- Which physical printer this is, for a branch with more than one (for example a kitchen printer).
  label       text not null default 'default',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint printer_settings_mode_check check (mode in ('browser', 'network')),
  constraint printer_settings_port_check check (port between 1 and 65535),
  -- A network printer must name a host.
  constraint printer_settings_host_check check (mode <> 'network' or (host is not null and host <> '')),
  constraint printer_settings_branch_key unique (org_id, branch_id, label)
);

create index printer_settings_org_branch_created_idx
  on public.printer_settings (org_id, branch_id, created_at desc, id desc);
create index printer_settings_org_created_idx
  on public.printer_settings (org_id, created_at desc, id desc);
create index printer_settings_branch_id_idx on public.printer_settings (branch_id);

create trigger printer_settings_set_updated_at
  before update on public.printer_settings
  for each row execute function app.set_updated_at();

-- Read the branch's printer settings. Returns the default (active) row, or a browser-mode default
-- when the branch has never configured one, so the till always has a printing mode.
create or replace function app.get_printer_settings(
  p_org_id uuid,
  p_branch_id uuid,
  p_label text default 'default'
)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select jsonb_build_object(
              'mode', ps.mode,
              'host', ps.host,
              'port', ps.port,
              'label', ps.label,
              'is_active', ps.is_active
            )
       from public.printer_settings ps
      where ps.org_id = p_org_id
        and ps.branch_id = p_branch_id
        and ps.label = p_label),
    jsonb_build_object('mode', 'browser', 'host', null, 'port', 9100, 'label', p_label,
                       'is_active', true)
  );
$$;

-- Upsert the branch's printer settings. Idempotent on (org_id, branch_id, label).
create or replace function app.set_printer_settings(
  p_org_id uuid,
  p_branch_id uuid,
  p_mode text,
  p_host text default null,
  p_port int default 9100,
  p_label text default 'default'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.printer_settings;
begin
  if p_mode not in ('browser', 'network') then
    raise exception 'printer mode must be browser or network' using errcode = 'P0001';
  end if;
  if p_mode = 'network' and (p_host is null or p_host = '') then
    raise exception 'a network printer requires a host' using errcode = 'P0001';
  end if;

  -- Browser mode has no destination on the LAN: clear any host so the stored row cannot mislead.
  insert into public.printer_settings (org_id, branch_id, mode, host, port, label)
  values (
    p_org_id,
    p_branch_id,
    p_mode,
    case when p_mode = 'network' then p_host else null end,
    p_port,
    p_label
  )
  on conflict (org_id, branch_id, label) do update
     set mode = excluded.mode,
         host = excluded.host,
         port = excluded.port
  returning * into v_row;

  return jsonb_build_object(
    'mode', v_row.mode,
    'host', v_row.host,
    'port', v_row.port,
    'label', v_row.label,
    'is_active', v_row.is_active
  );
end;
$$;

-- RLS and grants.
select app.apply_tenant_rls('public.printer_settings', 'branch');

grant execute on function app.get_printer_settings(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.set_printer_settings(uuid, uuid, text, text, int, text)
  to authenticated, service_role;
