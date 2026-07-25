#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLAYWRIGHT_DIR="/tmp/egt-browser"
PLAYWRIGHT_VERSION="1.55.0"
NODE_MAJOR_REQUIRED=24

if [[ ${EUID} -eq 0 ]]; then
  SUDO=()
  PG_RUN=(runuser -u postgres --)
else
  command -v sudo >/dev/null 2>&1 || { echo "sudo is required when not running as root" >&2; exit 1; }
  SUDO=(sudo)
  PG_RUN=(sudo -u postgres)
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This setup script currently supports Debian/Ubuntu systems with apt-get." >&2
  exit 1
fi

echo "[1/7] Installing operating-system dependencies"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg zip unzip postgresql postgresql-client

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi

if (( node_major < NODE_MAJOR_REQUIRED )); then
  echo "[2/7] Installing Node.js ${NODE_MAJOR_REQUIRED}.x"
  "${SUDO[@]}" install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | "${SUDO[@]}" gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_REQUIRED}.x nodistro main" | "${SUDO[@]}" tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
else
  echo "[2/7] Node.js $(node --version) already satisfies >=${NODE_MAJOR_REQUIRED}"
fi

echo "[3/7] Installing locked launcher dependencies"
cd "$PROJECT_DIR"
npm ci

echo "[4/7] Installing Playwright ${PLAYWRIGHT_VERSION} and Chromium"
mkdir -p "$PLAYWRIGHT_DIR"
npm install --prefix "$PLAYWRIGHT_DIR" --save-exact "playwright@${PLAYWRIGHT_VERSION}"
"$PLAYWRIGHT_DIR/node_modules/.bin/playwright" install --with-deps chromium

echo "[5/7] Starting and provisioning PostgreSQL"
"${SUDO[@]}" systemctl start postgresql
if ! "${PG_RUN[@]}" psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='root'" | grep -q 1; then
  "${PG_RUN[@]}" createuser --login --superuser root
fi
if ! "${PG_RUN[@]}" psql -tAc "SELECT 1 FROM pg_database WHERE datname='egt_arcade'" | grep -q 1; then
  "${PG_RUN[@]}" createdb --owner=root egt_arcade
fi

echo "[6/7] Verifying source syntax"
node --check game-launcher.cjs
node --check launcher-store.cjs
node --check game-importer.cjs
node --check game-client-patches.cjs

echo "[7/7] Verifying installed services and modules"
node -e "require('pg'); require('${PLAYWRIGHT_DIR}/node_modules/playwright'); console.log('Node dependencies: OK')"
pg_isready -h 127.0.0.1 -p 5432
psql -d egt_arcade -Atc 'select current_database(),current_user'
zip -v >/dev/null
unzip -v >/dev/null

cat <<'MESSAGE'

Dependency setup complete.

Start the services in separate terminals:
  cd /egt && node game-launcher.cjs
  cd /egt && node game-importer.cjs

Health checks:
  curl -sS http://127.0.0.1:8080/health
  curl -sS http://127.0.0.1:8081/health
MESSAGE
