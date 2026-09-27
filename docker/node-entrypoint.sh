#!/bin/sh
# Turns a service name into the command that service's Nx serve target runs, so
# the nine Node services can share one image.
#
# Anything that is not one of the nine names is executed as given instead. That
# keeps the image usable for the jobs that are not "serve a service": `sh` to
# look around, and `pnpm --filter @alterx/platform-api db:migrate` to migrate a
# schema, which is the reason the image keeps its dev dependencies at all.
#
# The tracing bootstrap is preloaded when the service's build emits one rather
# than from a list of names: only platform-api and orchestration-service ship a
# src/tracing.ts today, and a list would go stale the first time a third does.
set -eu

SERVICES="audit-service background-workers cost-ledger-service model-gateway orchestration-service platform-api provisioning-service sandbox-service tool-gateway"

is_service() {
  case " $SERVICES " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

service=""
if [ "$#" -gt 0 ]; then
  if is_service "$1"; then
    service="$1"
    shift
  else
    exec "$@"
  fi
elif [ -n "${ALTER_SERVICE_NAME:-}" ] && is_service "${ALTER_SERVICE_NAME}"; then
  service="${ALTER_SERVICE_NAME}"
fi

if [ -z "$service" ]; then
  echo "usage: <service-name> [args...], or any other command to run it directly" >&2
  echo "       a service name may also come from ALTER_SERVICE_NAME" >&2
  echo "services: ${SERVICES}" >&2
  exit 64
fi

main="dist/apps/${service}/main.js"
if [ ! -f "$main" ]; then
  echo "no build output at ${main}" >&2
  exit 70
fi

tracing="dist/apps/${service}/tracing.js"
if [ -f "$tracing" ]; then
  exec node -r "./${tracing}" "$main" "$@"
fi

exec node "$main" "$@"
