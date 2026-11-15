-- Every foreign key column must have an index.
--
-- Returns one row per foreign key that has no index whose leading columns match the FK columns
-- in order. Zero rows means the invariant holds.
--
-- Partition children inherit their parent's indexes and are excluded: only the declared table
-- (relispartition = false) is checked.

with fks as (
  select
    n.nspname                 as schema_name,
    cl.relname                as table_name,
    c.conname                 as constraint_name,
    c.conrelid                as table_oid,
    ('{' || replace(translate(c.conkey::text, '{}', ''), ' ', ',') || '}')::int[] as fk_cols,
    array_length(c.conkey, 1) as ncols
  from pg_constraint c
  join pg_class cl    on cl.oid = c.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  where c.contype = 'f'
    and n.nspname = 'public'
    and cl.relispartition = false
),
idx as (
  select
    i.indrelid,
    ('{' || replace(translate(i.indkey::text, '{}', ''), ' ', ',') || '}')::int[] as idx_cols,
    i.indnkeyatts   as nkeyatts
  from pg_index i
  where i.indisvalid
)
select f.schema_name, f.table_name, f.constraint_name
from fks f
where not exists (
  select 1
  from idx i
  where i.indrelid = f.table_oid
    and i.nkeyatts >= f.ncols
    and i.idx_cols[1:f.ncols] = f.fk_cols[1:f.ncols]
)
order by f.table_name, f.constraint_name;
