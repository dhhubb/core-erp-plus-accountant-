-- R6: Fiscal integration adapter (Retail vertical).
--
-- Additive only. Nothing here edits an applied migration or a core accounting path. The fiscal
-- adapter is a QUEUE. When a sale commits and the branch's integration mode is `async`, exactly one
-- job row is appended. Nothing beyond that insert sits on the sale path: there is no network call,
-- no wait, and no dependency on the device. A worker drains the queue later, with backoff.
--
-- Adds:
--   * public.fiscal_device_integration (org + branch; the per-branch device config and mode)
--   * public.fiscal_jobs              (org + branch; the APPEND-ONLY job queue)
--   * public.fiscal_job_attempts      (org + branch; APPEND-ONLY delivery attempts)
--
--   * app.enqueue_fiscal_job(...)     — insert exactly one job when the branch mode is 'async'.
--   * app.fiscal_jobs_due(...)        — the queued, not-yet-sent jobs whose backoff has elapsed.
--   * app.record_fiscal_attempt(...)  — append one delivery attempt (the job row is never updated).
--   * app.fiscal_enqueue_on_sale()    — AFTER INSERT trigger on pos_sales; the only fiscal work on
--                                       the sale path is this one insert.
--
-- Design notes (ADR-0022):
--   * Mode is per branch and is one of 'none' or 'async'. There is deliberately no 'blocking' mode:
--     whether ZIMRA requires printing at the moment of sale is an OPEN ITEM (see docs/ADR.md). A
--     blocking mode is a separate future run. The check constraint rejects any other value, so the
--     decision cannot be made by accident.
--   * The queue is append-only. A job row is immutable and its terminal state is DERIVED from its
--     fiscal_job_attempts rows, so the worker records delivery without ever updating a job.

-- ---------------------------------------------------------------------------
-- Per-branch device integration. `mode` decides whether a sale queues a job; `status` is the
-- device's operational state; `payload` carries the device configuration (for example the endpoint
-- URL and the fiscal device serial). Org + branch scoped, exactly one row per branch.
-- ---------------------------------------------------------------------------
create table public.fiscal_device_integration (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  device_type  text not null default 'none',
  mode         text not null default 'none',
  status       text not null default 'active',
  last_sync    timestamptz,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fiscal_device_integration_device_type_check
    check (device_type in ('none', 'zimra_fdms', 'generic_http')),
  -- 'blocking' is intentionally absent. Adding it is a separate future run and needs an ADR.
  constraint fiscal_device_integration_mode_check check (mode in ('none', 'async')),
  constraint fiscal_device_integration_status_check
    check (status in ('active', 'inactive', 'error')),
  constraint fiscal_device_integration_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint fiscal_device_integration_branch_key unique (org_id, branch_id)
);

create index fiscal_device_integration_org_created_idx
  on public.fiscal_device_integration (org_id, created_at desc, id desc);
create index fiscal_device_integration_org_branch_created_idx
  on public.fiscal_device_integration (org_id, branch_id, created_at desc, id desc);
create index fiscal_device_integration_branch_id_idx
  on public.fiscal_device_integration (branch_id);

-- ---------------------------------------------------------------------------
-- The job queue. APPEND-ONLY: a job is inserted once and never updated or deleted, so delivery
-- state lives in fiscal_job_attempts. The brief's index (org_id, branch_id, status, created_at)
-- serves "the queued jobs for this branch, oldest first". unique (org_id, sale_id) is what makes
-- the guarantee "exactly one fiscal job per sale" hold even if the enqueue is retried.
-- ---------------------------------------------------------------------------
create table public.fiscal_jobs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  branch_id   uuid not null references public.branches (id) on delete restrict,
  sale_id     uuid not null,
  invoice_id  uuid references public.invoices (id) on delete restrict,
  status      text not null default 'queued',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- A job row is always born 'queued'; it is never updated, so this is the only value it holds.
  constraint fiscal_jobs_status_check check (status in ('queued')),
  constraint fiscal_jobs_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint fiscal_jobs_sale_key unique (org_id, sale_id)
);

