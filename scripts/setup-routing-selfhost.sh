#!/usr/bin/env bash
# UNTESTED HERE (no docker on author box) — commands are canonical osrm-backend
# usage, but this script has not been executed end-to-end.
#
# RESOURCE WARNING: continent extracts need 32GB+ RAM during osrm-extract /
# osrm-customize. Prefer state/metro extracts from Geofabrik
# (https://download.geofabrik.de) unless your box can handle it.
#
# Usage: ./scripts/setup-routing-selfhost.sh <geofabrik-.osm.pbf-url> [data-dir]
# Only dependency beyond docker is curl.

set -euo pipefail

IMAGE="ghcr.io/project-osrm/osrm-backend"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <geofabrik-.osm.pbf-url> [data-dir]" >&2
  exit 1
fi

URL="$1"
# Absolute path: docker -v rejects relative host paths. Parent is created
# first so the cd below can't fail under set -e for nested paths.
mkdir -p "$(dirname "${2:-./osrm-data}")"
DATA_DIR="$(cd "$(dirname "${2:-./osrm-data}")" && pwd)/$(basename "${2:-./osrm-data}")"
mkdir -p "$DATA_DIR"

# Always materialize a fixed basename so docker-compose.osrm.yml stays static.
PBF="$DATA_DIR/region.osm.pbf"
OSRM="/data/region.osrm"

curl --fail -L -C - --retry 3 -o "$PBF" "$URL"

docker run --rm -t -v "$DATA_DIR:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -t -v "$DATA_DIR:/data" "$IMAGE" osrm-partition "$OSRM"
docker run --rm -t -v "$DATA_DIR:/data" "$IMAGE" osrm-customize "$OSRM"

cat <<'EOF'

Done. Start routing with:
  docker compose -f docker-compose.osrm.yml up -d

Then configure ghost-route with:
  ROUTING_BACKEND=custom OSRM_BASE=http://localhost:5000 ALLOW_LOCAL_ROUTING=1
EOF
