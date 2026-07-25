# EGT Arcade reboot handoff

Last verified: **2026-07-25 UTC**

This is the durable continuation note for the work in `/egt`. Do not rebuild or reclone the project. The current files and PostgreSQL database are authoritative.

## Start here after reboot

PostgreSQL should start as the Debian service. Verify it, then start the two Node services in separate terminals:

```bash
sudo systemctl start postgresql
cd /egt
node game-launcher.cjs
```

```bash
cd /egt
node game-importer.cjs
```

Expected listeners:

- Arcade and administration: `http://23.26.4.217:8080/`
- Capture/import GUI: `http://23.26.4.217:8081/`
- PostgreSQL 16: `127.0.0.1:5432`, database `egt_arcade`, local role `root`

Quick checks:

```bash
curl -sS http://127.0.0.1:8080/health
curl -sS http://127.0.0.1:8081/health
ss -ltnp | rg ':8080\b|:8081\b|:5432\b'
```

Node version at handoff: `v24.18.0`.

## Current production data

The PostgreSQL ledger was last updated at `2026-07-23 14:04:29 UTC`.

| Account | Nickname | Currency | Instance | Balance |
|---|---|---|---|---:|
| admin | admin | GBP | Main Arcade | 0 |
| admin | admin | GBP | 3243 | 0 |
| boss | boss | GBP | Main Arcade | 50 |
| bossman | bossman | GBP | Main Arcade | 0 |
| hazardzz | hazardzz | GBP | Main Arcade | 0 |
| sds | sds | GBP | Main Arcade | 5,550 |
| sds | sds | GBP | 3243 | 0 |

For historical context, `sds` originally had **5,000** credits moved from Main Arcade to `3243` with linked immutable ledger entries. Subsequent real test play and administrator credit operations changed the balances to the current values above:

- `INSTANCE_TRANSFER_OUT`: Main Arcade, −5,000
- `INSTANCE_TRANSFER_IN`: 3243, +5,000
- Shared reference: `xfer_e5f556941cf7f18f369923cf`

Do not reset or change these balances unless the user explicitly requests it.

## Most recently completed behavior

### Cabinet-style arcade lobby

- The authenticated lobby now follows the supplied portrait slot-cabinet reference: black/green cabinet field, gold accents, four illuminated status panels, oversized balance display, metallic category controls, gold-framed game artwork, and a mobile fixed Home/Games/Menu control deck.
- Mobile uses a two-column game grid and vertically stacked account, status, wallet, search, filters, and catalog sections. Desktop retains the same visual language in a wide catalog with the wallet selector pinned at the left.
- The status panels contain product/system labels rather than fabricated jackpot amounts. Existing per-user wallet selection, balances, language, search, filters, Play Config authorization, and game launching remain authoritative and functional.
- Playwright verified the authenticated design at 393×852 and 1440×900 with no lobby console errors. Category filtering, the protected Menu/Play Config flow, and a real game-card launch all passed.

### Accounts, balances, and instances

- Minimum password length is 4 characters.
- New accounts support a distinct nickname, with username as fallback for older accounts.
- New instances start at zero unless an assigned member has an existing balance.
- When an administrator creates an instance for a user, that user's current positive balance is moved from the selected/source instance to the new instance.
- Adding a user to an already-existing instance also moves their latest positive balance into the assigned instance.
- Transfers use paired `INSTANCE_TRANSFER_OUT` and `INSTANCE_TRANSFER_IN` ledger entries, preventing duplicated funds.
- Instance bindings, membership balances, nicknames, ledger, and latest state persist in PostgreSQL and were verified across a launcher restart.
- Administrators see one explicit selector option per instance member: `instance · nickname (balance currency)`. Users are never collapsed into one instance option, and launching requires that exact member wallet ID.
- Players receive only their own memberships from the server and can select only their own wallet; another member's name or balance is not exposed in their lobby payload.
- The selected instance/member wallet persists per account in browser storage.
- Returning Home from a slot restores the previously selected user instance rather than defaulting to Main Arcade.
- The lobby balance card follows the selected instance member, including when a root administrator selects another user's instance.
- Administration was renamed **Play Config**, moved to the former Sign Out position, and requires the signed-in administrator password before opening. Sign Out is inside Play Config.
- Play Config has an all-instance dropdown and a full immutable history view (up to 50,000 entries) showing balance loads, slot sessions, wagers/wins, timestamps, operators, and before/after balances. CSV export uses the same expanded limit.
- Each member has a persisted currency selected by an administrator: `RON`, `EUR`, or `GBP`. Existing users defaulted to `RON`.

