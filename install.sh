#!/usr/bin/env sh
# netspeak installer:  curl -fsSL https://raw.githubusercontent.com/amurikurthy/NetSpeak/main/install.sh | sh
# Installs into ./netspeak, starts the container, prints the admin login.
set -eu
RAW="https://raw.githubusercontent.com/amurikurthy/NetSpeak/main"
DIR="${NETSPEAK_DIR:-netspeak}"

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (the 'docker compose' command)."; exit 1; }

mkdir -p "$DIR" && cd "$DIR"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
docker compose pull
docker compose up -d

echo "Waiting for first start..."
i=0
while [ $i -lt 30 ]; do
  if docker compose logs netspeak 2>&1 | grep -q "netspeak"; then break; fi
  i=$((i+1)); sleep 1
done
docker compose logs netspeak 2>&1 | grep -E "Sign in as|created user|netspeak (on|https)" || true
echo
echo "netspeak is running. Open https://<this-server's-hostname-or-IP>"
echo "Settings live in $(pwd)/docker-compose.yml (environment section). Update: docker compose pull && docker compose up -d"
