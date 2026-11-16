-- H3: Fiscal and numbering (branch-side FDMS queue and cloud-issued number blocks).
--
-- Additive only. Nothing here edits an applied migration. Two core functions are RE-CREATED with an
-- additive fiscal hook (create_invoice, pos_sale_receipt); their signatures are unchanged and the
-- newest definition wins, exactly as R4 re-created create_invoice/consume_fifo (ADR-0016).
--
-- Adds:
--   * public.fiscal_invoices        (branch; the per-invoice FDMS submission row, MUTABLE status)
--   * public.fiscal_invoice_attempts(branch; APPEND-ONLY delivery attempts)
--   * public.number_blocks          (branch; cloud-reserved invoice-number blocks)
--
--   * app.fiscal_invoice_enqueue(...)   — insert one pending row per invoice, in the invoice's tx
--   * app.fiscal_claim_pending(...)     — claim pending rows FOR UPDATE SKIP LOCKED (the worker)
--   * app.fiscal_invoice_attempt(...)   — record an attempt; real rejections count, outages do not
--   * app.fiscal_invoice_retry(...)     — admin: retry a failed row
--   * app.fiscal_invoice_manual_send(...) — admin: manual submit
--   * app.fiscal_invoice_queue(...)     — admin: keyset page over the queue
--   * app.fiscal_invoice_summary(...)   — admin: counts by status
--   * app.pos_sale_fiscal(...)          — the receipt's fiscal block (signature/QR or pending)
--   * app.issue_number_block(...)       — cloud: reserve a block for a branch
--   * app.request_number_block(...)     — branch: pull a block from the cloud
--   * app.claim_invoice_number(...)     — take the next number from the local block
--   * app.number_block_status(...)      — branch: block state for the "exhausted" message
--
-- Design notes (ADR-0035 .. ADR-0039):
--   * The fiscal row is written in the invoice's own transaction, so a committed invoice always has
--     its fiscal row and a rolled-back one leaves none (test 64).
--   * Attempts count ONLY real FDMS rejections. A network outage leaves the row pending and does
--     not increase the attempt count (test 65, 66). Five real rejections move the row to failed.
--   * The worker claims rows with FOR UPDATE SKIP LOCKED, so two workers never submit the same
--     invoice twice (test 68).
--   * Numbers come from cloud-reserved blocks. A branch requests the next block before the current
--     one is used up; when a block runs out offline the sale fails with a clear message and no
--     number is reused (test 67).

-- ---------------------------------------------------------------------------
-- Per-invoice FDMS submission. One row per invoice, written in the invoice's transaction. status is
-- pending -> sent | failed. A network outage keeps it pending and does not touch attempts; only a
-- real rejection increments attempts and, at 5, moves it to failed.
-- ---------------------------------------------------------------------------
create table public.fiscal_invoices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  branch_id     uuid not null references public.branches (id) on delete restrict,
  invoice_id    uuid not null references public.invoices (id) on delete restrict,
  fdms_payload  jsonb not null default '{}'::jsonb,
  status        text not null default 'pending',
  fdms_response jsonb,
  attempts      int not null default 0,
  last_error    text,
  next_attempt_at timestamptz not null default now(),
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint fiscal_invoices_status_check check (status in ('pending', 'sent', 'failed')),
  constraint fiscal_invoices_attempts_check check (attempts >= 0),
  constraint fiscal_invoices_payload_check check (jsonb_typeof(fdms_payload) = 'object'),
  constraint fiscal_invoices_invoice_key unique (org_id, invoice_id)
);

-- The worker's index: pending rows, oldest first. A PARTIAL index on pending only, so it stays
-- small no matter how many rows have already been sent.
create index fiscal_invoices_pending_idx
  on public.fiscal_invoices (org_id, branch_id, created_at, id)
  where status = 'pending';
-- The admin page's index: org-first, newest first, across every status.
create index fiscal_invoices_org_created_idx
  on public.fiscal_invoices (org_id, branch_id, created_at desc, id desc);
create index fiscal_invoices_org_idx
  on public.fiscal_invoices (org_id, created_at desc, id desc);
create index fiscal_invoices_branch_id_idx on public.fiscal_invoices (branch_id);
create index fiscal_invoices_invoice_id_idx on public.fiscal_invoices (invoice_id);

