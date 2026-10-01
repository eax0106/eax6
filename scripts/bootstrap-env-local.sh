#!/usr/bin/env bash
# Bootstrap .env.local from .env.local.example so starting the stack is a step.
# .env.local.example is unsourceable: 25 uncommented lines carry <placeholder>
# values and bash reads '<' as a redirect, so `set -a; . .env.local.example`
# dies on line 11. No script turned it into a sourceable file, so the documented
# `cp .env.local.example .env.local` produced something materially different
# from what anyone runs. This fixes that. Project Revive task C21.
#
# Requirements (master prompt):
#  1. Generate every value that needs generating; keep INTERNAL_SERVICE_TOKEN
#     and INTERNAL_SERVICE_TOKEN_SHA256 consistent (sha256 of the token).
#  2. Propagate each password into every connection string that interpolates it.
#     AUDIT_DB_PASSWORD serves 5 strings across 4 databases (policy_db,
#     orchestration_db, audit_db, eval_db); MEMORY_DB_PASSWORD = AUDIT_DB_PASSWORD
#     (engine-db-init.sh defaults it so).
#  3. NEVER clobber an existing .env.local. Default refuses; --merge preserves
#     every existing real value and only fills absent/placeholder keys.
#  4. Idempotent. --merge re-run does not regenerate passwords a running
#     database was already created with.
#
# Two placeholders are referenced but never defined in the example. Authority
# is docker-compose.yml + init scripts, not the example:
#   ADS_DB_PASSWORD    -> ads_core_local (hardcoded in ads-db compose service
#                         POSTGRES_PASSWORD; example's own header documents it).
#                         NOT generated, NOT the audit password.
#   MEMORY_DB_PASSWORD -> AUDIT_DB_PASSWORD (engine-db-init.sh line 16:
#                         : "${MEMORY_DB_PASSWORD:=$AUDIT_DB_PASSWORD}").
#
# Usage:
#   scripts/bootstrap-env-local.sh                 # write ./.env.local (refuse if exists)
#   scripts/bootstrap-env-local.sh --merge         # fill missing/placeholder, keep real values
#   scripts/bootstrap-env-local.sh --out /tmp/x.env --from .env.local.example
#   scripts/bootstrap-env-local.sh --check         # CI mode: generate to temp, verify, exit
#
# Never prints a generated secret to stdout. .gitignore covers .env.* (except .env.example).

set -euo pipefail

EXAMPLE=".env.local.example"
OUT=".env.local"
MODE="create"   # create | merge | check
FORCE=0

usage() {
  cat >&2 <<EOF
Usage: $0 [--merge] [--out PATH] [--from PATH] [--check] [--force]
  --merge       Fill missing/placeholder values in an existing .env.local; preserve real values.
  --out PATH    Output path (default ./.env.local). Ignored if --check.
  --from PATH   Source example (default ./.env.local.example).
  --check       Generate to a temp file, verify it sources and is consistent, then exit (CI mode).
  --force       Allow overwriting an existing OUT in create mode. DANGEROUS: destroys real credentials.
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --merge) MODE="merge"; shift;;
    --out)   OUT="${2:?--out needs a path}"; shift 2;;
    --from)  EXAMPLE="${2:?--from needs a path}"; shift 2;;
    --check) MODE="check"; shift;;
    --force) FORCE=1; shift;;
    -h|--help) usage;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

[ -f "$EXAMPLE" ] || { echo "bootstrap-env-local: example not found: $EXAMPLE" >&2; exit 2; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else echo "bootstrap-env-local: need shasum or sha256sum" >&2; exit 2; fi
}
gen_hex() { openssl rand -hex "$1"; }

# Stale-volume trap: a first run against volumes from a prior stack run would
# generate a password the existing roles reject. Detect and name it.
detect_stale_volumes() {
  command -v docker >/dev/null 2>&1 || { echo "  (docker not available; cannot check stale volumes)" >&2; return 0; }
  if ! docker volume ls >/dev/null 2>&1; then
    echo "  (docker daemon unreachable; cannot check stale volumes)" >&2; return 0
  fi
  local project vol
  project="${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}"
  vol="${project}_engine_db_data"
  if docker volume ls -q --filter "name=^${vol}\$" | grep -q .; then
    cat >&2 <<EOF
bootstrap-env-local: REFUSING. docker volume '$vol' already exists, so a stack
  has run before and the Postgres roles inside it were created with whatever
  password that run used. A fresh password now would produce a .env.local whose
  credentials no running database accepts -- surfacing later as an auth error,
  not now as a named one.
  Either (a) keep the old credentials: re-run with --merge against the .env.local
  that run used, or copy the old *_DB_PASSWORD values in first; or
  (b) reset and start clean: docker compose --env-file .env.local down --volumes
  then re-run. THIS DELETES ALL LOCAL ENGINE DB DATA.
EOF
    return 1
  fi
  return 0
}

