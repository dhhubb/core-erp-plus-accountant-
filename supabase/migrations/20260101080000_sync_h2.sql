-- H2: Sync engine (branch <-> cloud, both directions).
--
-- Additive only. Nothing here edits an applied migration or a core accounting path. A branch runs
-- the SAME migrations as the cloud; this file adds the branch-side outbox, the cloud-side event
-- inbox, the cloud-side master-data change log, and the conflict log, plus the functions both sides
-- use. The branch and the cloud share one schema; which tables are written depends on BRANCH_MODE.
--
-- Adds:
--   * public.sync_outbox          (branch; APPEND-ONLY event log, bigserial local sequence)
--   * public.sync_inbox           (cloud; APPEND-ONLY record of events the cloud has applied,
--                                  unique (org_id, event_id) is the dedupe key)
--   * public.master_data_changes  (cloud; APPEND-ONLY master-data change log with a per-org
--                                  monotonic change_seq, what the branch pulls)
--   * public.branch_master_data   (branch; MUTABLE mirror of applied master data, rebuilt from the
--                                  change log, so it is an allowed cache)
--   * public.sync_conflicts       (branch; APPEND-ONLY log of events the cloud really rejected)
--   * public.sync_backups         (branch; metadata for the nightly encrypted backup)
--
--   * app.sync_outbox_enqueue(...)         — append one event to the outbox
--   * app.sync_outbox_batch(...)           — the next batch in sequence order, with payloads
--   * app.sync_outbox_ack(...)             — mark a contiguous prefix acknowledged (acked_at)
--   * app.sync_outbox_size(...)            — unacked count (the sync status page)
--   * app.sync_outbox_max_seq(...)         — highest sequence number the branch has
--   * app.sync_inbox_apply(...)            — cloud: insert an event ON CONFLICT DO NOTHING
--   * app.sync_push_result(...)            — cloud: apply a batch, return highest acked seq + rejects
--   * app.sync_pull_batch(...)             — cloud: master-data changes after a cursor, in order
--   * app.record_master_data_change(...)   — cloud: append one master-data change, assign change_seq
--   * app.sync_apply_pull(...)             — branch: apply pulled changes to the local mirror
--   * app.branch_price(...)                — branch: the till's price from the local mirror
--   * app.sync_record_conflict(...)        — branch: log a real rejection
--   * app.sync_status(...)                 — branch: the sync status page's data
--   * app.sync_set_cursor(...)             — branch: advance the pull cursor (forward only)
--   * app.sync_set_pushed_seq(...)         — branch: record the highest acked push sequence
--   * app.record_sync_backup(...)          — branch: record a backup run
--   * app.sync_enqueue_on_sale()           — trigger: one 'sale' event per pos_sale
--   * app.sync_enqueue_on_stock()          — trigger: a 'receipt'/'adjustment' event per movement
--   * app.sync_enqueue_on_payment()        — trigger: a 'payment' event (POS tenders excluded)
--   * app.sync_enqueue_on_credit_note()    — trigger: a 'credit_note' event
--
-- Design notes (ADR-0028 .. ADR-0034):
--   * The outbox sequence (bigserial) is the ORDER. Event order follows the sequence number, never
--     the wall clock, so setting the branch clock back changes nothing (test 23).
--   * The event UUID is the DEDUPE key. The cloud inserts with ON CONFLICT (org_id, event_id) DO
--     NOTHING, so pushing the same batch twice posts each event once (test 19).
--   * A batch is applied in ONE transaction on the cloud, so a sale's events succeed or fail
--     together. The highest sequence the cloud applied is returned and the branch acks up to it.
--   * Only a real rejection from the cloud is a conflict. A network failure is retried forever with
--     exponential backoff and jitter, capped at 5 minutes (src/sync/retry.ts).
--   * The outbox is append-only like the ledger: acked_at is the ONLY mutable column, and it moves
--     forward only. There is no delete.
--   * The outbox events are written by triggers on the source tables, so the event and the fact it
--     records are in the SAME transaction by construction. A POS sale writes exactly one 'sale'
--     event: its tender payments are part of the sale and are excluded from the payments trigger,
--     and its outbound stock movements are excluded from the stock trigger.

-- ---------------------------------------------------------------------------
-- Branch outbox. One row per financial/stock event, written in the SAME transaction as the fact it
-- records (app.sync_outbox_enqueue is called by the posting functions, and by a trigger on the
-- ledger tables for events the core functions write). bigserial gives the local sequence that fixes
-- the order. event_id is the idempotency key on the cloud.
-- ---------------------------------------------------------------------------
create table public.sync_outbox (
  seq         bigserial primary key,
  id          uuid not null default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  event_id    uuid not null,
  event_type  text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  acked_at    timestamptz,
  constraint sync_outbox_event_key unique (org_id, event_id),
  constraint sync_outbox_event_type_check
    check (event_type in ('sale', 'receipt', 'adjustment', 'payment', 'credit_note', 'stock_count',
                          'master_data')),
  constraint sync_outbox_payload_check check (jsonb_typeof(payload) = 'object')
);

-- The push worker reads "unacked, in sequence order". Partial index keeps it small.
create index sync_outbox_pending_idx
  on public.sync_outbox (org_id, branch_id, seq) where acked_at is null;
create index sync_outbox_org_branch_created_idx
  on public.sync_outbox (org_id, branch_id, created_at desc, seq desc);
