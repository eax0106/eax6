#!/usr/bin/env bash
# Task 6.1d. Proves the EC2 services would get past their production-only
# boot checks: generates the host's .env the way bootstrap.sh does
# (check-bootstrap-env.sh), resolves every container's environment with
# `docker compose config`, and runs check-production-config.ts over it.
# Prints "production-boot-ok". Needs Docker and the installed repository.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
KEEP_ENV_AT="$work/.env" bash "$repo/deploy/ec2/check-bootstrap-env.sh" >/dev/null
cp "$repo/deploy/ec2/compose.yml" "$repo/deploy/ec2/Caddyfile" "$work/"
(cd "$work" && docker compose -f compose.yml --env-file .env config --format json) >"$work/compose.json"
(cd "$repo" && pnpm exec tsx --tsconfig apps/platform-api/tsconfig.app.json \
  deploy/ec2/check-production-config.ts "$work/compose.json")
echo "production-boot-ok"