generate_values() {
  local platform admin audit intel cost orch token token_sha cursor
  platform="$(gen_hex 16)"; admin="$(gen_hex 16)"; audit="$(gen_hex 16)"
  intel="$(gen_hex 16)"; cost="$(gen_hex 16)"; orch="$(gen_hex 16)"
  token="$(gen_hex 32)"; token_sha="$(printf %s "$token" | sha256_of)"
  cursor="$(gen_hex 32)"
  printf 'PLATFORM_DB_PASSWORD=%s\n' "$platform"
  printf 'ENGINE_DB_ADMIN_PASSWORD=%s\n' "$admin"
  printf 'AUDIT_DB_PASSWORD=%s\n' "$audit"
  printf 'AUDIT_RETENTION_DB_PASSWORD=%s\n' "$(gen_hex 24)"
  printf 'INTELLIGENCE_DB_PASSWORD=%s\n' "$intel"
  printf 'COST_DB_PASSWORD=%s\n' "$cost"
  printf 'ORCHESTRATION_DB_PASSWORD=%s\n' "$orch"
  printf 'INTERNAL_SERVICE_TOKEN=%s\n' "$token"
  printf 'INTERNAL_SERVICE_TOKEN_SHA256=%s\n' "$token_sha"
  printf 'MARKETPLACE_SEARCH_CURSOR_SECRET=%s\n' "$cursor"
  printf 'ADS_DB_PASSWORD=%s\n' "ads_core_local"
  printf 'MEMORY_DB_PASSWORD=%s\n' "$audit"   # engine-db-init.sh: = AUDIT_DB_PASSWORD
}

is_placeholder() {
  case "$1" in
    *"<"*) return 0;;
    *replace-me-with-a-random-value*) return 0;;
    "") return 0;;
    *) return 1;;
  esac
}

load_real_existing() {
  [ -f "$1" ] || return 0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue;; esac
    local key val
    key="${line%%=*}"; val="${line#*=}"
    [ "$key" = "$line" ] && continue
    if ! is_placeholder "$val"; then printf '%s=%s\n' "$key" "$val"; fi
  done < "$1"
}

needs_generated_engine_password() {
  local key value
  for key in ENGINE_DB_ADMIN_PASSWORD AUDIT_DB_PASSWORD INTELLIGENCE_DB_PASSWORD COST_DB_PASSWORD ORCHESTRATION_DB_PASSWORD; do
    value="$(awk -F= -v k="$key" '$1==k{print $2; exit}' "$1")"
    if is_placeholder "$value"; then return 0; fi
  done
  return 1
}

is_derived_value() {
  case "$1" in
    *'<'*|*replace-me-with-a-random-value*|*'${'*) return 0;;
    *) return 1;;
  esac
}

