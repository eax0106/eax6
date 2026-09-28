#!/usr/bin/env bash
# Task C3. Builds every database this system stores tenant data in, from each
# service's own migrations, inside one Postgres (pgvector image: ads,
# intelligence and memory need the vector extension). Prints the URL map the
# deletion certification reads, as DELETION_DATABASES JSON on stdout.
#
# Usage: scripts/deletion/materialize-schemas.sh <superuser URL ending in /postgres or any db>
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
admin="${1:?usage: materialize-schemas.sh <superuser database URL>}"
base="${admin%/*}"
log() { printf 'materialize: %s\n' "$*" >&2; }

databases=(platform_db orchestration_db audit_db cost_db ads_db intelligence_db policy_db eval_db)
for db in "${databases[@]}"; do
  psql "$admin" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 \
    || psql "$admin" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >&2
done
url() { printf '%s/%s' "$base" "$1"; }

cd "$repo"
log "platform_db (platform-api + marketplace)"
DATABASE_URL="$(url platform_db)" MARKETPLACE_DATABASE_URL="$(url platform_db)" \
  MARKETPLACE_SEARCH_CURSOR_SECRET=materialize SIGNING_KEY_PROVIDER=mock \
  pnpm --filter @alterx/platform-api db:migrate >&2
log "orchestration_db"; ORCHESTRATION_DATABASE_URL="$(url orchestration_db)" pnpm --filter @alterx/orchestration-service db:migrate >&2
log "audit_db"; AUDIT_DATABASE_URL="$(url audit_db)" pnpm --filter @alterx/audit-service db:migrate >&2
log "cost_db"; COST_DATABASE_URL="$(url cost_db)" pnpm --filter @alterx/cost-ledger-service db:migrate >&2

alembic_upgrade() { # <app dir> <database>
  local sync="${base/#postgresql:/postgresql+psycopg2:}"
  sync="${sync/#postgres:/postgresql+psycopg2:}"
  (cd "apps/$1" && uv run --quiet python - "$sync/$2" <<'PY' >&2
import sys
from alembic import command
from alembic.config import Config
config = Config("alembic.ini")
config.set_main_option("sqlalchemy.url", sys.argv[1])
command.upgrade(config, "head")
PY
  )
}
for pair in ads-core:ads_db intelligence-service:intelligence_db memory-service:policy_db eval-service:eval_db; do
  log "${pair#*:}"; alembic_upgrade "${pair%%:*}" "${pair#*:}"
done

printf '{'
first=1
for db in "${databases[@]}"; do
  [[ $first == 1 ]] || printf ','
  first=0
  printf '"%s":"%s"' "$db" "$(url "$db")"
done
printf '}\n'