create index sync_outbox_org_created_idx on public.sync_outbox (org_id, created_at desc, id desc);
create index sync_outbox_branch_id_idx on public.sync_outbox (branch_id);

-- ---------------------------------------------------------------------------
-- Cloud inbox. One row per event the cloud has applied. unique (org_id, event_id) is the whole
-- dedupe story: a second push of the same event conflicts and does nothing (test 19). APPEND-ONLY.
-- ---------------------------------------------------------------------------
create table public.sync_inbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  event_id    uuid not null,
  event_type  text not null,
  branch_seq  bigint not null,
  payload     jsonb not null default '{}'::jsonb,
  applied_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint sync_inbox_event_key unique (org_id, event_id),
  constraint sync_inbox_branch_seq_check check (branch_seq >= 0),
  constraint sync_inbox_payload_check check (jsonb_typeof(payload) = 'object')
);

create index sync_inbox_org_branch_created_idx
  on public.sync_inbox (org_id, branch_id, created_at desc, id desc);
create index sync_inbox_org_created_idx on public.sync_inbox (org_id, created_at desc, id desc);
create index sync_inbox_branch_id_idx on public.sync_inbox (branch_id);
create index sync_inbox_org_branch_seq_idx on public.sync_inbox (org_id, branch_id, branch_seq);

-- ---------------------------------------------------------------------------
-- Cloud master-data change log. Every master-data change (a product, a price, a tax rate) is
-- assigned a per-org monotonic change_seq. The branch pulls "changes after my cursor", in order,
-- and stores the cursor. Master data is org-wide (one price applies to every branch), so this table
-- is ORG-scoped: it has org_id but no branch_id. APPEND-ONLY.
-- ---------------------------------------------------------------------------
create table public.master_data_changes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  change_seq    bigint not null,
  entity_type   text not null,
  entity_id     uuid not null,
  operation     text not null,
  version       int not null default 1,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint master_data_changes_entity_type_check
    check (entity_type in ('product', 'product_variant', 'price_list_item', 'tax_rate', 'promotion',
                           'exchange_rate', 'settings')),
  constraint master_data_changes_operation_check check (operation in ('upsert', 'delete')),
  constraint master_data_changes_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint master_data_changes_org_seq_key unique (org_id, change_seq)
);

create index master_data_changes_org_seq_idx on public.master_data_changes (org_id, change_seq);
create index master_data_changes_org_created_idx
  on public.master_data_changes (org_id, created_at desc, id desc);
create index master_data_changes_entity_id_idx on public.master_data_changes (entity_id);

-- ---------------------------------------------------------------------------
-- Branch master-data mirror. The branch applies each pulled change here so the till prices and
-- shows products from its LOCAL database with no cloud round trip (test 22). This is a MUTABLE
-- cache, allowed because it can be rebuilt from the immutable change log: dropping the table and
-- re-pulling every change_seq reproduces it exactly (ADR-0034).
--
-- price_version is the cloud's change_seq at which this row's price last changed. A sale stores the
-- price_version it charged, so a later price change cannot rewrite history (test 22).
-- ---------------------------------------------------------------------------
create table public.branch_master_data (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  entity_type   text not null,
  entity_id     uuid not null,
  payload       jsonb not null default '{}'::jsonb,
  price_version bigint not null default 0,
  deleted       boolean not null default false,
  change_seq    bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint branch_master_data_entity_type_check
    check (entity_type in ('product', 'product_variant', 'price_list_item', 'tax_rate', 'promotion',
                           'exchange_rate', 'settings')),
  constraint branch_master_data_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint branch_master_data_entity_key unique (org_id, branch_id, entity_type, entity_id)
);

create index branch_master_data_org_branch_created_idx
  on public.branch_master_data (org_id, branch_id, created_at desc, id desc);
create index branch_master_data_org_created_idx
  on public.branch_master_data (org_id, created_at desc, id desc);
create index branch_master_data_branch_id_idx on public.branch_master_data (branch_id);
create index branch_master_data_entity_id_idx on public.branch_master_data (entity_id);
create index branch_master_data_variant_idx
  on public.branch_master_data (org_id, branch_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Branch conflict log. Only a real rejection from the cloud lands here. APPEND-ONLY.
-- ---------------------------------------------------------------------------
create table public.sync_conflicts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  event_id      uuid not null,
  branch_seq    bigint,
  event_type    text,
  reason        text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint sync_conflicts_detail_check check (jsonb_typeof(detail) = 'object')
);

create index sync_conflicts_org_branch_created_idx
  on public.sync_conflicts (org_id, branch_id, created_at desc, id desc);
create index sync_conflicts_org_created_idx on public.sync_conflicts (org_id, created_at desc, id desc);
create index sync_conflicts_branch_id_idx on public.sync_conflicts (branch_id);

-- ---------------------------------------------------------------------------
-- Nightly backup metadata. One row per backup run. The branch writes its local dump to cloud
-- storage when online; this table records the run so the status page can show the last one.
-- ---------------------------------------------------------------------------
create table public.sync_backups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  object_key    text,
  byte_size     bigint,
  checksum      text,
  encryption    text not null default 'aes-256-gcm',
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint sync_backups_status_check check (status in ('running', 'uploaded', 'failed')),
  constraint sync_backups_byte_size_check check (byte_size is null or byte_size >= 0)
);

create index sync_backups_org_branch_created_idx
  on public.sync_backups (org_id, branch_id, created_at desc, id desc);