# render: substitute every known placeholder token in the example, writing OUT.
# $1 = values file (KEY=VAL, sourceable), $2 = output path
render() {
  local values="$1" out="$2"
  set +u
  # shellcheck disable=SC1090
  . "$values"
  set -u
  : > "$out.tmp.$$"
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) printf '%s\n' "$line" >> "$out.tmp.$$"; continue;;
    esac
    local key val
    key="${line%%=*}"
    [ "$key" = "$line" ] && { printf '%s\n' "$line" >> "$out.tmp.$$"; continue; }
    val="${line#*=}"
    # URL interpolations:
    val="${val//<PLATFORM_DB_PASSWORD>/$PLATFORM_DB_PASSWORD}"
    val="${val//<ENGINE_DB_ADMIN_PASSWORD>/$ENGINE_DB_ADMIN_PASSWORD}"
    val="${val//<AUDIT_DB_PASSWORD>/$AUDIT_DB_PASSWORD}"
    val="${val//<INTELLIGENCE_DB_PASSWORD>/$INTELLIGENCE_DB_PASSWORD}"
    val="${val//<COST_DB_PASSWORD>/$COST_DB_PASSWORD}"
    val="${val//<ORCHESTRATION_DB_PASSWORD>/$ORCHESTRATION_DB_PASSWORD}"
    val="${val//<MEMORY_DB_PASSWORD>/$MEMORY_DB_PASSWORD}"
    val="${val//<ADS_DB_PASSWORD>/$ADS_DB_PASSWORD}"
    # Generate-style placeholders on the password/token lines:
    val="${val//<generate-local-platform-password>/$PLATFORM_DB_PASSWORD}"
    val="${val//<generate-local-admin-password>/$ENGINE_DB_ADMIN_PASSWORD}"
    val="${val//<generate-local-audit-password>/$AUDIT_DB_PASSWORD}"
    val="${val//<generate-local-audit-retention-password>/$AUDIT_RETENTION_DB_PASSWORD}"
    val="${val//<generate-local-intelligence-password>/$INTELLIGENCE_DB_PASSWORD}"
    val="${val//<generate-local-cost-password>/$COST_DB_PASSWORD}"
    val="${val//<generate-32-byte-hex-token>/$INTERNAL_SERVICE_TOKEN}"
    val="${val//<sha256-of-the-token-above>/$INTERNAL_SERVICE_TOKEN_SHA256}"
    val="${val//<generate-32-byte-hex-secret>/$MARKETPLACE_SEARCH_CURSOR_SECRET}"
    # ORCHESTRATION_DB_PASSWORD line + its URL use a bare sentinel:
    val="${val//replace-me-with-a-random-value/$ORCHESTRATION_DB_PASSWORD}"
    printf '%s=%s\n' "$key" "$val" >> "$out.tmp.$$"
  done < "$EXAMPLE"
  # The example references ADS_DB_PASSWORD and MEMORY_DB_PASSWORD but never
  # defines them (the prompt's "referenced but never defined"). Resolved from
  # the authority (docker-compose.yml + engine-db-init.sh) and injected here
  # so the file is complete and anything reading the var directly sees it.
  {
    printf '\n# --- resolved by bootstrap-env-local.sh ---------------------------\n'
    printf '# ADS_DB_PASSWORD and MEMORY_DB_PASSWORD are referenced by the\n'
    printf '# connection strings above but never assigned in .env.local.example.\n'
    printf '# Authority: docker-compose.yml (ads-db POSTGRES_PASSWORD) and\n'
    printf '# infrastructure/local/engine-db-init.sh (MEMORY_DB_PASSWORD defaults\n'
    printf '# to AUDIT_DB_PASSWORD). Not generated; not guessed.\n'
    printf 'ADS_DB_PASSWORD=%s\n' "$ADS_DB_PASSWORD"
    printf 'MEMORY_DB_PASSWORD=%s\n' "$MEMORY_DB_PASSWORD"
  } >> "$out.tmp.$$"
  mv -f "$out.tmp.$$" "$out"
}

# PLACEHOLDER_RENDER_BODY

verify_file() {
  local f="$1"
  if ! bash -c "set -a; . '$f'; set +a" >/dev/null 2>&1; then
    echo "verify: $f is not sourceable by bash" >&2
    bash -c "set -a; . '$f'; set +a" 2>&1 | head -3 >&2
    return 1
  fi
  local leftover
  leftover="$(grep -nE '^[^#]*<[^>]+>|^[^#]*replace-me-with-a-random-value' "$f" || true)"
  if [ -n "$leftover" ]; then echo "verify: unresolved placeholder(s) remain:" >&2; echo "$leftover" >&2; return 1; fi
  if grep -qE '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=test$' "$f" ||
    [ "${AWS_ACCESS_KEY_ID:-}" = "test" ] || [ "${AWS_SECRET_ACCESS_KEY:-}" = "test" ]; then
    echo "verify: LocalStack test AWS credentials override the operator's ~/.aws profile; remove AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from $f" >&2
    return 1
  fi
  local tok tok_sha computed
  tok="$(awk -F= '$1=="INTERNAL_SERVICE_TOKEN"{print $2}' "$f")"
  tok_sha="$(awk -F= '$1=="INTERNAL_SERVICE_TOKEN_SHA256"{print $2}' "$f")"
  computed="$(printf %s "$tok" | sha256_of)"
  if [ -z "$tok" ] || [ "$tok_sha" != "$computed" ]; then
    echo "verify: INTERNAL_SERVICE_TOKEN_SHA256 != sha256(INTERNAL_SERVICE_TOKEN)" >&2; return 1
  fi
  local audit mem ads
  audit="$(awk -F= '$1=="AUDIT_DB_PASSWORD"{print $2; exit}' "$f")"
  mem="$(awk -F= '$1=="MEMORY_DB_PASSWORD"{print $2; exit}' "$f")"
  ads="$(awk -F= '$1=="ADS_DB_PASSWORD"{print $2; exit}' "$f")"
  # MEMORY_DB_PASSWORD may differ from AUDIT_DB_PASSWORD if the operator set it
  # explicitly (engine-db-init.sh honours a set value, defaulting to audit only
  # when unset). It just must be non-empty and substituted consistently.
  if [ -z "$mem" ]; then echo "verify: MEMORY_DB_PASSWORD is empty (engine-db-init.sh needs it, defaults to AUDIT_DB_PASSWORD)" >&2; return 1; fi
  if [ "$ads" != "ads_core_local" ]; then echo "verify: ADS_DB_PASSWORD != ads_core_local (docker-compose ads-db hardcodes it)" >&2; return 1; fi
  if grep -qE '<AUDIT_DB_PASSWORD>|<PLATFORM_DB_PASSWORD>|<INTELLIGENCE_DB_PASSWORD>|<COST_DB_PASSWORD>|<ORCHESTRATION_DB_PASSWORD>|<MEMORY_DB_PASSWORD>|<ADS_DB_PASSWORD>' "$f"; then
    echo "verify: a literal <*_DB_PASSWORD> placeholder still present" >&2; return 1
  fi
  return 0
}

