-- 0001: base extensions, schema and generic helpers.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;

comment on schema app is 'ERP core helper objects (not exposed through the Data API).';

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- JWT accessors. Claims are minted by the Supabase custom access token hook (migration 0007).
-- Both keys are quoted: the claim is a top-level JSON key named "org_id" / "branch_ids".
create or replace function app.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'org_id', '')::uuid;
$$;

create or replace function app.current_branch_ids()
returns uuid[]
language sql
stable
as $$
  select coalesce(
    (select array_agg(value::uuid)
       from jsonb_array_elements_text(
              coalesce(auth.jwt() -> 'branch_ids', '[]'::jsonb)
            ) as value),
    '{}'::uuid[]
  );
$$;
