#!/usr/bin/env bash
# Builds every container image in this repository: one image for the nine Node
# services, and one per Python service. platform-web is absent on purpose -- it
# ships as a static bundle.
#
#   TAG=sha-abc123 REGISTRY=<account>.dkr.ecr.ap-south-1.amazonaws.com scripts/docker-build.sh
set -euo pipefail

TAG="${TAG:-dev}"
REGISTRY="${REGISTRY:-alter}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYTHON_APPS=(
  ads-core
  eval-service
  intelligence-service
  memory-service
  verification-service
)

cd "$ROOT"

echo "==> ${REGISTRY}/node:${TAG}"
docker build -f docker/Dockerfile.node -t "${REGISTRY}/node:${TAG}" .

for app in "${PYTHON_APPS[@]}"; do
  echo "==> ${REGISTRY}/${app}:${TAG}"
  docker build \
    -f docker/Dockerfile.python \
    --build-arg "APP=${app}" \
    -t "${REGISTRY}/${app}:${TAG}" \
    .
done

echo "built ${TAG}: node + ${#PYTHON_APPS[@]} Python images"
