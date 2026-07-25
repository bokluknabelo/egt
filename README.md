# EGT Account Arcade

EGT Account Arcade is a self-hosted account, instance, balance, and game-capture environment. It consists of two Node.js services backed by PostgreSQL:

- **Arcade and Play Config (`:8080`)** — authentication, accounts, user instances, balances, immutable sequenced transaction history, per-user currencies, game catalog, icons, and the simulated slot-wallet bridge.
- **Capture/import GUI (`:8081`)** — discovers EGT product pages, captures public demo assets with Playwright/HAR, patches clients, packages ZIP archives, imports catalog entries, and backfills game artwork.

> This project uses a simulated bridge around EGT's public demo client. It is not an official EGT operator wallet, remote game server, payment system, or gambling platform integration.

## Current capabilities

### Accounts and instances

- Password-authenticated administrator and player accounts.
- Separate usernames and display nicknames.
- Multiple named instances with explicit owners and members.
- A remembered active instance per browser/account.
- Home inside a slot returns to the previously selected instance.
- Positive balances can be transferred between instances without duplication.
- PostgreSQL is authoritative across process and machine restarts.

### Money and currencies

- Two-decimal balances and ledger amounts (`numeric(20,2)`).
- Fractional bets update immediately; for example, `724.00 - 0.10 = 723.90`.
- Per-user `RON`, `EUR`, or `GBP` display currency, selected by an administrator.
- Currency is applied to balance, win, denomination, and jackpot labels in the game client.
- Operational identifiers such as `EGTBG` are not rewritten.
- The system changes display labels only; it does not perform foreign-exchange conversion.

### Simulated slot wallet

- Each launch binds a game session to the selected instance member's wallet.
- EGT's scaled protocol balances (`units=100`) are translated to account units.
- Wagers and wins are persisted as `GAME_WAGER` and `GAME_WIN` entries.
- Every new launch writes a `GAME_SESSION_OPENED` entry with its opening balance and game key.
- Concurrent updates are serialized per user and instance.
- Lobby and Play Config balances update through server-sent events.

### Play Config administration

- Opened from the top-right **Play Config** button.
- Protected by administrator-password confirmation.
- Account and instance creation, member assignment, balance controls, and per-user currency selection.
- Instance dropdown covering all instances manageable by the administrator.
- Immutable history showing balance loads, slot sessions, wagers, wins, timestamps, operators, and before/after balances.
- CSV export for up to 50,000 ledger entries.
- Sign Out is located inside Play Config.

### Capture/import pipeline

- Mines an EGT Digital product page for its public demo game key and artwork.
- Captures the demo through Playwright and records an embedded HAR.
- Extracts successful assets while retaining URL paths.
- Applies shared Home, PLAY-label, and currency patches.
- Injects the live SockJS/WebSocket currency transformer into future captures.
- Produces and verifies a ZIP archive.
- Inserts the game into the arcade catalog and assigns its local icon.
- Supports icon-only work, icon backfills, first-50 selection, and persistent discovery cursors.
- Validates artwork against the product slug, game key, or title; rejects cross-game duplicate image hashes; and sends failed importer jobs to Play Config Problem Reports.

## Architecture

| Component | Purpose |
|---|---|
| `game-launcher.cjs` | HTTP/API server, sessions, accounts, instances, proxy, wallet bridge, catalog and icons |
| `launcher-store.cjs` | PostgreSQL schema, state persistence, append-only balance ledger and monitoring data |
| `index.html` | Arcade, authentication and Play Config browser UI |
| `game-client-patches.cjs` | Shared game bundle and live WebSocket patches |
| `game-importer.cjs` | Capture/import server and job orchestration |
| `game-importer.html` | Capture/import browser UI |
| `capture-egt-demo.js` | Playwright/HAR capture worker |
| `extract-har-assets.js` | HAR asset extraction worker |
| `data/game-icons.json` | Persistent game-key-to-icon mapping |
| `data/discovery-cursors.json` | Persistent discovery batch positions |
| `game-icons/` | Downloaded local artwork |
| `REBOOT_HANDOFF.md` | Current operational state and continuation notes |