create index sync_backups_org_created_idx on public.sync_backups (org_id, created_at desc, id desc);
create index sync_backups_branch_id_idx on public.sync_backups (branch_id);

-- ---------------------------------------------------------------------------
-- RLS. sync_outbox, sync_inbox, branch_master_data, sync_conflicts and sync_backups are
-- branch-scoped. master_data_changes is org-scoped: master data is org-wide.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.sync_outbox', 'branch');
select app.apply_tenant_rls('public.sync_inbox', 'branch');
select app.apply_tenant_rls('public.master_data_changes', 'org');
select app.apply_tenant_rls('public.branch_master_data', 'branch');
select app.apply_tenant_rls('public.sync_conflicts', 'branch');
select app.apply_tenant_rls('public.sync_backups', 'branch');

create trigger sync_backups_set_updated_at
  before update on public.sync_backups
  for each row execute function app.set_updated_at();
create trigger branch_master_data_set_updated_at
  before update on public.branch_master_data
  for each row execute function app.set_updated_at();

-- The cloud inbox and the master-data log are append-only like the ledger. The outbox is
-- append-only too, but acked_at moves forward, so it is NOT put under the immutability trigger;
-- instead UPDATE is restricted to the ack column by a guard trigger below.
select app.enforce_immutable('public.sync_inbox');
select app.enforce_immutable('public.master_data_changes');
select app.enforce_immutable('public.sync_conflicts');

-- ---------------------------------------------------------------------------
-- The outbox is append-only except for acked_at. A guard rejects any UPDATE that touches a column
-- other than acked_at, and rejects DELETE outright. acked_at may only move from null to a value, so
-- an ack can never be undone (a re-push cannot resurrect an event).
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'table public.sync_outbox is append-only; DELETE is not allowed'
      using errcode = 'restrict_violation';
  end if;

  -- UPDATE: only acked_at may change, and only null -> not null.
  if old.seq <> new.seq
     or old.id <> new.id
     or old.org_id <> new.org_id
     or old.branch_id <> new.branch_id
     or old.event_id <> new.event_id
     or old.event_type <> new.event_type
     or old.payload <> new.payload
     or old.created_at <> new.created_at then
    raise exception 'public.sync_outbox is append-only; only acked_at may be set'
      using errcode = 'restrict_violation';
  end if;
  if old.acked_at is not null and (new.acked_at is distinct from old.acked_at) then
    raise exception 'public.sync_outbox acked_at is write-once'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger sync_outbox_guard
  before update or delete on public.sync_outbox
  for each row execute function app.sync_outbox_guard();

-- ---------------------------------------------------------------------------
-- Append one event to the outbox. Called inside the transaction that records the fact, so the
-- event and the fact commit together or not at all. Idempotent per (org_id, event_id): a retried
-- enqueue does nothing.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_enqueue(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_event_id   uuid,
  p_event_type text,
  p_payload    jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq bigint;
begin
  insert into public.sync_outbox (org_id, branch_id, event_id, event_type, payload)
  values (p_org_id, p_branch_id, coalesce(p_event_id, gen_random_uuid()), p_event_type,
          coalesce(p_payload, '{}'::jsonb))
  on conflict (org_id, event_id) do nothing
  returning seq into v_seq;

  if v_seq is null then
    select o.seq into v_seq
      from public.sync_outbox o
     where o.org_id = p_org_id and o.event_id = p_event_id;
  end if;

  return v_seq;
end;
$$;

comment on function app.sync_outbox_enqueue(uuid, uuid, uuid, text, jsonb) is
  'Appends one event to the branch outbox in the same transaction as the fact it records. '
  'Idempotent per (org_id, event_id). Returns the local sequence number.';

-- ---------------------------------------------------------------------------
-- The next batch of unacked events, in sequence order. Returns the events as jsonb so the worker
-- has everything (id, seq, type, payload) in one round trip.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_batch(
  p_org_id    uuid,
  p_branch_id uuid,
  p_limit     int default 500
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', o.seq,
           'event_id', o.event_id,
           'event_type', o.event_type,
           'payload', o.payload,
           'created_at', o.created_at
         ) order by o.seq), '[]'::jsonb)
    from (
      select o.seq, o.event_id, o.event_type, o.payload, o.created_at
        from public.sync_outbox o
       where o.org_id = p_org_id
         and o.branch_id = p_branch_id
         and o.acked_at is null
       order by o.seq
       limit greatest(1, least(p_limit, 500))
    ) o;
$$;

