#!/bin/sh
# Superseded by scripts/run-service-aws.sh, which starts any gateway service
# against real AWS. Kept so existing instructions keep working.
exec bash "$(dirname -- "$0")/run-service-aws.sh" model-gateway "$@"