create index fiscal_jobs_org_branch_status_created_idx
  on public.fiscal_jobs (org_id, branch_id, status, created_at);
create index fiscal_jobs_org_branch_created_idx
  on public.fiscal_jobs (org_id, branch_id, created_at desc, id desc);
create index fiscal_jobs_org_created_idx
  on public.fiscal_jobs (org_id, created_at desc, id desc);
create index fiscal_jobs_branch_id_idx on public.fiscal_jobs (branch_id);
create index fiscal_jobs_sale_id_idx on public.fiscal_jobs (sale_id);
create index fiscal_jobs_invoice_id_idx on public.fiscal_jobs (invoice_id);

-- ---------------------------------------------------------------------------
-- Delivery attempts. APPEND-ONLY: every send attempt is a new row. The worker reads the newest
-- attempt to decide the backoff, and a 'sent' attempt is what marks a job done.
-- ---------------------------------------------------------------------------
create table public.fiscal_job_attempts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  branch_id    uuid not null references public.branches (id) on delete restrict,
  job_id       uuid not null references public.fiscal_jobs (id) on delete restrict,
  attempt_no   int not null,
  outcome      text not null,
  error        text,
  attempted_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint fiscal_job_attempts_outcome_check
    check (outcome in ('sent', 'failed', 'unreachable')),
  constraint fiscal_job_attempts_attempt_key unique (job_id, attempt_no)
);

create index fiscal_job_attempts_org_branch_created_idx
  on public.fiscal_job_attempts (org_id, branch_id, created_at desc, id desc);
create index fiscal_job_attempts_org_created_idx
  on public.fiscal_job_attempts (org_id, created_at desc, id desc);
create index fiscal_job_attempts_branch_id_idx on public.fiscal_job_attempts (branch_id);
create index fiscal_job_attempts_job_idx on public.fiscal_job_attempts (job_id);

select app.apply_tenant_rls('public.fiscal_device_integration', 'branch');
select app.apply_tenant_rls('public.fiscal_jobs', 'branch');
select app.apply_tenant_rls('public.fiscal_job_attempts', 'branch');

-- The queue and its attempts are append-only, like the ledger: no UPDATE and no DELETE, and the
-- privileges are revoked from authenticated.
select app.enforce_immutable('public.fiscal_jobs');
select app.enforce_immutable('public.fiscal_job_attempts');