### Simulated slot wallet

- Each launch creates a selected-user-bound simulated wallet session. When an administrator launches from a user's instance, the wallet uses that member's balance rather than the administrator's balance.
- EGT demo balance deltas become `GAME_WAGER` and `GAME_WIN` ledger entries.
- Wallet balances and immutable ledger amounts use `numeric(20,2)` precision. Fractional bets update immediately (for example, `724.00 - 0.10 = 723.90`) instead of accumulating until a whole credit changes.
- New launches append a zero-change `GAME_SESSION_OPENED` ledger entry with game key and opening balance.
- Lobby/admin balances update through server-sent events.
- Multiple game sessions serialize wallet changes per user/instance.
- The mobile bridge sends a final balance report during page teardown and periodic keepalives while unattended. Idle upstream reset/terminate messages do not restore an opening balance; only the administrator clear-state operation may reset persistent wallet state.
- SockJS-wrapped balance messages and EGT's `units=100` protocol scaling are translated so a stored balance of 5,000 displays as 5,000, not 50,000 or 0.
- This is explicitly a simulated bridge, not an official EGT operator/RGS wallet integration.

### Server-wide RTP control

- Root Play Config includes **Server-wide RTP (%)** and **Apply RTP server-wide**. It accepts `0.00` through `100.00` with two-decimal precision and is one persisted setting for every game and instance.
- Changing the percentage starts a fresh RTP accounting epoch. Each user-instance wallet tracks its own wager/return entitlement, preventing one player's wagers from funding another player's settlement; global counters are reporting totals only.
- Wagers debit normally. Each positive upstream settlement is scaled once by the configured percentage; at 100%, wagers and wins mirror upstream exactly. Positive events never catch up against cumulative prior wagers, which previously produced artificial 12–13-bet refunds. The EGT demo service still supplies reel/symbol presentation.
- Every adjusted `GAME_WIN` ledger entry records configured RTP, epoch, raw upstream amount, adjusted amount, per-wallet wager/return totals, and global totals. The setting, counters, balances, and immutable audit data persist through launcher restart.
- Isolated Playwright verification at 80% used two different instances: wagers of 10 and 30 returned 8 and 24 to their respective wallets, while global reporting showed 40 wagered / 32 returned. Restart restored the same setting, per-wallet counters, and balances. The temporary verification schema was removed without touching production.

### Slot client patches

- Home returns to the local lobby, which restores the selected instance.
- `PLAY` labels are removed.
- Static bundle and live SockJS/WebSocket currency labels use the selected wallet user's `RON`, `EUR`, or `GBP` setting everywhere (balance, win, denomination buttons, and jackpots). Operational identifiers such as `EGTBG` are preserved.
- Games launch full-window through `/game-client/`.
- Every proxied slot receives the shared mobile viewport patch. It follows `visualViewport`, orientation changes, browser chrome, fullscreen, and safe-area insets; the canvas is pinned to the exact visible width/height so bottom controls are not clipped and stale top black space is not introduced.
- Landscape-oriented EGT games remain aspect-preserving in portrait and can letterbox; landscape is recommended for play, while controls remain within the visible viewport.
- Interaction regression fixed on 2026-07-23: the mobile viewport patch had stretched transparent `#app-html` and `#modal-pop-up-layer` containers over the canvas with active hit testing, blocking every desktop and mobile control. The containers now use `pointer-events:none`, while their actual child controls opt back into pointer events.
- Clean Playwright verification against the real proxied 40 Super Hot Bell Link client proved the top hit target is `#app-canvas`: a desktop spin changed the isolated wallet from 150 to 100 and a 915×412 mobile landscape spin changed it from 100 to 50. The regression assertion is included in `npm test`.