create trigger fiscal_invoices_set_updated_at
  before update on public.fiscal_invoices
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery attempts. APPEND-ONLY: one row per real submission attempt. A network outage is NOT
-- recorded here (it is not an attempt at FDMS), so the attempt count only reflects real rejections.
-- ---------------------------------------------------------------------------
create table public.fiscal_invoice_attempts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  fiscal_invoice_id uuid not null references public.fiscal_invoices (id) on delete restrict,
  attempt_no   int not null,
  outcome      text not null,
  error        text,
  created_at   timestamptz not null default now(),
  constraint fiscal_invoice_attempts_outcome_check
    check (outcome in ('sent', 'failed', 'unreachable')),
  constraint fiscal_invoice_attempts_key unique (fiscal_invoice_id, attempt_no)
);

create index fiscal_invoice_attempts_org_branch_created_idx
  on public.fiscal_invoice_attempts (org_id, branch_id, created_at desc, id desc);
create index fiscal_invoice_attempts_org_created_idx
  on public.fiscal_invoice_attempts (org_id, created_at desc, id desc);
create index fiscal_invoice_attempts_branch_id_idx on public.fiscal_invoice_attempts (branch_id);
create index fiscal_invoice_attempts_fiscal_invoice_idx
  on public.fiscal_invoice_attempts (fiscal_invoice_id);

-- ---------------------------------------------------------------------------
-- Number blocks. The cloud reserves a contiguous block of invoice numbers for a branch; the branch
-- takes numbers from its local block and requests the next block before the current one is used up.
-- `next_value` and `last_value` bound the block; `consumed` is how many have been handed out.
-- ---------------------------------------------------------------------------
create table public.number_blocks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  series_code text not null default 'INVOICE',
  block_no    bigint not null,
  first_value bigint not null,
  last_value  bigint not null,
  next_value  bigint not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint number_blocks_range_check check (last_value >= first_value and next_value >= first_value),
  constraint number_blocks_branch_series_block_key unique (org_id, branch_id, series_code, block_no)
);

create index number_blocks_org_branch_created_idx
  on public.number_blocks (org_id, branch_id, created_at desc, id desc);
create index number_blocks_org_created_idx
  on public.number_blocks (org_id, created_at desc, id desc);
create index number_blocks_branch_id_idx on public.number_blocks (branch_id);

create trigger number_blocks_set_updated_at
  before update on public.number_blocks
  for each row execute function app.set_updated_at();

-- The branch's active block for a series: the OLDEST block that still has numbers left. Numbers are
-- consumed from the current block until it is exhausted, then the next block takes over, so a branch
-- that topped up early never leaves a gap in its invoice numbers.
create or replace function app.number_block_active(
  p_org_id uuid,
  p_branch_id uuid,
  p_series_code text default 'INVOICE'
)
returns public.number_blocks
language sql
stable
as $$
  select b.*
    from public.number_blocks b
   where b.org_id = p_org_id
     and b.branch_id = p_branch_id
     and b.series_code = p_series_code
     and b.next_value <= b.last_value
   order by b.block_no
   limit 1;
$$;