-- ---------------------------------------------------------------------------
-- Enqueue. One insert, and only when the branch mode is 'async'. No integration (or mode 'none')
-- means no job and no error: the sale path must never depend on the fiscal device. Idempotent per
-- sale, so a retried sale cannot queue a second job.
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_fiscal_job(
  p_org_id     uuid,
  p_branch_id  uuid,
  p_sale_id    uuid,
  p_invoice_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_job  uuid;
begin
  select fdi.mode into v_mode
    from public.fiscal_device_integration fdi
   where fdi.org_id = p_org_id
     and fdi.branch_id = p_branch_id;

  if v_mode is distinct from 'async' then
    return null;
  end if;

  insert into public.fiscal_jobs (org_id, branch_id, sale_id, invoice_id, status, payload)
  values (p_org_id, p_branch_id, p_sale_id, p_invoice_id, 'queued',
          jsonb_build_object('sale_id', p_sale_id, 'invoice_id', p_invoice_id))
  on conflict (org_id, sale_id) do nothing
  returning id into v_job;

  if v_job is null then
    select j.id into v_job
      from public.fiscal_jobs j
     where j.org_id = p_org_id and j.sale_id = p_sale_id;
  end if;

  return v_job;
end;
$$;

comment on function app.enqueue_fiscal_job(uuid, uuid, uuid, uuid) is
  'Appends one fiscal job for a sale when the branch mode is ''async''. The only fiscal work on the '
  'sale path. Idempotent per (org_id, sale_id).';

-- ---------------------------------------------------------------------------
-- The sale path hook. AFTER INSERT on the partitioned pos_sales parent, so it fires for every
-- completed sale (live or synced) in the same transaction. It performs the single enqueue insert
-- and nothing else: no network, no wait. A sale whose mode is 'none' is untouched.
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_enqueue_on_sale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.enqueue_fiscal_job(new.org_id, new.branch_id, new.id, new.invoice_id);
  return null;
end;
$$;

create trigger fiscal_enqueue_on_sale
  after insert on public.pos_sales
  for each row execute function app.fiscal_enqueue_on_sale();

-- ---------------------------------------------------------------------------
-- The jobs the worker may send now: queued, not yet sent, and past their backoff. Backoff is
-- exponential from the last attempt, capped. A job with no attempts is due immediately. This is
-- the single source of truth for the backoff, so the worker and the SQL agree.
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_jobs_due(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_now          timestamptz default now(),
  p_limit        int default 50,
  p_base_seconds int default 30,
  p_max_seconds  int default 3600
)
returns table (
  job_id          uuid,
  sale_id         uuid,
  invoice_id      uuid,
  payload         jsonb,
  attempts        int,
  next_attempt_at timestamptz
)
language sql
stable
as $$
  select j.id,
         j.sale_id,
         j.invoice_id,
         j.payload,
         coalesce(s.attempts, 0)::int as attempts,
         case
           when s.last_attempt_at is null then j.created_at
           else s.last_attempt_at + make_interval(
                  secs => least(
                    p_base_seconds * power(2, greatest(coalesce(s.attempts, 0) - 1, 0)),
                    p_max_seconds
                  )
                )
         end as next_attempt_at
    from public.fiscal_jobs j
    left join lateral (
      select count(*)::int        as attempts,
             max(a.attempted_at)  as last_attempt_at,
             bool_or(a.outcome = 'sent') as sent
        from public.fiscal_job_attempts a
       where a.job_id = j.id
    ) s on true
   where j.org_id = p_org_id
     and j.branch_id = p_branch_id
     and j.status = 'queued'
     and coalesce(s.sent, false) = false
     and (
       s.last_attempt_at is null
       or s.last_attempt_at + make_interval(
            secs => least(
              p_base_seconds * power(2, greatest(s.attempts - 1, 0)),
              p_max_seconds
            )
          ) <= p_now
     )
   order by j.created_at, j.id
   limit greatest(p_limit, 0);
$$;

-- ---------------------------------------------------------------------------
-- Record one delivery attempt. The job row is never updated: the attempt is appended, and the
-- job's terminal state is derived from its attempts. The job row is locked FOR UPDATE so two
-- workers cannot claim the same attempt number.
-- ---------------------------------------------------------------------------
create or replace function app.record_fiscal_attempt(
  p_org_id    uuid,
  p_branch_id uuid,
  p_job_id    uuid,
  p_outcome   text,
  p_error     text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale uuid;
  v_next int;
begin
  if p_outcome not in ('sent', 'failed', 'unreachable') then
    raise exception 'unknown fiscal attempt outcome %', p_outcome using errcode = '23514';
  end if;

  select j.sale_id into v_sale
    from public.fiscal_jobs j
   where j.id = p_job_id
     and j.org_id = p_org_id
     and j.branch_id = p_branch_id
   for update;

  if v_sale is null then
    raise exception 'no fiscal job % for this branch', p_job_id using errcode = 'no_data_found';
  end if;

  select coalesce(max(a.attempt_no), 0) + 1 into v_next
    from public.fiscal_job_attempts a
   where a.job_id = p_job_id;

  insert into public.fiscal_job_attempts
    (org_id, branch_id, job_id, attempt_no, outcome, error)
  values (p_org_id, p_branch_id, p_job_id, v_next, p_outcome, p_error);

  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
grant execute on function app.enqueue_fiscal_job(uuid, uuid, uuid, uuid)
  to authenticated, service_role;
grant execute on function app.fiscal_jobs_due(uuid, uuid, timestamptz, int, int, int)
  to authenticated, service_role;
grant execute on function app.record_fiscal_attempt(uuid, uuid, uuid, text, text)
  to authenticated, service_role;