### 2026-07-23 wallet and mobile verification

- Playwright exercised real UI account creation and administrator credits in an isolated PostgreSQL schema: three distinct users reached 150.00, 325.00, and 500.00, each as a separate selectable option.
- Concurrent game bridges then produced wager/win updates, including fractional values, ending at 138.00, 325.15, and 525.00. Fresh bridge sessions and a full launcher process restart restored those exact balances from PostgreSQL.
- The relational memberships, per-wallet monotonic sequences, immutable ledger before/after values, and `app_state` mirror were cross-checked with no balance mismatch.
- The real proxied 40 Super Hot Bell Link client was checked in portrait and landscape at iPhone-class 393x852, 402x874, and 440x956; Galaxy phone 360x780 and 412x915; and Galaxy Tab 800x1280. In all 12 orientations the canvas matched the visible viewport and had no scroll overflow; landscape screenshots showed the full bottom control bar.
- Regression suite: `npm test` passes 16/16, covering member selectors/privacy, pinned admin credits, teardown/idle wallet policy, inline-script syntax, mobile viewport injection, RTP settlement behavior, serialized browser reports, and cabinet-lobby navigation/game wiring.
- The isolated verification schema and temporary accounts are not production data and are removed after verification. Production balances were read before deployment and not changed by this test.

### Game icons

- 8081 mines the game-specific EGT product artwork, preferring the matching 496×420 image.
- Artwork is downloaded to `/egt/game-icons/` with a content hash in its filename.
- `/egt/data/game-icons.json` maps each game key to its exact local image.
- Icon selection requires game-specific identity evidence (slug, game key, or title), accepts known card-size variants, rejects duplicate image hashes across games, and reports importer failures in Play Config.
- 8080 watches that manifest, persists icon assignments, and updates connected clients.
- Authenticated `/game-icons/...` files are rendered on lobby cards.
- Verified fixture: `TSHSASlot` / 20 Super Hot, 496×420 PNG.

### 8081 capture GUI

- Regular capture still performs mining, Playwright/HAR capture, parsing, patching, packaging, and catalog insertion.
- Newly captured clients receive the shared currency transformer and default to `RON`; the same patch supports exact live currency replacement without changing three-character layout width.
- `Icon only` skips HAR capture and packaging.
- `Backfill icons for existing captures` detected 120 existing capture folders at handoff.
- `Select first 50` selects the first 50 available mined URLs.
- `Mine next 50` returns persistent consecutive batches for a target.
- Discovery cursors persist in `/egt/data/discovery-cursors.json` across 8081 restarts.
- The test cursor for the casino-games page was reset before handoff, so its next batch starts at URL 1.

## Important files

- `/egt/game-launcher.cjs` — 8080 HTTP/API server, accounts, instances, ledger, icon serving, simulated wallet.
- `/egt/launcher-store.cjs` — PostgreSQL state and immutable ledger storage.
- `/egt/index.html` — arcade, account, instance, nickname, balance, and administration UI.
- `/egt/game-client-patches.cjs` — Home, PLAY, per-user currency, and live SockJS/WebSocket client patches.
- `/egt/rtp-policy.cjs` — validated server-wide RTP target and isolated per-wallet settlement accounting.
- `/egt/arcade-control.sh` — interactive start/status/log/stop menu for ports 8080 and 8081.
- `/egt/game-importer.cjs` — 8081 capture, discovery batching, icon-only jobs, and backfill.
- `/egt/game-importer.html` — 8081 GUI.
- `/egt/data/game-icons.json` — persistent game-key-to-icon manifest.
- `/egt/data/discovery-cursors.json` — persistent next-50 discovery positions.
- `/egt/game-icons/` — locally downloaded game artwork.
- `/egt/data/launcher-auth.pre-postgres.json` and `/egt/data/launcher-auth.cutover-20260722.json` — pre-cutover backups; PostgreSQL is now authoritative.