PostgreSQL relational tables are the restart source of truth for users, instances, memberships/wallets, activity, catalog games, settings, system audit, sessions, bridges, ledger entries, monitoring, and importer jobs. `app_state` remains a compatibility mirror for rollback/export. Financial history uses monotonic wallet sequences and a database-recorded order; a trigger rejects updates or deletes against ledger rows.

Play Config uses a server-enforced 15-minute elevation grant. Importer jobs persist across restart. Full captures are built and verified under `.import-staging/`, then promoted atomically with rollback to the previous capture and archive if a later promotion step fails. Job feeds, discovery, archive downloads, and management APIs require a root importer session.

## Requirements

The supported deployment is Debian/Ubuntu Linux.

- Node.js **24 or newer**
- npm
- PostgreSQL (tested with 16)
- Playwright **1.55** and Chromium
- `curl`, `ca-certificates`, `gnupg`
- `zip` and `unzip`
- `systemd` for the documented PostgreSQL service commands
- Internet access for dependency installation, demo capture, artwork mining, and upstream game assets

The application expects Playwright at `/tmp/egt-browser/node_modules/playwright`. The setup script creates that runtime. Because `/tmp` may be cleared on reboot, rerun the setup script if capture reports a missing Playwright module.

## Automated dependency setup

Run the included setup script from an administrator-capable shell:

```bash
cd /egt
./setup-dependencies.sh
```

It performs these idempotent actions:

1. Installs required Debian/Ubuntu packages.
2. Installs Node.js 24 from NodeSource if the installed Node version is too old.
3. Runs `npm ci` for the launcher dependency lockfile.
4. Installs Playwright 1.55 and Chromium under `/tmp/egt-browser`.
5. Starts PostgreSQL.
6. Creates the local `root` PostgreSQL role and `egt_arcade` database if absent.
7. Runs syntax and dependency verification checks.

It does **not** drop, reset, truncate, or replace an existing database.

## Manual installation

If automated installation is unsuitable, install the prerequisites and then run:

```bash
cd /egt
npm ci

mkdir -p /tmp/egt-browser
npm install --prefix /tmp/egt-browser --save-exact playwright@1.55.0
/tmp/egt-browser/node_modules/.bin/playwright install --with-deps chromium

sudo systemctl start postgresql
sudo -u postgres createuser --login --superuser root   # only if absent
sudo -u postgres createdb --owner=root egt_arcade      # only if absent
```

The local `root` database role matches Unix peer authentication when the services run as the `root` operating-system account. For a multi-user or production deployment, configure a dedicated least-privilege database role and supply `DATABASE_URL` instead.

## Starting the services

Start PostgreSQL first:

```bash
sudo systemctl start postgresql
```

Then start each Node service in its own terminal:

```bash
cd /egt
node game-launcher.cjs
```

```bash
cd /egt
node game-importer.cjs
```

Default endpoints:

- Arcade: `http://127.0.0.1:8080/`
- Play Config: opened from the arcade UI
- Capture/import: `http://127.0.0.1:8081/`
- PostgreSQL: local socket or `127.0.0.1:5432`, database `egt_arcade`