case "$MODE" in
  check)
    tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT
    gen="$tmpdir/values.env"; out="$tmpdir/.env.local"
    generate_values > "$gen"
    render "$gen" "$out"
    if verify_file "$out"; then
      echo "bootstrap-env-local check ok: generated .env.local is sourceable and consistent"
      exit 0
    else
      echo "bootstrap-env-local check FAILED" >&2; exit 1
    fi
    ;;

  create)
    if [ -e "$OUT" ] && [ "$FORCE" -ne 1 ]; then
      cat >&2 <<EOF
bootstrap-env-local: REFUSING to overwrite $OUT.
  An existing .env.local usually carries real AWS credentials and Auth0 settings
  that cannot be recovered once overwritten. Use --merge to fill only
  missing/placeholder values while preserving the rest, or --force only if you
  are certain $OUT contains nothing worth keeping.
EOF
      exit 1
    fi
    if [ "$FORCE" -ne 1 ]; then detect_stale_volumes || exit 1; fi
    gen="$(mktemp)"; trap 'rm -f "$gen"' EXIT
    generate_values > "$gen"
    render "$gen" "$OUT"
    chmod 600 "$OUT"
    if verify_file "$OUT"; then
      echo "bootstrap-env-local: wrote $OUT (sourceable, consistent)."
      echo "  Next: set -a; . ./$OUT; set +a  &&  docker compose --env-file $OUT up -d --build --wait engine-db ads-db cost-db redis localstack temporal"
    else
      echo "bootstrap-env-local: wrote $OUT but verification FAILED" >&2; exit 1
    fi
    ;;

  merge)
    [ -f "$OUT" ] || { echo "bootstrap-env-local: $OUT does not exist; nothing to merge into. Run without --merge to create it." >&2; exit 1; }
    if needs_generated_engine_password "$OUT"; then detect_stale_volumes || exit 1; fi
    gen="$(mktemp)"; existing="$(mktemp)"; merged="$(mktemp)"; rendered="$(mktemp)"
    trap 'rm -f "$gen" "$existing" "$merged" "$rendered"' EXIT
    generate_values > "$gen"
    load_real_existing "$OUT" > "$existing"
    # Merged values: generated set, then existing real values override.
    cp "$gen" "$merged"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      k="${line%%=*}"; v="${line#*=}"
      grep -vE "^${k}=" "$merged" > "$merged.tmp" || true
      mv -f "$merged.tmp" "$merged"
      printf '%s=%s\n' "$k" "$v" >> "$merged"
    done < "$existing"
    render "$merged" "$rendered"
    # Final OUT: for each rendered line, keep existing real value if present,
    # else use the rendered (filled) value.
    : > "$OUT.tmp.$$"
    while IFS= read -r rline; do
      case "$rline" in
        ''|'#'*) printf '%s\n' "$rline" >> "$OUT.tmp.$$"; continue;;
      esac
      rk="${rline%%=*}"; rv="${rline#*=}"
      existing_val="$(awk -F= -v k="$rk" '$1==k{print $2; exit}' "$existing")"
      template_val="$(awk -F= -v k="$rk" '$1==k{print substr($0, index($0, "=")+1); exit}' "$EXAMPLE")"
      if is_derived_value "$template_val"; then existing_val=""; fi
      if [ -n "$existing_val" ]; then
        printf '%s=%s\n' "$rk" "$existing_val" >> "$OUT.tmp.$$"
      else
        printf '%s=%s\n' "$rk" "$rv" >> "$OUT.tmp.$$"
      fi
    done < "$rendered"
    mv -f "$OUT.tmp.$$" "$OUT"
    chmod 600 "$OUT"
    if verify_file "$OUT"; then
      echo "bootstrap-env-local: merged into $OUT (existing real values preserved, placeholders filled)."
    else
      echo "bootstrap-env-local: merged $OUT but verification FAILED" >&2; exit 1
    fi
    ;;
esac