## Security and operational notes

- Do not write plaintext passwords, setup codes, cookies, CSRF values, or session tokens into this note.
- Login sessions and active game bridges persist in PostgreSQL using SHA-256 token hashes. They survive launcher restarts and host reboots until logout or their 12-hour expiry; raw cookie/bridge tokens are not stored.
- Play Config authorization is server-enforced, stored with the session, and expires after 15 minutes.
- Relational users, instances, memberships, activity, catalog, settings, system audit, and importer jobs are the restart source of truth; `app_state` is a compatibility mirror.
- Wallet writes are serialized and checked against relational balances. New ledger entries receive a monotonic per-wallet sequence and database-recorded global order.
- Importer job feeds, discovery, and downloads require root management authentication. Jobs survive restart and full captures use verified staging with rollback promotion.
- `/health?deep=1` checks PostgreSQL, disk, proxy cache/in-flight work, launcher linkage, and Playwright. Operational records are pruned on retention schedules.
- PostgreSQL data survives reboot.
- The Node processes were manually running at handoff; they will not survive reboot unless separately configured as system services.
- Preserve unrelated files and existing capture directories.
- Use append-only ledger transactions for balance changes; do not mutate or delete ledger rows.

## Useful database checks

Current user-instance balances:

```bash
psql -d egt_arcade -P pager=off -c "select u->>'username' username,coalesce(nullif(u->>'nickname',''),u->>'username') nickname,u->>'currency' currency,i->>'name' instance,(m->>'balance')::numeric(20,2) balance from app_state cross join lateral jsonb_array_elements(data->'users') u cross join lateral jsonb_array_elements(data->'instances') i cross join lateral jsonb_array_elements(i->'members') m where m->>'userId'=u->>'id' order by username,instance"
```

Recent ledger entries:

```bash
psql -d egt_arcade -P pager=off -c "select created_at,username,amount,balance_before,balance_after,reason,reference from balance_ledger order by created_at desc limit 20"
```

Syntax verification before restarting modified code:

```bash
cd /egt
node --check game-launcher.cjs
node --check game-importer.cjs
npm test
```

## Continuation instruction

On the next session, read this file first, verify PostgreSQL and ports 8080/8081, and continue from the current workspace and database. Do not repeat completed migrations or reset production state.

## Local-to-VPS migration checkpoint — 2026-07-25 16:24 UTC

This is the current authoritative local workspace state before moving work back to the VPS.

### Git and source state

- Local repo path: `/home/xel/egt`
- Branch: `main`
- Origin before forking/pushing: `https://github.com/bokluknabelo/egt.git`
- Runtime/session files are intentionally ignored by Git. Do not force-add `data/launcher-auth*.json`, `data/launcher-file-runtime.json`, `data/egt-protocol-captures.jsonl`, setup tokens, bridge tokens, cookies, or GitHub credentials.
- A GitHub PAT was provided in chat for this migration. It must not be written to disk, committed, or left in remote URLs. Revoke/rotate it after the push because it appeared in chat.

### Runtime/session backup

- Local runtime bundle created outside the repo:
  `/home/xel/egt-vps-handoff/egt-runtime-state-20260725T1624Z.tar.gz`
- SHA-256:
  `1519a563b1fe6917fa79a68d54aaab9c595450c713739fbc73b6c1475789fe65`
- Bundle contents:
  `data/launcher-auth.json`
  `data/launcher-file-runtime.json`
  `data/egt-protocol-captures.jsonl`
