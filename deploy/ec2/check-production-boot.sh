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
# Prove the production oracle rejects each missing engine estimation input.
# Only generated fixture configuration is changed; no service is started.
for key in APPCONFIG_APPLICATION_ID APPCONFIG_ENVIRONMENT_ID APPCONFIG_CONFIGURATION_PROFILE_ID COST_LEDGER_BASE_URL; do
  node - "$work/compose.json" "$work/negative.json" "$key" <<'NODE'
const fs = require('node:fs');
const [source, target, key] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(source, 'utf8'));
delete config.services['orchestration-service'].environment[key];
fs.writeFileSync(target, JSON.stringify(config));
NODE
  if (cd "$repo" && pnpm exec tsx --tsconfig apps/platform-api/tsconfig.app.json \
      deploy/ec2/check-production-config.ts "$work/negative.json") >"$work/negative.log" 2>&1; then
    echo "FAIL missing engine $key was accepted"
    exit 1
  fi
  grep -Fq 'FAIL orchestration-service pre-run estimation: Pre-run cost estimates need' "$work/negative.log" || {
    echo "FAIL missing engine $key did not reach the estimation assertion"
    exit 1
  }
done
echo "estimation-negative-controls-ok"
for key in PUBLIC_FORM_TOKEN_KEY PUBLIC_FORM_BASE_URL PUBLIC_FORM_TURNSTILE_SITE_KEY PUBLIC_FORM_TURNSTILE_SECRET_REF PUBLIC_SURFACE_DATABASE_URL PUBLIC_SURFACE_REDIS_URL; do
  node - "$work/compose.json" "$work/negative.json" "$key" <<'NODE'
const fs = require('node:fs');
const [source, target, key] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(source, 'utf8'));
delete config.services['public-surface'].environment[key];
fs.writeFileSync(target, JSON.stringify(config));
NODE
  if (cd "$repo" && pnpm exec tsx --tsconfig apps/platform-api/tsconfig.app.json deploy/ec2/check-production-config.ts "$work/negative.json") >"$work/negative.log" 2>&1; then
    echo "FAIL missing Public Surface $key was accepted"; exit 1
  fi
  grep -Fq 'FAIL public-surface hosted form environment:' "$work/negative.log" || { echo "FAIL missing Public Surface $key did not reach its configuration check"; exit 1; }
done
echo "public-form-boot-controls-ok"
(cd "$repo" && node deploy/ec2/check-public-form-routing.mjs)
echo "production-boot-ok"