-- The block state for the branch: remaining numbers (across every block that still has numbers, so
-- the headroom a top-up bought is visible) and the active block bounds. `exhausted` is true only
-- when NO block has a number left, which is exactly when a sale must fail.
create or replace function app.number_block_status(
  p_org_id uuid,
  p_branch_id uuid,
  p_series_code text default 'INVOICE'
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_block public.number_blocks;
  v_remaining bigint;
  v_any boolean;
begin
  select * into v_block from app.number_block_active(p_org_id, p_branch_id, p_series_code);

  select coalesce(sum(b.last_value - b.next_value + 1), 0),
         bool_or(b.next_value <= b.last_value)
    into v_remaining, v_any
    from public.number_blocks b
   where b.org_id = p_org_id
     and b.branch_id = p_branch_id
     and b.series_code = p_series_code;

  if not coalesce(v_any, false) then
    return jsonb_build_object('exhausted', true, 'remaining', 0, 'block_no', null);
  end if;

  return jsonb_build_object(
    'exhausted', false,
    'remaining', v_remaining,
    'block_no', v_block.block_no,
    'first_value', v_block.first_value,
    'last_value', v_block.last_value,
    'next_value', v_block.next_value
  );
end;
$$;

-- Take the next invoice number. When the branch uses blocks (at least one block row exists), the
-- number comes strictly from the active block and a clear, catchable error is raised when the block
-- is exhausted. When the branch has never been issued a block, it falls back to the org's gapless
-- number_series, so every existing path keeps working. The block row is locked FOR UPDATE inside the
-- caller's transaction.
create or replace function app.claim_invoice_number(
  p_org_id uuid,
  p_branch_id uuid,
  p_series_code text default 'INVOICE'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_block public.number_blocks;
  v_value bigint;
  v_has_blocks boolean;
begin
  select * into v_block
    from public.number_blocks b
   where b.org_id = p_org_id
     and b.branch_id = p_branch_id
     and b.series_code = p_series_code
     and b.next_value <= b.last_value
   order by b.block_no
   limit 1
   for update;

  if found then
    v_value := v_block.next_value;
    update public.number_blocks
       set next_value = v_value + 1
     where id = v_block.id;
    return lpad(v_value::text, 6, '0');
  end if;

  -- No active block. If this branch has never been issued a block, it is not in block mode: use the
  -- org's gapless number series, exactly as before H3.
  select exists (
    select 1 from public.number_blocks b
     where b.org_id = p_org_id and b.branch_id = p_branch_id and b.series_code = p_series_code
  ) into v_has_blocks;

  if not v_has_blocks then
    return app.next_number(p_org_id, p_series_code);
  end if;

  raise exception 'invoice number block exhausted for branch %: no numbers available offline, and no block left to claim', p_branch_id
    using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fiscal row enqueue. One pending row per invoice, in the invoice's own transaction. Idempotent
-- per (org_id, invoice_id), so a retried invoice cannot queue a second fiscal row.
--
-- Branch-only: the FDMS device lives at the branch, so only the branch queues fiscal rows. The
-- cloud replays invoices but does not submit them to FDMS (ADR-0035). Gated by app.branch_mode,
-- exactly like the H2 outbox triggers, so the cloud's write path stays free of fiscal rows.
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_invoice_enqueue(
  p_org_id uuid,
  p_branch_id uuid,
  p_invoice_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_invoice_no text;
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  select i.invoice_no into v_invoice_no
    from public.invoices i
   where i.id = p_invoice_id;

  insert into public.fiscal_invoices
    (org_id, branch_id, invoice_id, fdms_payload, status, attempts, next_attempt_at)
  values
    (p_org_id, p_branch_id, p_invoice_id,
     jsonb_build_object('invoice_id', p_invoice_id, 'invoice_no', v_invoice_no,
                        'queued_at', now()),
     'pending', 0, now())
  on conflict (org_id, invoice_id) do nothing
  returning id into v_id;

  if v_id is null then
    select fi.id into v_id
      from public.fiscal_invoices fi
     where fi.org_id = p_org_id and fi.invoice_id = p_invoice_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim the pending rows the worker may submit now, oldest first. FOR UPDATE SKIP LOCKED, so two
-- workers running at once claim disjoint sets and never submit the same invoice twice (test 68).
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_claim_pending(
  p_org_id uuid,
  p_branch_id uuid,
  p_limit int default 50
)
returns setof public.fiscal_invoices
language sql
volatile
as $$
  select fi.*
    from public.fiscal_invoices fi
   where fi.org_id = p_org_id
     and fi.branch_id = p_branch_id
     and fi.status = 'pending'
     and fi.next_attempt_at <= now()
   order by fi.created_at, fi.id
   limit greatest(p_limit, 0)
   for update skip locked;
$$;

-- ---------------------------------------------------------------------------
-- Record the outcome of a real FDMS submission.
--   * 'sent'        -> status sent, fdms_response stored.
--   * 'failed'      -> a REAL rejection: attempts + 1. At 5 real rejections the row moves to failed.
--   * 'unreachable' -> a NETWORK OUTAGE: status stays pending and attempts is NOT incremented; the
--                      row is simply due again after a short backoff.
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_invoice_attempt(
  p_org_id uuid,
  p_branch_id uuid,
  p_fiscal_invoice_id uuid,
  p_outcome text,
  p_response jsonb default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.fiscal_invoices;
  v_next   int;
  v_status text;
  v_attempts int;
  v_backoff_seconds int;
begin
  if p_outcome not in ('sent', 'failed', 'unreachable') then
    raise exception 'unknown fiscal outcome %', p_outcome using errcode = '23514';
  end if;

  select * into v_row
    from public.fiscal_invoices fi
   where fi.id = p_fiscal_invoice_id
     and fi.org_id = p_org_id
     and fi.branch_id = p_branch_id
   for update;

  if not found then
    raise exception 'no fiscal invoice % for this branch', p_fiscal_invoice_id
      using errcode = 'no_data_found';
  end if;

  -- The attempt row is appended for every real submission (sent/failed). An outage is not a real
  -- submission, so it is not appended and it does not move the attempt count.
  if p_outcome in ('sent', 'failed') then
    select coalesce(max(a.attempt_no), 0) + 1 into v_next
      from public.fiscal_invoice_attempts a
     where a.fiscal_invoice_id = p_fiscal_invoice_id;

    insert into public.fiscal_invoice_attempts
      (org_id, branch_id, fiscal_invoice_id, attempt_no, outcome, error)
    values (p_org_id, p_branch_id, p_fiscal_invoice_id, v_next, p_outcome, p_error);
  end if;

  if p_outcome = 'sent' then
    v_status := 'sent';
    v_attempts := v_row.attempts;
    update public.fiscal_invoices
       set status = 'sent',
           fdms_response = coalesce(p_response, fdms_response),
           last_error = null,
           sent_at = now(),
           updated_at = now()
     where id = p_fiscal_invoice_id;
  elsif p_outcome = 'failed' then
    v_attempts := v_row.attempts + 1;
    -- Five real rejections move the row to failed; before that it stays pending and retries.
    v_status := case when v_attempts >= 5 then 'failed' else 'pending' end;
    -- Exponential backoff between real rejections, capped at 1 hour.
    v_backoff_seconds := least(30 * power(2, greatest(v_attempts - 1, 0))::int, 3600);
    update public.fiscal_invoices
       set status = v_status,
           attempts = v_attempts,
           last_error = p_error,
           fdms_response = coalesce(p_response, fdms_response),
           next_attempt_at = case
             when v_status = 'failed' then next_attempt_at
             else now() + make_interval(secs => v_backoff_seconds)
           end,
           updated_at = now()
     where id = p_fiscal_invoice_id;
  else
    -- Outage: stays pending, attempts unchanged, retry after a short fixed backoff.
    v_status := 'pending';
    v_attempts := v_row.attempts;
    update public.fiscal_invoices
       set status = 'pending',
           last_error = coalesce(p_error, last_error),
           next_attempt_at = now() + interval '30 seconds',
           updated_at = now()
     where id = p_fiscal_invoice_id;
  end if;

  return jsonb_build_object(
    'fiscal_invoice_id', p_fiscal_invoice_id,
    'status', v_status,
    'attempts', v_attempts
  );
end;
$$;

-- Admin: retry a failed row. Clears the attempt counter and re-arms it as pending. The failed
-- attempts stay in fiscal_invoice_attempts (append-only audit); a fresh attempt series starts.
create or replace function app.fiscal_invoice_retry(
  p_org_id uuid,
  p_branch_id uuid,
  p_fiscal_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select fi.status into v_status
    from public.fiscal_invoices fi
   where fi.id = p_fiscal_invoice_id
     and fi.org_id = p_org_id
     and fi.branch_id = p_branch_id
   for update;

  if v_status is null then
    raise exception 'no fiscal invoice % for this branch', p_fiscal_invoice_id
      using errcode = 'no_data_found';
  end if;
  if v_status <> 'failed' then
    raise exception 'fiscal invoice % is % and cannot be retried; only a failed row can be retried',
      p_fiscal_invoice_id, v_status using errcode = '23514';
  end if;

  update public.fiscal_invoices
     set status = 'pending',
         attempts = 0,
         last_error = null,
         next_attempt_at = now(),
         updated_at = now()
   where id = p_fiscal_invoice_id;

  return jsonb_build_object('fiscal_invoice_id', p_fiscal_invoice_id, 'status', 'pending',
                            'attempts', 0);
end;
$$;

-- Admin: manual submit. Re-arm a failed OR pending row as due now (attempts preserved), so the
-- worker picks it up on the next tick.
create or replace function app.fiscal_invoice_manual_send(
  p_org_id uuid,
  p_branch_id uuid,
  p_fiscal_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select fi.status into v_status
    from public.fiscal_invoices fi
   where fi.id = p_fiscal_invoice_id
     and fi.org_id = p_org_id
     and fi.branch_id = p_branch_id
   for update;

  if v_status is null then
    raise exception 'no fiscal invoice % for this branch', p_fiscal_invoice_id
      using errcode = 'no_data_found';
  end if;
  if v_status = 'sent' then
    raise exception 'fiscal invoice % is already sent', p_fiscal_invoice_id
      using errcode = '23514';
  end if;

  update public.fiscal_invoices
     set status = 'pending',
         next_attempt_at = now(),
         updated_at = now()
   where id = p_fiscal_invoice_id;

  return jsonb_build_object('fiscal_invoice_id', p_fiscal_invoice_id, 'status', 'pending');
end;
$$;

-- Admin: the queue, newest first, keyset on (created_at, id), never OFFSET.
create or replace function app.fiscal_invoice_queue(
  p_org_id uuid,
  p_branch_id uuid,
  p_limit int default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns table (
  id uuid, invoice_id uuid, invoice_no text, status text, attempts int, last_error text,
  fdms_response jsonb, created_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select fi.id, fi.invoice_id, i.invoice_no, fi.status, fi.attempts, fi.last_error,
         fi.fdms_response, fi.created_at, fi.updated_at
    from public.fiscal_invoices fi
    join public.invoices i on i.id = fi.invoice_id
   where fi.org_id = p_org_id
     and fi.branch_id = p_branch_id
     and (p_after_created_at is null or (fi.created_at, fi.id) < (p_after_created_at, p_after_id))
   order by fi.created_at desc, fi.id desc
   limit v_limit;
end;
$$;

-- Admin: counts by status for the branch.
create or replace function app.fiscal_invoice_summary(
  p_org_id uuid,
  p_branch_id uuid
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'sent',    count(*) filter (where status = 'sent'),
    'failed',  count(*) filter (where status = 'failed'),
    'total',   count(*)
  )
    from public.fiscal_invoices
   where org_id = p_org_id
     and branch_id = p_branch_id;
$$;

-- The receipt's fiscal block. 'sent' carries the FDMS response (its signature and QR); anything
-- else reads "fiscal pending". The ZIMRA rule on what a receipt must show is an open item
-- (ADR-0003, ADR-0036); this only reports what the device returned.
create or replace function app.pos_sale_fiscal(p_invoice_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select case
       when fi.status = 'sent' then jsonb_build_object(
         'status', 'sent',
         'signature', fi.fdms_response ->> 'signature',
         'qr_code', fi.fdms_response ->> 'qr_code',
         'receipt_no', fi.fdms_response ->> 'receipt_no',
         'sent_at', fi.sent_at
       )
       else jsonb_build_object('status', 'pending', 'message', 'fiscal pending')
     end
     from public.fiscal_invoices fi
     where fi.invoice_id = p_invoice_id),
    jsonb_build_object('status', 'none')
  );
$$;

-- ---------------------------------------------------------------------------
-- Cloud: reserve a contiguous block of invoice numbers for a branch. The block is carved from the
-- org's number series under a FOR UPDATE lock on that series row, so two cloud requests can never
-- hand out overlapping ranges (and therefore two branches can never receive the same number).
-- ---------------------------------------------------------------------------
create or replace function app.issue_number_block(
  p_org_id uuid,
  p_branch_id uuid,
  p_series_code text default 'INVOICE',
  p_size int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_size int := greatest(coalesce(p_size, 200), 1);
  v_block_no bigint;
  v_first bigint;
  v_last bigint;
begin
  -- Lock the branch row so concurrent issues for the same branch serialise.
  perform 1 from public.branches b where b.id = p_branch_id and b.org_id = p_org_id for update;

  -- The org's series row is the single counter of how far the org has issued numbers. Locking it
  -- FOR UPDATE means two cloud requests (for the same or different branches) can never be handed
  -- overlapping ranges, so no two branches can ever be issued the same invoice number.
  insert into public.number_series (org_id, code, prefix, pad_width)
  values (p_org_id, p_series_code, '', 6)
  on conflict (org_id, code) do nothing;

  perform 1 from public.number_series ns
   where ns.org_id = p_org_id and ns.code = p_series_code for update;

  select ns.next_value into v_first
    from public.number_series ns
   where ns.org_id = p_org_id and ns.code = p_series_code;

  v_last := v_first + v_size - 1;
  -- The starting value is itself unique per org, so it serves as the block number.
  v_block_no := v_first;

  update public.number_series
     set next_value = v_last + 1
   where org_id = p_org_id and code = p_series_code;

  insert into public.number_blocks
    (org_id, branch_id, series_code, block_no, first_value, last_value, next_value)
  values
    (p_org_id, p_branch_id, p_series_code, v_block_no, v_first, v_last, v_first);

  return jsonb_build_object(
    'block_no', v_block_no, 'first_value', v_first, 'last_value', v_last, 'size', v_size
  );
end;
$$;

-- Branch: request the next block from the cloud and store it locally. The cloud URL is passed in by
-- the caller (the branch's request path), and the fetched block is inserted with the SAME bounds the
-- cloud assigned, so the branch and cloud agree.
create or replace function app.store_number_block(
  p_org_id uuid,
  p_branch_id uuid,
  p_block_no bigint,
  p_first_value bigint,
  p_last_value bigint,
  p_series_code text default 'INVOICE'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.number_blocks
    (org_id, branch_id, series_code, block_no, first_value, last_value, next_value)
  values
    (p_org_id, p_branch_id, p_series_code, p_block_no, p_first_value, p_last_value, p_first_value)
  on conflict (org_id, branch_id, series_code, block_no) do nothing;

  return app.number_block_status(p_org_id, p_branch_id, p_series_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants.
-- ---------------------------------------------------------------------------
select app.apply_tenant_rls('public.fiscal_invoices', 'branch');
select app.apply_tenant_rls('public.fiscal_invoice_attempts', 'branch');
select app.apply_tenant_rls('public.number_blocks', 'branch');

-- Attempts are append-only, like the ledger.
select app.enforce_immutable('public.fiscal_invoice_attempts');

grant execute on function app.fiscal_invoice_enqueue(uuid, uuid, uuid)
  to authenticated, service_role;
grant execute on function app.fiscal_claim_pending(uuid, uuid, int) to authenticated, service_role;
grant execute on function app.fiscal_invoice_attempt(uuid, uuid, uuid, text, jsonb, text)
  to authenticated, service_role;
grant execute on function app.fiscal_invoice_retry(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.fiscal_invoice_manual_send(uuid, uuid, uuid)
  to authenticated, service_role;
grant execute on function app.fiscal_invoice_queue(uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.fiscal_invoice_summary(uuid, uuid) to authenticated, service_role;
grant execute on function app.pos_sale_fiscal(uuid) to authenticated, service_role;
grant execute on function app.issue_number_block(uuid, uuid, text, int)
  to authenticated, service_role;
grant execute on function app.store_number_block(uuid, uuid, bigint, bigint, bigint, text)
  to authenticated, service_role;
grant execute on function app.claim_invoice_number(uuid, uuid, text)
  to authenticated, service_role;
grant execute on function app.number_block_status(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.number_block_active(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Core function RE-CREATION (additive hooks only; signatures unchanged). The newest definition
-- wins, exactly as R4 re-created create_invoice and consume_fifo (ADR-0016).
--
--   * create_invoice now calls app.claim_invoice_number (block-aware) instead of app.next_number
--     directly, and enqueues the pending fiscal row in the same transaction.
--   * pos_sale_receipt now returns a `fiscal` block (signature/QR when sent, else "fiscal pending").
-- ---------------------------------------------------------------------------
create or replace function app.create_invoice(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_contact_id   uuid,
  p_invoice_date date,
  p_lines        jsonb,
  p_currency     text default 'USD',
  p_sales_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_at  timestamptz := clock_timestamp();
  v_invoice_id  uuid := gen_random_uuid();
  v_invoice_no  text;
  v_currency    text := coalesce(p_currency, 'USD');
  v_rate        numeric;
  v_line        jsonb;
  v_line_no     int := 0;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_warehouse_id uuid;
  v_qty         numeric(19, 4);
  v_unit_price  numeric(19, 4);
  v_discount    numeric(19, 4);
  v_subtotal    numeric(19, 4);
  v_tax_rate_id uuid;
  v_tax_rate    numeric(9, 6);
  v_line_tax    numeric(19, 4);
  v_line_total  numeric(19, 4);
  v_sum_subtotal numeric(19, 4) := 0;
  v_sum_tax     numeric(19, 4) := 0;
  v_sum_total   numeric(19, 4) := 0;
  v_cogs        numeric(19, 4) := 0;
  v_keys        jsonb := '[]'::jsonb;
  v_key         record;
  v_avail       numeric(19, 4);
  v_allow_neg   boolean;
  v_journal     uuid;
  v_ledger_id   uuid;
  v_line_rows   jsonb := '[]'::jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_invoice requires at least one line' using errcode = '23514';
  end if;

  perform app.assert_period_open(p_org_id, p_invoice_date);

  v_rate := app.rate_on(p_org_id, v_currency, p_invoice_date);
  if v_rate is null then
    raise exception 'no exchange rate for % effective on %', v_currency, p_invoice_date
      using errcode = 'no_data_found';
  end if;

  -- Pass 1: validate lines and collect the stock keys this invoice will touch.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(v_line ->> 'variant_id', '')::uuid;
    v_warehouse_id := (v_line ->> 'warehouse_id')::uuid;
    v_keys := v_keys || jsonb_build_object(
      'warehouse_id', v_warehouse_id, 'product_id', v_product_id, 'variant_id', v_variant_id
    );
  end loop;

  -- Lock stock_balances rows in ascending (warehouse_id, product_id) order before touching
  -- anything. This is what keeps concurrent invoices from deadlocking.
  perform app.lock_stock_balances(p_org_id, p_branch_id, v_keys);

  -- Availability check, aggregated per key so repeated lines are counted together.
  for v_key in
    select (l ->> 'warehouse_id')::uuid as warehouse_id,
           (l ->> 'product_id')::uuid as product_id,
           nullif(l ->> 'variant_id', '')::uuid as variant_id,
           sum((l ->> 'qty')::numeric) as needed
      from jsonb_array_elements(p_lines) as l
     group by 1, 2, 3
     order by 1, 2, 3 nulls first
  loop
    select coalesce(sum(sb.qty_remaining), 0) into v_avail
      from public.stock_layer_balances sb
     where sb.org_id = p_org_id
       and sb.warehouse_id = v_key.warehouse_id
       and sb.product_id = v_key.product_id
       and sb.variant_id is not distinct from v_key.variant_id
       and sb.qty_remaining > 0;

    select w.allow_negative_stock into v_allow_neg
      from public.warehouses w where w.id = v_key.warehouse_id;

    if v_avail < v_key.needed and not (coalesce(v_allow_neg, false) or app.negative_stock_allowed()) then
      raise exception 'insufficient stock for product %: available %, required %',
        v_key.product_id, v_avail, v_key.needed using errcode = '23514';
    end if;
  end loop;

  -- Pass 2: price the lines, consume FIFO layers and record COGS.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(v_line ->> 'variant_id', '')::uuid;
    v_warehouse_id := (v_line ->> 'warehouse_id')::uuid;
    v_qty := (v_line ->> 'qty')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;
    v_discount := coalesce((v_line ->> 'discount')::numeric, 0);

    if v_qty <= 0 then
      raise exception 'invoice line quantity must be positive' using errcode = '23514';
    end if;

    v_subtotal := round(v_qty * v_unit_price - v_discount, 4);

    -- The rate this line used. Stored on the line; never recomputed later.
    if v_line ? 'tax_rate_code' and (v_line ->> 'tax_rate_code') is not null then
      select r.id, r.rate into v_tax_rate_id, v_tax_rate
        from public.tax_rates r
       where r.org_id = p_org_id
         and r.code = (v_line ->> 'tax_rate_code')
         and r.effective_from <= p_invoice_date
         and (r.effective_to is null or r.effective_to >= p_invoice_date)
       order by r.effective_from desc
       limit 1;
    end if;
    v_tax_rate := coalesce(v_tax_rate, 0);

    v_line_tax := round(v_subtotal * v_tax_rate, 4);
    v_line_total := v_subtotal + v_line_tax;

    -- Outbound ledger row for this line, then FIFO consumption against it.
    v_ledger_id := gen_random_uuid();
    insert into public.stock_ledger
      (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
       source_type, source_id, created_at)
    values
      (v_ledger_id, p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, 'out',
       v_qty, 0, 'sale', v_invoice_id, v_created_at);

    declare
      v_line_cost numeric(19, 4) := app.consume_fifo(
        p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, v_qty,
        v_ledger_id, v_created_at
      );
    begin
      v_cogs := v_cogs + v_line_cost;

      v_line_rows := v_line_rows || jsonb_build_object(
        'line_no', v_line_no,
        'product_id', v_product_id,
        'variant_id', v_variant_id,
        'warehouse_id', v_warehouse_id,
        'description', v_line ->> 'description',
        'qty', v_qty,
        'unit_price', v_unit_price,
        'unit_cost', round(v_line_cost / v_qty, 4),
        'discount', v_discount,
        'tax_rate_id', v_tax_rate_id,
        'tax_rate', v_tax_rate,
        'line_subtotal', v_subtotal,
        'line_tax', v_line_tax,
        'line_total', v_line_total
      );

      insert into public.stock_balances
        (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
      values
        (p_org_id, p_branch_id, v_warehouse_id, v_product_id, v_variant_id, -v_qty, -v_line_cost)
      on conflict (org_id, warehouse_id, product_id, variant_id) do update
        set qty   = public.stock_balances.qty + excluded.qty,
            value = public.stock_balances.value + excluded.value;
    end;
    v_tax_rate_id := null;

    v_sum_subtotal := v_sum_subtotal + v_subtotal;
    v_sum_tax      := v_sum_tax + v_line_tax;
    v_sum_total    := v_sum_total + v_line_total;
  end loop;

  -- Gapless invoice number. Locked FOR UPDATE inside this transaction, so a rollback does not
  -- consume a number.
  -- H3: take the number from the branch's local block when it uses blocks, else the org series.
  v_invoice_no := app.claim_invoice_number(p_org_id, p_branch_id, 'INVOICE');

  -- Dr AR / Cr Revenue / Cr VAT Output / Dr COGS / Cr Inventory.
  v_journal := app.post_journal(
    p_org_id, p_branch_id, p_invoice_date, 'invoice', v_invoice_id, 'Invoice ' || v_invoice_no,
    v_currency,
    jsonb_build_array(
      jsonb_build_object('account_code', '1100', 'debit', v_sum_total, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Accounts receivable'),
      jsonb_build_object('account_code', '4000', 'credit', v_sum_subtotal, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Sales revenue'),
      jsonb_build_object('account_code', '2100', 'credit', v_sum_tax, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'VAT output'),
      jsonb_build_object('account_code', '5000', 'debit', v_cogs, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Cost of goods sold'),
      jsonb_build_object('account_code', '1000', 'credit', v_cogs, 'currency', v_currency,
                         'exchange_rate', v_rate, 'description', 'Inventory')
    )
  );

  insert into public.invoices
    (id, org_id, branch_id, contact_id, sales_order_id, invoice_no, invoice_date, currency,
     exchange_rate, subtotal, tax_total, total, journal_id, journal_created_at, created_at)
  select v_invoice_id, p_org_id, p_branch_id, p_contact_id, p_sales_order_id, v_invoice_no,
         p_invoice_date, v_currency, v_rate, v_sum_subtotal, v_sum_tax, v_sum_total,
         v_journal, j.created_at, v_created_at
    from public.journals j
   where j.id = v_journal;

  insert into public.invoice_lines
    (org_id, branch_id, invoice_id, line_no, product_id, variant_id,
     warehouse_id, description, qty, unit_price, unit_cost, discount, tax_rate_id, tax_rate,
     line_subtotal, line_tax, line_total)
  select p_org_id, p_branch_id, v_invoice_id,
         (l ->> 'line_no')::int,
         (l ->> 'product_id')::uuid,
         nullif(l ->> 'variant_id', '')::uuid,
         (l ->> 'warehouse_id')::uuid,
         l ->> 'description',
         (l ->> 'qty')::numeric,
         (l ->> 'unit_price')::numeric,
         (l ->> 'unit_cost')::numeric,
         (l ->> 'discount')::numeric,
         nullif(l ->> 'tax_rate_id', '')::uuid,
         (l ->> 'tax_rate')::numeric,
         (l ->> 'line_subtotal')::numeric,
         (l ->> 'line_tax')::numeric,
         (l ->> 'line_total')::numeric
    from jsonb_array_elements(v_line_rows) as l;

  -- H3: enqueue the pending fiscal invoice in the SAME transaction as the invoice, so a
  -- committed invoice always has its fiscal row and a rolled-back one leaves none.
  perform app.fiscal_invoice_enqueue(p_org_id, p_branch_id, v_invoice_id);

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_no', v_invoice_no,
    'subtotal', v_sum_subtotal,
    'tax_total', v_sum_tax,
    'total', v_sum_total
  );
end;
$$;
create or replace function app.pos_sale_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale      public.pos_sales%rowtype;
  v_invoice   public.invoices%rowtype;
  v_payments  jsonb;
  v_lines     jsonb;
  v_change    numeric(19, 4);
  v_fiscal    jsonb;
begin
  select * into v_sale from public.pos_sales where id = p_sale_id;
  if not found then
    raise exception 'pos sale % not found', p_sale_id using errcode = 'no_data_found';
  end if;

  select * into v_invoice from public.invoices where id = v_sale.invoice_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'method', pp.method,
           'currency', pp.currency,
           'amount_tendered', pp.amount_tendered,
           'amount_applied', pp.amount_applied,
           'rate', pp.rate,
           'base_amount', pp.base_amount,
           'change_given', pp.change_given
         ) order by pp.created_at, pp.id), '[]'::jsonb),
         coalesce(sum(pp.change_given), 0)
    into v_payments, v_change
    from public.pos_payments pp
   where pp.sale_id = p_sale_id
     and pp.sale_created_at = v_sale.created_at;

  select coalesce(jsonb_agg(jsonb_build_object(
           'line_no', il.line_no,
           'description', il.description,
           'qty', il.qty,
           'unit_price', il.unit_price,
           'line_subtotal', il.line_subtotal,
           'line_tax', il.line_tax,
           'line_total', il.line_total,
           'tax_rate', il.tax_rate
         ) order by il.line_no), '[]'::jsonb)
    into v_lines
    from public.invoice_lines il
   where il.invoice_id = v_sale.invoice_id;

  -- H3: the fiscal state of the invoice's fiscal row (signature/QR when sent, else pending).
  v_fiscal := app.pos_sale_fiscal(v_sale.invoice_id);

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'invoice_id', v_sale.invoice_id,
    'invoice_no', v_invoice.invoice_no,
    'subtotal', v_invoice.subtotal,
    'tax_total', v_invoice.tax_total,
    'total', v_invoice.total,
    'change_total', v_change,
    'currency', v_invoice.currency,
    'lines', v_lines,
    'payments', v_payments,
    'fiscal', v_fiscal
  );
end;
$$;