- Use this bundle only for controlled VPS migration or audit. It contains live auth/runtime state and must not be published to GitHub.

### Local launcher state before shutdown

- Production-like local launcher was running on `0.0.0.0:443` with:
  `PORT=443`
  `EGT_PROTOCOL_CAPTURE_ALL=1`
  `EGT_GAME_ENGINE=local`
  `EGT_RESERVOIR_ONLY=1`
  `EGT_REPLAY_CAPTURED_PROFILE=1`
  `LAUNCHER_FILE_STORE=1`
- Fresh temporary WAN tunnel used for final verification:
  `https://ripe-bugs-bathe.loca.lt/`
- `/health` returned:
  `{"ok":true,"setupRequired":false,"shuttingDown":false}`
- The earlier `https://36b15f601c9fe3.lhr.life/` tunnel was stale and returned `no tunnel here`.

### Implemented local fixes to preserve

- Reservoir-backed local engine now loads captured slot reservoirs per slot and shuffles the reservoir bag instead of replaying a fixed startup state.
- 100-line reservoir wins are normalized to visible bet-sized increments. This fixes `OBCSlot` at bet 10 showing invalid wins such as 9, 13, or 22.
- Ordinary non-feature reservoir responses sanitize accidental coded coin/bonus-symbol floods. This fixes `TSFBLSlot` showing a full screen of bonus symbols during ordinary spins while preserving real feature payloads.
- Wallet settlement for authoritative local/reservoir slots is server-owned. Browser bridge balance reports no longer apply separate upstream deltas for those slots.
- Visible wallet settlement converts raw engine units with `/100`, so bet 10 wagers settle as `-10` and matching wins settle at the displayed amount.
- Shared reel timing patch was shortened for slow multi-slot testing:
  `gameInitialReelRotationTime=70`
  `gameInitialReelRotationTimeInQuickSpin=45`
  `gameBetweenReelsDelay=25`
  `gameBetweenReelsDelayInQuickSpin=0`
  `gameAnticipationReelsDelay=120`
- The launcher catalog now includes all 27 reservoir-backed slot keys, not only the original four.
- Main lobby UI was restyled toward the provided cabinet/photo reference: dark red cabinet surface, left cash panel, glowing rectangular game tiles, and bottom page buttons.

### Reservoir-backed slot keys enabled locally

`BCSlot`, `BDBLSlot`, `EDSlot`, `FBCSlot`, `FBHSSlot`, `FHBLSlot`, `FMCSlot`, `FSCBLSlot`, `FSFBLSlot`, `FZWBLSlot`, `MDBLSlot`, `OBCSlot`, `OSHSlot`, `PCHCSlot`, `PRCJWSlot`, `SACBLSlot`, `SBBLSlot`, `SCBLSlot`, `TBCSlot`, `TBHSlot`, `TCWSlot`, `TDHSlot`, `TSDSlot`, `TSFBLSlot`, `TWBHCHSlot`, `VNBLSlot`, `ZWBLSlot`.

### Verification completed locally

- Full regression command:
  `/root/node24/node-v24.18.0-linux-x64/bin/node test-wallet-regressions.cjs`
- Result:
  `104/104` passing.
- Focused all-reservoir audit:
  27 keys checked, zero invalid 100-line visible win increment issues, zero ordinary coded-symbol flood issues.
- Targeted samples:
  `OBCSlot` bet 10 no longer emitted visible wins outside 10-credit increments in the local sample.
  `TSFBLSlot` ordinary non-feature spins no longer emitted more than two coded coin/bonus symbols in the local sample.

### VPS continuation plan