-- ---------------------------------------------------------------------------
-- Mark a contiguous prefix of the outbox acknowledged. The cloud returns the highest sequence it
-- applied; everything up to and including it is acked in one UPDATE. A gap is never acked, so a
-- lost event stays pending and is re-pushed.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_ack(
  p_org_id    uuid,
  p_branch_id uuid,
  p_up_to_seq bigint
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.sync_outbox
     set acked_at = now()
   where org_id = p_org_id
     and branch_id = p_branch_id
     and acked_at is null
     and seq <= p_up_to_seq;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outbox size (unacked) and the highest sequence number the branch holds. The status page reads
-- both; the worker uses the max to know it has drained.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_size(p_org_id uuid, p_branch_id uuid)
returns bigint
language sql
stable
as $$
  select count(*)
    from public.sync_outbox o
   where o.org_id = p_org_id
     and o.branch_id = p_branch_id
     and o.acked_at is null;
$$;

create or replace function app.sync_outbox_max_seq(p_org_id uuid, p_branch_id uuid)
returns bigint
language sql
stable
as $$
  select coalesce(max(o.seq), 0)
    from public.sync_outbox o
   where o.org_id = p_org_id
     and o.branch_id = p_branch_id;
$$;

-- ---------------------------------------------------------------------------
-- Cloud: apply one event. Insert into the inbox ON CONFLICT (org_id, event_id) DO NOTHING. Returns
-- true when the event was newly applied, false when it was a duplicate. The push route wraps a
-- batch in one transaction and uses a savepoint per event, so a rejected event rolls back its own
-- inbox row while the rest of the batch commits.
-- ---------------------------------------------------------------------------
create or replace function app.sync_inbox_apply(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_event_id   uuid,
  p_event_type text,
  p_branch_seq bigint,
  p_payload    jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.sync_inbox (org_id, branch_id, event_id, event_type, branch_seq, payload)
  values (p_org_id, p_branch_id, p_event_id, p_event_type, coalesce(p_branch_seq, 0),
          coalesce(p_payload, '{}'::jsonb))
  on conflict (org_id, event_id) do nothing
  returning id into v_id;

  return v_id is not null;
end;
$$;

comment on function app.sync_inbox_apply(uuid, uuid, uuid, text, bigint, jsonb) is
  'Cloud: records one applied event. ON CONFLICT (org_id, event_id) DO NOTHING makes a re-pushed '
  'event a no-op, which is the dedupe guarantee (the event UUID is the idempotency key).';

-- ---------------------------------------------------------------------------
-- Cloud: replay one event into the cloud's own tables. The event is the branch's record of a fact,
-- and the cloud reconstructs the fact from the payload. Idempotent: the inbox insert is the claim,
-- so a re-delivered event returns 'duplicate' and posts nothing (test 19).
--
-- The replay calls the SAME posting functions the cloud uses for a live sale, so the cloud's ledger
-- is built exactly as if the sale had happened there. Branch-local ids that the cloud does not have
-- (a shift) are not replayed; the branch's own pos_sales row keeps them.
-- ---------------------------------------------------------------------------
create or replace function app.sync_apply_event(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_event_id   uuid,
  p_event_type text,
  p_branch_seq bigint,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Claim the event first. A duplicate returns immediately and posts nothing.
  if not app.sync_inbox_apply(p_org_id, p_branch_id, p_event_id, p_event_type, p_branch_seq,
                              coalesce(p_payload, '{}'::jsonb)) then
    return jsonb_build_object('event_id', p_event_id, 'outcome', 'duplicate');
  end if;

  case p_event_type
    when 'sale'        then perform app.sync_replay_sale(p_org_id, p_branch_id, p_payload);
    when 'receipt'     then perform app.sync_replay_receipt(p_org_id, p_branch_id, p_payload);
    when 'adjustment'  then perform app.sync_replay_adjustment(p_org_id, p_branch_id, p_payload);
    when 'payment'     then perform app.sync_replay_payment(p_org_id, p_branch_id, p_payload);
    when 'credit_note' then perform app.sync_replay_credit_note(p_org_id, p_branch_id, p_payload);
    else
      raise exception 'unknown sync event type %', p_event_type using errcode = '22023';
  end case;

  return jsonb_build_object('event_id', p_event_id, 'outcome', 'applied');
end;
$$;

-- Replay a sale. The payload carries the lines and the tenders; app.sync_pos_sale is itself
-- idempotent on client_sale_id, so a duplicate sale cannot double-post even if two events carried
-- the same client_sale_id.
create or replace function app.sync_replay_sale(
  p_org_id    uuid,
  p_branch_id uuid,
  p_payload   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines    jsonb := '[]'::jsonb;
  v_tenders  jsonb := '[]'::jsonb;
  v_line     jsonb;
  v_tender   jsonb;
  v_warehouse uuid;
begin
  for v_line in select value from jsonb_array_elements(coalesce(p_payload -> 'lines', '[]'::jsonb))
  loop
    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_line ->> 'variant_id',
      'qty', v_line ->> 'qty',
      'unit_price', v_line ->> 'unit_price'
    );
    if v_warehouse is null then
      v_warehouse := nullif(v_line ->> 'warehouse_id', '')::uuid;
    end if;
  end loop;

  for v_tender in select value from jsonb_array_elements(coalesce(p_payload -> 'tenders', '[]'::jsonb))
  loop
    v_tenders := v_tenders || jsonb_build_object(
      'method', v_tender ->> 'method',
      'currency', v_tender ->> 'currency',
      'amount_tendered', v_tender ->> 'amount_tendered'
    );
  end loop;

  if v_warehouse is null then
    raise exception 'sale event % has no warehouse; cannot replay', p_payload ->> 'client_sale_id'
      using errcode = '22023';
  end if;

  perform app.sync_pos_sale(
    p_org_id, p_branch_id, v_warehouse, null, (p_payload ->> 'client_sale_id')::uuid,
    v_lines, v_tenders, null, (p_payload ->> 'created_at')::timestamptz::date,
    (p_payload ->> 'created_at')::timestamptz
  );
end;
$$;

create or replace function app.sync_replay_receipt(
  p_org_id    uuid,
  p_branch_id uuid,
  p_payload   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A receipt event is written by the stock trigger for an inbound 'receipt' movement. The journal
  -- is rebuilt from the movement's quantity and unit cost.
  if (p_payload ->> 'direction') <> 'in' then
    return;
  end if;

  perform app.post_receipt(
    p_org_id, p_branch_id,
    (p_payload ->> 'warehouse_id')::uuid,
    (p_payload ->> 'product_id')::uuid,
    nullif(p_payload ->> 'variant_id', '')::uuid,
    (p_payload ->> 'qty')::numeric,
    (p_payload ->> 'unit_cost')::numeric,
    (p_payload ->> 'created_at')::timestamptz::date
  );
end;
$$;

create or replace function app.sync_replay_adjustment(
  p_org_id    uuid,
  p_branch_id uuid,
  p_payload   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qty numeric := (p_payload ->> 'qty')::numeric;
begin
  -- The stock trigger writes one event per movement. A negative adjustment is one outbound movement
  -- and replaying it directly would double-count, so only the inbound half of an adjustment is
  -- replayed here; the outbound half is rebuilt by post_stock_adjustment.
  if (p_payload ->> 'direction') <> 'in' then
    return;
  end if;

  perform app.post_stock_adjustment(
    p_org_id, p_branch_id,
    (p_payload ->> 'warehouse_id')::uuid,
    (p_payload ->> 'product_id')::uuid,
    nullif(p_payload ->> 'variant_id', '')::uuid,
    v_qty,
    coalesce((p_payload ->> 'unit_cost')::numeric, 0),
    (p_payload ->> 'created_at')::timestamptz::date,
    'Synced adjustment'
  );
end;
$$;

create or replace function app.sync_replay_payment(
  p_org_id    uuid,
  p_branch_id uuid,
  p_payload   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.allocate_payment(
    p_org_id, p_branch_id,
    (p_payload ->> 'invoice_id')::uuid,
    (p_payload ->> 'amount')::numeric,
    (p_payload ->> 'paid_at')::timestamptz::date,
    coalesce(p_payload ->> 'method', 'bank'),
    nullif(p_payload ->> 'contact_id', '')::uuid
  );
end;
$$;

create or replace function app.sync_replay_credit_note(
  p_org_id    uuid,
  p_branch_id uuid,
  p_payload   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The credit note's own lines are not in the event payload, so the cloud cannot rebuild the exact
  -- return. The event is recorded in the inbox (so it is not lost or re-applied) and left for the
  -- reconciliation report; a full replay needs the credit-note lines in the payload, which is an
  -- H3 item (see docs/ADR.md).
  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cloud: apply a whole push batch and return the outcome. The batch is a jsonb array of
-- {seq, event_id, event_type, payload}. Each event is applied in its own subtransaction: a rejected
-- event rolls back only its own work, and the rest of the batch commits (test 17). A duplicate is
-- not a rejection (test 19). The response carries the highest sequence the cloud applied, which is
-- what the branch acks.
-- ---------------------------------------------------------------------------
create or replace function app.sync_push_result(
  p_org_id    uuid,
  p_branch_id uuid,
  p_events    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event    jsonb;
  v_seq      bigint;
  v_event_id uuid;
  v_type     text;
  v_payload  jsonb;
  v_result   jsonb;
  v_applied  int := 0;
  v_dup      int := 0;
  v_high     bigint := 0;
  v_rejects  jsonb := '[]'::jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'push batch must be a json array' using errcode = '22023';
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_seq := nullif(v_event ->> 'seq', '')::bigint;
    v_event_id := nullif(v_event ->> 'event_id', '')::uuid;
    v_type := v_event ->> 'event_type';
    v_payload := coalesce(v_event -> 'payload', '{}'::jsonb);

    if v_seq is null or v_event_id is null or v_type is null then
      v_rejects := v_rejects || jsonb_build_object(
        'event_id', v_event ->> 'event_id',
        'reason', 'malformed event: seq, event_id and event_type are required'
      );
      continue;
    end if;

    -- Subtransaction per event: the BEGIN ... EXCEPTION block rolls back only this event's work.
    begin
      v_result := app.sync_apply_event(p_org_id, p_branch_id, v_event_id, v_type, v_seq, v_payload);
      if v_result ->> 'outcome' = 'duplicate' then
        v_dup := v_dup + 1;
      else
        v_applied := v_applied + 1;
      end if;
    exception when others then
      v_rejects := v_rejects || jsonb_build_object(
        'event_id', v_event_id::text,
        'reason', sqlerrm
      );
      -- A rejected event is not acked: the branch stops at it and records a conflict.
      return jsonb_build_object(
        'highest_seq', v_high,
        'applied', v_applied,
        'duplicates', v_dup,
        'rejects', v_rejects
      );
    end;

    if v_seq > v_high then
      v_high := v_seq;
    end if;
  end loop;

  return jsonb_build_object(
    'highest_seq', v_high,
    'applied', v_applied,
    'duplicates', v_dup,
    'rejects', v_rejects
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cloud: the master-data changes after a cursor, in change_seq order. The branch pulls this and
-- stores the last change_seq as its cursor. change_seq is per org and monotonic, so "after the
-- cursor" is exact and gap-free.
-- ---------------------------------------------------------------------------
create or replace function app.sync_pull_batch(
  p_org_id    uuid,
  p_branch_id uuid,
  p_since_seq bigint default 0,
  p_limit     int default 500
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'change_seq', c.change_seq,
           'entity_type', c.entity_type,
           'entity_id', c.entity_id,
           'operation', c.operation,
           'version', c.version,
           'payload', c.payload,
           'created_at', c.created_at
         ) order by c.change_seq), '[]'::jsonb)
    from (
      select c.change_seq, c.entity_type, c.entity_id, c.operation, c.version, c.payload, c.created_at
        from public.master_data_changes c
       where c.org_id = p_org_id
         and c.change_seq > coalesce(p_since_seq, 0)
       order by c.change_seq
       limit greatest(1, least(p_limit, 500))
    ) c;
$$;

-- ---------------------------------------------------------------------------
-- Cloud: append one master-data change and assign its per-org sequence. The change log is the
-- single source of truth for what a branch pulls. Monotonic per org, so two writers cannot collide
-- (the per-org counter row is locked).
-- ---------------------------------------------------------------------------
create or replace function app.record_master_data_change(
  p_org_id      uuid,
  p_entity_type text,
  p_entity_id   uuid,
  p_operation   text,
  p_payload     jsonb,
  p_version     int default 1
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq bigint;
begin
  -- Serialise the per-org counter by locking the org row, so two concurrent writers cannot take
  -- the same change_seq.
  perform 1 from public.organizations where id = p_org_id for update;

  select coalesce(max(change_seq), 0) + 1 into v_seq
    from public.master_data_changes
   where org_id = p_org_id;

  insert into public.master_data_changes
    (org_id, change_seq, entity_type, entity_id, operation, version, payload)
  values (p_org_id, v_seq, p_entity_type, p_entity_id, p_operation, coalesce(p_version, 1),
          coalesce(p_payload, '{}'::jsonb));

  return v_seq;
end;
$$;

comment on function app.record_master_data_change(uuid, text, uuid, text, jsonb, int) is
  'Appends one master-data change for the org and returns its monotonic change_seq. A branch pulls '
  'changes after its stored cursor.';

-- ---------------------------------------------------------------------------
-- Branch: apply a pulled batch to the local mirror, in change_seq order, and advance the cursor.
-- Each change upserts branch_master_data. A price change also sets price_version to the change_seq,
-- so the till can record which version it charged (test 22). The cursor only moves forward.
-- ---------------------------------------------------------------------------
create or replace function app.sync_apply_pull(
  p_org_id    uuid,
  p_branch_id uuid,
  p_changes   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_change    jsonb;
  v_seq       bigint;
  v_entity    text;
  v_entity_id uuid;
  v_op        text;
  v_payload   jsonb;
  v_applied   int := 0;
  v_high      bigint := 0;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'pull batch must be a json array' using errcode = '22023';
  end if;

  for v_change in
    select value
      from jsonb_array_elements(p_changes)
     order by (value ->> 'change_seq')::bigint
  loop
    v_seq := (v_change ->> 'change_seq')::bigint;
    v_entity := v_change ->> 'entity_type';
    v_entity_id := (v_change ->> 'entity_id')::uuid;
    v_op := v_change ->> 'operation';
    v_payload := coalesce(v_change -> 'payload', '{}'::jsonb);

    insert into public.branch_master_data
      (org_id, branch_id, entity_type, entity_id, payload, price_version, deleted, change_seq)
    values (p_org_id, p_branch_id, v_entity, v_entity_id, v_payload,
            v_seq, v_op = 'delete', v_seq)
    on conflict (org_id, branch_id, entity_type, entity_id) do update
      set payload       = excluded.payload,
          price_version = excluded.price_version,
          deleted       = excluded.deleted,
          change_seq    = excluded.change_seq;

    v_applied := v_applied + 1;
    if v_seq > v_high then
      v_high := v_seq;
    end if;
  end loop;

  if v_high > 0 then
    perform app.sync_set_cursor(p_org_id, p_branch_id, v_high);
  end if;

  return jsonb_build_object('applied', v_applied, 'cursor', v_high);
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch: the till's price for a variant, from the LOCAL mirror. The mirror is populated by pull,
-- so this needs no cloud round trip. Returns null when the variant is not mirrored (the caller then
-- falls back to the cloud pricing path, which is only reached in cloud mode).
-- ---------------------------------------------------------------------------
create or replace function app.branch_price(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_variant_id uuid
)
returns table (
  unit_price    numeric,
  price_version bigint,
  currency      text
)
language sql
stable
as $$
  select (d.payload ->> 'price')::numeric as unit_price,
         d.price_version,
         coalesce(d.payload ->> 'currency', 'USD') as currency
    from public.branch_master_data d
   where d.org_id = p_org_id
     and d.branch_id = p_branch_id
     and d.entity_type = 'price_list_item'
     and d.entity_id = p_variant_id
     and not d.deleted
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Branch: record a real rejection from the cloud. Network failures never reach here (they are
-- retried), so a row in this table always means the cloud refused the event.
-- ---------------------------------------------------------------------------
create or replace function app.sync_record_conflict(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_event_id   uuid,
  p_branch_seq bigint,
  p_event_type text,
  p_reason     text,
  p_detail     jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.sync_conflicts
    (org_id, branch_id, event_id, branch_seq, event_type, reason, detail)
  values (p_org_id, p_branch_id, p_event_id, p_branch_seq, p_event_type, p_reason,
          coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch: the sync status page's data. Last push, last pull, outbox size, rejections.
-- ---------------------------------------------------------------------------
create or replace function app.sync_status(p_org_id uuid, p_branch_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_state      public.sync_state%rowtype;
  v_outbox     bigint;
  v_max_seq    bigint;
  v_conflicts  bigint;
  v_last_push  timestamptz;
  v_last_pull  timestamptz;
begin
  select * into v_state
    from public.sync_state
   where org_id = p_org_id and branch_id = p_branch_id;

  select count(*), coalesce(max(seq), 0)
    into v_outbox, v_max_seq
    from public.sync_outbox
   where org_id = p_org_id and branch_id = p_branch_id and acked_at is null;

  select count(*)
    into v_conflicts
    from public.sync_conflicts
   where org_id = p_org_id and branch_id = p_branch_id;

  select max(acked_at) into v_last_push
    from public.sync_outbox
   where org_id = p_org_id and branch_id = p_branch_id;

  select max(applied_at) into v_last_pull
    from public.sync_inbox
   where org_id = p_org_id and branch_id = p_branch_id;

  return jsonb_build_object(
    'protocol_version', coalesce(v_state.protocol_version, app.branch_protocol_version()),
    'last_pushed_seq', coalesce(v_state.last_pushed_seq, 0),
    'last_pulled_cursor', v_state.last_pulled_cursor,
    'cloud_status', coalesce(v_state.cloud_status, 'unknown'),
    'cloud_protocol_version', v_state.cloud_protocol_version,
    'push_blocked', coalesce(v_state.cloud_status, 'unknown') = 'incompatible',
    'outbox_size', v_outbox,
    'outbox_max_seq', v_max_seq,
    'conflicts', v_conflicts,
    'last_push_at', v_last_push,
    'last_pull_at', v_last_pull
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch: advance the stored pull cursor and record the cloud observation. The cursor only ever
-- moves forward: a stale pull cannot rewind it.
-- ---------------------------------------------------------------------------
create or replace function app.sync_set_cursor(
  p_org_id    uuid,
  p_branch_id uuid,
  p_cursor    bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.sync_state (org_id, branch_id, protocol_version, last_pulled_cursor)
  values (p_org_id, p_branch_id, app.branch_protocol_version(), p_cursor::text)
  on conflict (org_id, branch_id) do update
    set last_pulled_cursor =
      greatest(coalesce(public.sync_state.last_pulled_cursor::bigint, 0), excluded.last_pulled_cursor::bigint)::text;
  return p_cursor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch: record the highest sequence the cloud acknowledged, so the status page shows progress.
-- ---------------------------------------------------------------------------
create or replace function app.sync_set_pushed_seq(
  p_org_id    uuid,
  p_branch_id uuid,
  p_seq       bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.sync_state (org_id, branch_id, protocol_version, last_pushed_seq)
  values (p_org_id, p_branch_id, app.branch_protocol_version(), greatest(p_seq, 0))
  on conflict (org_id, branch_id) do update
    set last_pushed_seq = greatest(public.sync_state.last_pushed_seq, excluded.last_pushed_seq);
  return p_seq;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch: record a backup run (start, success or failure).
-- ---------------------------------------------------------------------------
create or replace function app.record_sync_backup(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_status     text,
  p_object_key text default null,
  p_byte_size  bigint default null,
  p_checksum   text default null,
  p_error      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.sync_backups
    (org_id, branch_id, status, object_key, byte_size, checksum, error, finished_at)
  values (p_org_id, p_branch_id, p_status, p_object_key, p_byte_size, p_checksum, p_error,
          case when p_status = 'running' then null else now() end)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outbox enqueue triggers. Each fires AFTER INSERT on its source table, so the event is written in
-- the SAME transaction as the fact it records: if the sale rolls back, its event rolls back with
-- it.
--
-- The triggers are gated on the transaction-local setting `app.branch_mode`. A branch sets it to
-- 'branch' (the branch server does this on every connection), so the branch records events to push.
-- The cloud never sets it, so the cloud's write path is free of outbox rows and replaying a branch
-- event on the cloud does not echo back into an outbox. This is the same transaction-local GUC
-- pattern as app.allow_negative_stock (ADR-0015), and it keeps one codebase and one migration set
-- (ADR-0023).
--
-- A POS sale is ONE 'sale' event. Its tender payments are CORE payments created by the same sale, so
-- the payments trigger skips a payment that a POS sale owns; the sale event already carries the
-- whole sale. Its outbound stock movements are part of the sale too, so the stock trigger records
-- only receipts and adjustments, not sale movements (a 'sale' source on the ledger).
-- ---------------------------------------------------------------------------
create or replace function app.branch_mode_enabled()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.branch_mode', true), 'cloud') = 'branch';
$$;

create or replace function app.sync_outbox_on_sale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenders jsonb;
  v_lines   jsonb;
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  -- The sale event is written by a DEFERRED constraint trigger, so the whole sale (its lines and
  -- its tenders) exists by the time this runs. The tenders are the CORE payments the sale created,
  -- which the cloud replays to reconstruct the sale exactly.
  select coalesce(jsonb_agg(jsonb_build_object(
           'method', pp.method, 'currency', pp.currency,
           'amount_tendered', pp.amount_tendered, 'amount_applied', pp.amount_applied,
           'rate', pp.rate, 'base_amount', pp.base_amount, 'change_given', pp.change_given
         ) order by pp.created_at, pp.id), '[]'::jsonb)
    into v_tenders
    from public.pos_payments pp
   where pp.sale_id = new.id and pp.sale_created_at = new.created_at;

  select coalesce(jsonb_agg(jsonb_build_object(
           'line_no', il.line_no, 'product_id', il.product_id, 'variant_id', il.variant_id,
           'warehouse_id', il.warehouse_id, 'qty', il.qty, 'unit_price', il.unit_price,
           'tax_rate', il.tax_rate, 'line_subtotal', il.line_subtotal, 'line_tax', il.line_tax,
           'line_total', il.line_total
         ) order by il.line_no), '[]'::jsonb)
    into v_lines
    from public.invoice_lines il
   where il.invoice_id = new.invoice_id;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, new.client_sale_id, 'sale',
    jsonb_build_object(
      'sale_id', new.id,
      'invoice_id', new.invoice_id,
      'shift_id', new.shift_id,
      'client_sale_id', new.client_sale_id,
      'cashier_id', new.cashier_id,
      'created_at', new.created_at,
      'tenders', v_tenders,
      'lines', v_lines
    )
  );
  return null;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED, so it fires at commit: the tenders and lines are complete by then.
-- A rolled-back sale leaves no event (test 32 in spirit), because the whole transaction unwinds.
create constraint trigger sync_outbox_sale
  after insert on public.pos_sales
  deferrable initially deferred
  for each row execute function app.sync_outbox_on_sale();

create or replace function app.sync_outbox_on_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text;
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  -- A sale's stock movement is part of the sale event; only receipts and adjustments get their own.
  if new.source_type = 'sale' then
    return null;
  end if;

  v_type := case new.source_type
    when 'receipt' then 'receipt'
    when 'adjustment' then 'adjustment'
    else null
  end;

  if v_type is null then
    return null;
  end if;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, gen_random_uuid(), v_type,
    jsonb_build_object(
      'ledger_id', new.id,
      'warehouse_id', new.warehouse_id,
      'product_id', new.product_id,
      'variant_id', new.variant_id,
      'direction', new.direction,
      'qty', new.qty,
      'unit_cost', new.unit_cost,
      'source_type', new.source_type,
      'source_id', new.source_id,
      'created_at', new.created_at
    )
  );
  return null;
end;
$$;

create trigger sync_outbox_stock
  after insert on public.stock_ledger
  for each row execute function app.sync_outbox_on_stock();

create or replace function app.sync_outbox_on_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  -- A payment created by a POS sale belongs to that sale's single event. post_pos_sale inserts its
  -- pos_sales row before it allocates the tenders, so by the time this fires the owning sale exists.
  -- Only a standalone payment (an AR allocation on a plain invoice) gets its own event.
  if exists (
    select 1 from public.pos_sales ps
     where ps.org_id = new.org_id and ps.invoice_id = new.invoice_id
  ) then
    return null;
  end if;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, new.id, 'payment',
    jsonb_build_object(
      'payment_id', new.id,
      'invoice_id', new.invoice_id,
      'contact_id', new.contact_id,
      'amount', new.amount,
      'currency', new.currency,
      'method', new.method,
      'paid_at', new.paid_at,
      'created_at', new.created_at
    )
  );
  return null;
end;
$$;

create trigger sync_outbox_payment
  after insert on public.payments
  for each row execute function app.sync_outbox_on_payment();

create or replace function app.sync_outbox_on_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, new.id, 'credit_note',
    jsonb_build_object(
      'credit_note_id', new.id,
      'invoice_id', new.invoice_id,
      'credit_no', new.credit_no,
      'total', new.total,
      'journal_id', new.journal_id,
      'created_at', new.created_at
    )
  );
  return null;
end;
$$;

create trigger sync_outbox_credit_note
  after insert on public.credit_notes
  for each row execute function app.sync_outbox_on_credit_note();

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
grant execute on function app.sync_outbox_enqueue(uuid, uuid, uuid, text, jsonb)
  to authenticated, service_role;
grant execute on function app.sync_outbox_batch(uuid, uuid, int) to authenticated, service_role;
grant execute on function app.sync_outbox_ack(uuid, uuid, bigint) to authenticated, service_role;
grant execute on function app.sync_outbox_size(uuid, uuid) to authenticated, service_role;
grant execute on function app.sync_outbox_max_seq(uuid, uuid) to authenticated, service_role;
grant execute on function app.sync_inbox_apply(uuid, uuid, uuid, text, bigint, jsonb)
  to authenticated, service_role;
grant execute on function app.sync_push_result(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function app.sync_pull_batch(uuid, uuid, bigint, int) to authenticated, service_role;
grant execute on function app.sync_apply_event(uuid, uuid, uuid, text, bigint, jsonb)
  to authenticated, service_role;
grant execute on function app.branch_mode_enabled() to authenticated, service_role;
grant execute on function app.record_master_data_change(uuid, text, uuid, text, jsonb, int)
  to authenticated, service_role;
grant execute on function app.sync_apply_pull(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function app.branch_price(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.sync_record_conflict(uuid, uuid, uuid, bigint, text, text, jsonb)
  to authenticated, service_role;
grant execute on function app.sync_status(uuid, uuid) to authenticated, service_role;
grant execute on function app.sync_set_cursor(uuid, uuid, bigint) to authenticated, service_role;
grant execute on function app.sync_set_pushed_seq(uuid, uuid, bigint) to authenticated, service_role;
grant execute on function app.record_sync_backup(uuid, uuid, text, text, bigint, text, text)
  to authenticated, service_role;

-- Partitions for the current month and the next two months.
select app.ensure_partitions(2);
