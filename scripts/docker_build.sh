#!/usr/bin/env bash
#
# Build the offline product-surface image locally. Producing the image is in-scope; RUNNING IT FOR REAL
# (registry push, real hosting, DNS, secrets, real tenants/payments/comms) is the human-reserved crossing
# (CLAUDE.md operations exception #4). This script NEVER pushes. The `docker run` recipe below is commented
# out on purpose — a human runs it to demo locally.
#
# Usage:  ./scripts/docker_build.sh [image-tag]      (default tag: wedding-planner-product:local)
set -euo pipefail

TAG="${1:-wedding-planner-product:local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building ${TAG} from ${REPO_ROOT} …"
docker build -t "${TAG}" "${REPO_ROOT}"

echo
echo "Built ${TAG}. To run it LOCALLY (offline demo), a human can:"
echo
echo "  # Demo default — an ephemeral operator token is generated + logged once at boot:"
echo "  docker run --rm -p 8080:8080 ${TAG}"
echo
echo "  # Or inject your own operator token (>=16 chars) for a stable /admin credential:"
echo "  docker run --rm -p 8080:8080 -e WP_OPERATOR_TOKEN=your-operator-token-xxxx ${TAG}"
echo
echo "  # A non-demo build (no seeded tenant) REQUIRES an injected token, else it fails closed:"
echo "  docker run --rm -p 8080:8080 -e WP_SEED_DEMO=false -e WP_OPERATOR_TOKEN=your-operator-token-xxxx ${TAG}"
echo
echo "  Then open http://localhost:8080/  and the demo tenant at  http://localhost:8080/t/demo"
echo "  Health:  curl http://localhost:8080/healthz"
echo
echo "DO NOT 'docker push' this image — going live is human-reserved."