1. Clone/pull the Git snapshot on the VPS.
2. Restore or carefully merge the runtime bundle only if the VPS should inherit local sessions/balances. Do not overwrite a newer VPS production database blindly.
3. Connect to the VPS PostgreSQL database and compare enabled UI titles against the 27 reservoir-backed local keys.
4. For every title enabled in the VPS UI, verify whether it should use local reservoir engine, fixed math engine, or upstream relay.
5. Start the VPS launcher with the same local-engine flags only after confirming PostgreSQL, catalog rows, user/member balances, and tunnel/ingress.
6. Re-run `test-wallet-regressions.cjs` and a small live smoke on `OBCSlot`, `TSFBLSlot`, `TSDSlot`, and `BCSlot` before resuming broad capture work.

## GitHub snapshot and next-machine continuation — 2026-07-25

- `/egt` is now a Git repository on branch `main`, with `origin` set to `https://github.com/bokluknabelo/egt.git`.
- Initial source-only snapshot: commit `7c2682c` (`Initial EGT Account Arcade source`).
- Before that snapshot, `npm test` and syntax checks for `game-launcher.cjs`, `launcher-store.cjs`, `game-importer.cjs`, and `game-client-patches.cjs` passed.
- The repository intentionally tracks application source, UI, scripts, documentation, math/configuration metadata, and launcher artwork. The working deployment remains larger than the Git repository.
- `.gitignore` intentionally excludes captured game directories and ZIP archives, `node_modules`, Playwright/runtime output, generated protocol captures/reports, logs, nested third-party repositories, and authentication-state files. Do not force-add those files without reviewing their size, provenance, licensing, and secrets.
- The multi-gigabyte `/tmp/egt-project.tar.gz` attempt was deleted. No archive is required for continuation; use Git for source and preserve the existing deployment/database separately.
- Historical `data/launcher-auth*.json` files remain local and untracked. Never commit them, setup tokens, browser/session cookies, database credentials, or GitHub credentials.
- The GitHub credential used for the initial push was supplied interactively, was not saved in the remote URL, and its temporary askpass file was deleted. Rotate/revoke that credential because it appeared in chat.

### Planned live capture from another machine

- The user plans to reconnect from another machine and provide a reachable local/LAN IP so live behavior can be captured there.
- At the start of that session, first pull/clone `main`, read this handoff, confirm which machine owns the authoritative PostgreSQL data, and verify reachability before changing services or firewall rules.
- Record the supplied host/IP, ports, target game/title and game key, exact reproduction steps, browser/device/orientation, selected user-instance wallet, and whether the run uses the normal upstream relay or `EGT_GAME_ENGINE=local`.
- For the unresolved `FDHBLSlot` blank-symbol/endless-spin issue, enable bounded per-spin response capture before reproducing. Capture timestamps/reference IDs, reel arrays and visible cells, entries, bonus/state envelopes, WebSocket request/response ordering, client console errors, and screenshots/video around the failing spin. Redact cookies, authorization headers, setup/session tokens, and unrelated account data before committing anything.
- Keep capture scope narrow and time-bounded. Store raw sensitive captures locally; commit only sanitized fixtures and the minimal code/config needed to reproduce or fix the issue.
- Do not expose PostgreSQL or management interfaces directly to an untrusted network. Prefer LAN-only access or an authenticated tunnel explicitly approved by the user.

## Current state — 2026-07-23 18:31 UTC

- Critical 12–13× wallet anomaly was traced through `log.txt` and the PostgreSQL ledger.
- Root cause of artificial positive adjustments: the RTP policy credited the cumulative unpaid percentage of all prior wagers when any positive upstream settlement arrived. At 100%, twelve or thirteen wagers therefore appeared as an unrelated +12/+13 win.
- `rtp-policy.cjs` now scales each positive upstream settlement exactly once. At the current 100% setting, every wager and win mirrors the upstream delta without cumulative catch-up credits.
- Browser wallet reports are now sent sequentially. A response older than the latest report cannot overwrite `localBalance` or its upstream offset. This prevents stale asynchronous responses from showing large client-only deductions that have no corresponding admin-history entry.
- The durable bridge retains fractional values, initialization state, keepalive delivery, and idle-reset protection.
- `npm test` passes all 16 tests. `node --check` passes for `game-launcher.cjs` and `rtp-policy.cjs`.
- Production consistency audit returned zero rows where ledger amount differed from `balance_after - balance_before`, and zero memberships whose balance differed from their latest ledger balance.
- No production balance or historical ledger rows were rewritten during the fix.
- Current runtime check: 8080 is responding with HTTP 200; 8081 is stopped.
- Use `cd /egt && ./arcade-control.sh` for the interactive service menu. It can start 8080, 8081, or both; show status and logs; and stop services that it started itself.
- The currently running 8080 process predates the menu and is intentionally detected as already running. The menu will not stop a process it did not start.

