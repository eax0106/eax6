#!/usr/bin/env bash
set -euo pipefail

# Engine-owned apps checked by FOUND-10. Platform apps are excluded pending
# Platform track adapter-law migration - see FOUND-10 known gaps.
checked_apps=(
  "apps/audit-service"
  "apps/orchestration-service"
  "apps/intelligence-service"
  "apps/model-gateway"
  "apps/tool-gateway"
  "apps/sandbox-service"
  "apps/verification-service"
  "apps/memory-service"
  "apps/eval-service"
  "apps/public-surface"
  "apps/background-workers"
  "apps/cost-ledger-service"
)

existing_apps=()
for app in "${checked_apps[@]}"; do
  if [[ -d "$app/src" ]]; then
    existing_apps+=("$app")
  fi
done

if [[ "${#existing_apps[@]}" -eq 0 ]]; then
  echo "architecture-boundary check failed: no Engine app src directories found" >&2
  exit 1
fi

command -v rg >/dev/null || {
  echo "architecture-boundary check failed: rg not found" >&2
  exit 2
}

vendor_specifier='(?:pg|drizzle-orm(?:/[^"'"'"']*)?|@grpc/(?:grpc-js|proto-loader)|@aws-sdk/[^"'"'"']+|@temporalio/[^"'"'"']+|@sentry/node|@opentelemetry/[^"'"'"']+|ioredis|redis)'
patterns=(
  "\\bfrom\\s+[\"']${vendor_specifier}[\"']"
  "\\bimport\\s*\\(\\s*[\"']${vendor_specifier}[\"']"
  "\\brequire\\s*\\(\\s*[\"']${vendor_specifier}[\"']"
  "^\\s*import\\s+[\"']${vendor_specifier}[\"']"
)

matches=""
for pattern in "${patterns[@]}"; do
  for app in "${existing_apps[@]}"; do
    set +e
    found="$(rg --pcre2 -n --glob '*.ts' --glob '!**/node_modules/**' "$pattern" "$app/src")"
    rg_status=$?
    set -e

    case "$rg_status" in
      0)
        matches+="${found}"$'\n'
        ;;
      1)
        ;;
      *)
        echo "architecture-boundary check failed: rg exited $rg_status while scanning $app/src" >&2
        exit 2
        ;;
    esac
  done
done

if [[ -n "$matches" ]]; then
  echo "Architecture boundary violation: Engine app code imports vendor SDKs directly." >&2
  echo "Vendor SDK imports must live under packages/adapters/**." >&2
  echo "Checked Engine apps:" >&2
  printf '  - %s\n' "${checked_apps[@]}" >&2
  echo "Platform apps excluded pending Platform track adapter-law migration - see FOUND-10 known gaps." >&2
  echo >&2
  printf '%s' "$matches" >&2
  exit 1
fi

echo "architecture-boundary ok"
