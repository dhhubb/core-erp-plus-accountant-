#!/usr/bin/env bash
# Apply every migration to an empty local Postgres, the equivalent of `supabase db reset`.
#
# It first bootstraps the Supabase-shaped roles/schemas the migrations expect, then applies each
# migration under supabase/migrations in filename order inside a single transaction per file.
set -euo pipefail

: "${PGDATABASE:=postgres}"
: "${PGPORT:=54322}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_psql() {
  sudo -n -u postgres psql -v ON_ERROR_STOP=1 -p "$PGPORT" -d "$PGDATABASE" "$@"
}

run_file() {
  # The workspace is not readable by the postgres OS user, so feed the file on stdin.
  sudo -n -u postgres psql -v ON_ERROR_STOP=1 -p "$PGPORT" -d "$PGDATABASE" -q <"$1"
}

# A clean public and app schema, keeping the Supabase-shaped roles/schemas the bootstrap creates.
run_psql -c "drop schema if exists public cascade; create schema public; drop schema if exists app cascade;" >/dev/null

run_file "$ROOT/scripts/local-db-bootstrap.sql" >/dev/null

for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$migration")"
  run_file "$migration" >/dev/null
done

echo "migrations applied to $PGDATABASE"