## Pre-reboot state — 2026-07-25 00:53 UTC

The first live-gated local WebSocket trial used **5 Dazzling Hot Bell Link** (`FDHBLSlot`) on port 8080 with `EGT_GAME_ENGINE=local`. Do not treat this title as production-ready after reboot.

### Completed before the live trial

- The Bell Link continuation protocol preserves held bells and decrements remaining spins without replaying the intro.
- The zero-remain outro now includes the client's native restore envelope. A deterministic real-client run completed its payout, restored controls, produced no Bell Link exceptions, and accepted another spin.
- A content-addressed 95% configuration was generated because the persisted server-wide setting is 95%. Its calculated total RTP is 95.017441%: 92.707835% base, 1.309606% hold-and-spin coins, and 1.000000% full-grid contribution.
- Only `FDHBLSlot` at target 95 passes the math registry. `game-launcher.cjs` checks the registry before selecting the local engine, so all other games remain on the upstream EGT relay.
- The regression suite passed 102/102 before the live run.

### Unresolved live-trial blockers

- The player repeatedly observed missing symbols, including an empty lowest visible position on reel five. One occurrence was followed by an endless client spin. HTTP wallet keepalives and the launcher remained responsive, and ledger entries continued, so the symptom is in the game-client presentation/protocol path rather than a VPS hang.
- Protocol capture currently retains samples by unique shape/signature rather than every spin payload. It did not preserve the exact reel arrays for the offending spins, so the missing symbol cannot yet be tied to a specific symbol code or reel stop. Before another trial, add bounded per-spin response capture for `FDHBLSlot`, including reference ID, all reel cells, entries, bonuses, state, and errors.
- The local engine emitted special Bell symbols from the authored/optimized strips. Audit whether every configured coin code (`8, 101, 102, 103, 104, 105, 108, 110`) is renderable by this exact client in every visible reel position. A non-renderable special symbol is the leading hypothesis for the blank cell and stalled reel animation.
- No Bell Link feature occurred during the live run. This is not evidence that the implemented trigger failed: the current model requires **5 visible bells**, not 4, and its exact five-bell trigger probability is `0.0001173273` per paid spin (about 1 in 8,523). With 539 recorded spins, the probability of seeing zero triggers is about 93.9%. Confirm the intended trigger count against the title's in-game rules before changing it.
- Live ledger totals for user `2` from 00:25:47 through 00:52:36 UTC: 539 paid spins, 539.00 wagered, 869.00 returned, observed short-run RTP 161.22%, last reference `FDHBLSlot:540`. This small/volatile sample is not the theoretical RTP and must not be used to rewrite balances or ledger history.
- The live launcher was started in a Codex terminal session, not as a system service, and will stop during reboot. Do not automatically restart it with `EGT_GAME_ENGINE=local` until the missing-symbol/endless-spin issue is reproduced with full payload capture or the user explicitly requests another trial.

### Safe restart after reboot

- Start PostgreSQL and verify the database first.
- For normal arcade availability, start 8080 **without** `EGT_GAME_ENGINE=local`; this keeps all EGT titles on their upstream relay.
- Keep 8081 stopped unless capture/import work is requested.
- Preserve production balances and immutable ledger rows.