The processes are currently manual and do not survive reboot unless you add systemd units or another process supervisor.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` / service-defined | HTTP listen port |
| `DATABASE_URL` | unset | Complete PostgreSQL connection string; overrides socket settings |
| `PGDATABASE` | `egt_arcade` | PostgreSQL database when `DATABASE_URL` is unset |
| `PGUSER` | `root` | PostgreSQL role when `DATABASE_URL` is unset |
| `LAUNCHER_DATA_PATH` | `/egt/data/launcher-auth.json` | Fallback/pre-cutover data and setup-token location |
| `LAUNCHER_SETUP_TOKEN` | generated when required | One-time setup override for an empty account database |
| `CAPTURE_WAIT_MS` | `20000` | Default Playwright capture wait for the capture worker |

Do not store passwords, session cookies, CSRF tokens, setup tokens, or private database URLs in tracked documentation.

## First-time setup

When the user table is empty, the login page displays the initial setup flow. Obtain the one-time setup token from the generated setup-token file or provide `LAUNCHER_SETUP_TOKEN` before starting the launcher. The setup endpoint deletes the generated token after successful initialization.

For an existing deployment, PostgreSQL is authoritative. Do not rerun migrations manually or restore old JSON backups over current state.

## Health and diagnostics

```bash
curl -sS http://127.0.0.1:8080/health
curl -sS http://127.0.0.1:8081/health
curl -sS http://127.0.0.1:8080/health?deep=1
curl -sS http://127.0.0.1:8081/health?deep=1
ss -ltnp | rg ':8080\b|:8081\b|:5432\b'
```

Expected healthy responses resemble:

```json
{"ok":true,"setupRequired":false}
{"ok":true,"running":false,"queued":0}
```

The deep checks additionally verify PostgreSQL, disk capacity, cache/in-flight proxy state, launcher linkage, and Playwright availability.

Syntax checks:

```bash
node --check game-launcher.cjs
node --check launcher-store.cjs
node --check game-importer.cjs
node --check game-client-patches.cjs
```

Current balances and currencies:

```bash
psql -d egt_arcade -P pager=off -c "select u->>'username' username,u->>'currency' currency,i->>'name' instance,(m->>'balance')::numeric(20,2) balance from app_state cross join lateral jsonb_array_elements(data->'users') u cross join lateral jsonb_array_elements(data->'instances') i cross join lateral jsonb_array_elements(i->'members') m where m->>'userId'=u->>'id' order by username,instance"
```

Recent immutable ledger entries:

```bash
psql -d egt_arcade -P pager=off -c "select created_at,username,amount,balance_before,balance_after,reason,reference from balance_ledger order by created_at desc limit 20"
```

## Data safety

- PostgreSQL data survives launcher and host restarts.
- Login sessions and active game bridges are persisted in PostgreSQL with SHA-256 token hashes and survive launcher restarts until logout or their 12-hour expiry.
- Never reset balances unless explicitly requested.
- Balance transfers use paired ledger entries and a shared reference.
- Ledger rows are append-only and must not be edited or deleted.
- Preserve `data/`, `game-icons/`, captured game directories, and ZIP archives during upgrades.
- JSON files named `pre-postgres` or `cutover` are historical backups, not the current source of truth.

## Capture workflow

Open `http://127.0.0.1:8081/`, provide a supported EGT Digital product/discovery URL, and submit a capture job. A regular job proceeds through mining, artwork download, Playwright capture, HAR parsing, client patching, ZIP verification, and catalog insertion.

Useful distinctions:

- **Regular capture** creates a complete capture directory and ZIP.
- **Icon only** mines and assigns artwork without HAR capture or packaging.
- **Backfill icons** locates artwork for existing captures.
- **Mine next 50** advances the persistent discovery cursor.

Captured directories and archives can be large. Confirm available disk space before bulk imports.

## Security considerations

- Expose ports 8080/8081 only through an appropriate firewall or authenticated reverse proxy.
- The launcher sets HTTP-only, same-site session cookies and requires CSRF tokens for mutations.
- Play Config requires administrator-password confirmation in the UI.
- Use TLS at the reverse proxy for any non-local deployment.
- Replace the local superuser database role with a scoped role before multi-tenant or production use.
- Treat captured upstream content as untrusted input and keep Node.js, Chromium, PostgreSQL, and OS packages patched.
- Review upstream terms and applicable law before using public demo assets.

## Troubleshooting

### Launcher cannot connect to PostgreSQL

```bash
sudo systemctl status postgresql
pg_isready -h 127.0.0.1 -p 5432
psql -d egt_arcade -c 'select now()'
```

Confirm the OS account and PostgreSQL peer role match, or configure `DATABASE_URL`.

### Importer cannot find Playwright

Rerun:

```bash
./setup-dependencies.sh
```

This commonly occurs after `/tmp` is cleared.

### Chromium fails to launch

```bash
/tmp/egt-browser/node_modules/.bin/playwright install --with-deps chromium
```

### Ports are already occupied

```bash
ss -ltnp | rg ':8080\b|:8081\b'
ps -eo pid,ppid,user,comm,args | rg '[n]ode (game-launcher|game-importer)\.cjs'
```

Avoid starting duplicate launcher or importer processes.

### Balance differs between instances

Balances belong to a specific user/instance membership. Check the active instance label and query PostgreSQL before changing funds. Use Play Config history to distinguish credits, transfers, wagers, and wins.

## Operational handoff

Read [`REBOOT_HANDOFF.md`](REBOOT_HANDOFF.md) before continuing operational work. It records the latest verified balances, current behavior, important files, and reboot procedure.
