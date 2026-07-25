const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { shouldIgnoreUpstreamReset } = require('./wallet-bridge-policy.cjs');
const { mobileViewportScript, localLobbyNavigationScript, patchReelsTimingBundle } = require('./game-client-patches.cjs');
const { applyGlobalRtp, freshRtpAccounting, normalizeRtpPercent } = require('./rtp-policy.cjs');
const { compressionCacheVariant } = require('./game-proxy-policy.cjs');
const { EgtLocalSession, PAYLINES_20, PAYLINES_40_4ROW, paylinesFor, sockJsEncode } = require('./egt-local-engine.cjs');
const { RorgklReelReservoir } = require('./rorgkl-reel-engine.cjs');
const { fixedReelOutcome, spinReelStrips } = require('./egt-fixed-reel-engine.cjs');
const { buildMathConfiguration } = require('./egt-math-configs.cjs');
const { exactBaseGameMath, visibleCountDistribution } = require('./egt-exact-math.cjs');
const { optimizeReelConfiguration, tunableSymbols } = require('./egt-reel-optimizer.cjs');
const { selectMathConfiguration } = require('./egt-math-registry.cjs');
const { composeGameMath, exactFreeSpinMath, exactHoldSpinFromState, exactHoldSpinMath } = require('./egt-feature-math.cjs');
const { deriveFamilyMathSpec } = require('./egt-family-math-specs.cjs');
const { chiSquareUniform, highConfidenceChecks, runsAboveMedian, serialCorrelation, simulateHoldFeatureConditional, simulateMathConfiguration, theoreticalBaseMaximumWinMultiple } = require('./egt-math-validator.cjs');
const {bellTriggerStatistics,buildBellFeatureMath,coinValueSchedule}=require('./egt-bell-link-math.cjs');

const launcher = fs.readFileSync('game-launcher.cjs', 'utf8');
const ui = fs.readFileSync('index.html', 'utf8');
const playConfig = fs.readFileSync('play-config.html', 'utf8');

test('active wallet choices are one instance-member pair per option', () => {
  assert.match(ui, /walletChoices\(\)[\s\S]*?\.map\(\s*\(\{ instance, member \}\) =>/);
  assert.match(ui, /value="\$\{instance\.id\}\|\$\{member\.userId\}"/);
  assert.doesNotMatch(ui, /players\.map\(item=>`\$\{item\.nickname\|\|item\.username\}/);
});

test('play selector receives only the signed-in user active membership', () => {
  assert.match(launcher, /canAdmin\(viewer, instance\) \? instance\.members : instance\.members\.filter\(member => member\.userId === viewer\.id\)/);
  assert.match(launcher, /requestedWalletUserId = String\(input\.walletUserId \|\| auth\.user\.id\)/);
  assert.match(launcher, /Players can only launch their own wallet/);
  assert.match(ui, /walletUserId: member\.userId/);
  assert.match(launcher, /instances: playablePublicInstances\(user\)/);
  assert.match(launcher, /managedInstances: user\.role === 'admin'/);
  assert.match(launcher, /Instance is not active for this account/);
  assert.match(launcher, /member\.userId !== instance\.ownerUserId && memberAccessActive/);
  assert.match(ui, /function adminInstance\(\)/);
});

test('administrator-managed player wallets remain available to the RTP bridge', () => {
  assert.match(launcher, /const accessMember = canAdmin\(auth\.user, instance\) \? null : touchMemberAccess/);
  assert.match(launcher, /\(!canAdmin\(auth\.user, instance\) && !accessMember\) \|\| !walletMember \|\| !walletUser/);
  assert.doesNotMatch(launcher, /if \(!member \|\| !walletMember \|\| !walletUser\) throw apiError\(403, 'Game wallet is unavailable'\)/);
});

test('player instance access persists until explicit administrator deactivation', () => {
  assert.doesNotMatch(launcher, /INSTANCE_IDLE_TIMEOUT_MS/);
  assert.match(launcher, /function memberAccessActive\(member\) \{ return Boolean\(member\?\.accessActive\); \}/);
  assert.match(launcher, /canAdmin\(user, instance\) \|\| memberAccessActive\(memberFor\(user, instance\)\)/);
  assert.match(launcher, /INSTANCE_ACCESS_ACTIVATED/);
  assert.match(launcher, /INSTANCE_ACCESS_DEACTIVATED/);
  assert.match(ui, /Active until deactivated/);
  assert.match(launcher, /revokeMemberGameSessions\(instance\.id, member\.userId\)/);
  assert.doesNotMatch(ui, /Activate 10 min/);
});

test('new assignments activate only the assigned member and direct game access remains lease-gated', () => {
  assert.match(launcher, /instance\.members\.push\(newMember\); activateMember\(instance, newMember, auth\.user\)/);
  assert.match(launcher, /accessActive: true, lastActiveAt: now\(\)/);
  assert.match(launcher, /if \(!canAdmin\(auth\.user, instance\) && !memberAccessActive\(memberFor\(auth\.user, instance\)\)\) throw apiError\(404, 'Instance not found'\)/);
  assert.match(launcher, /touchMemberAccess\(instance, auth\.user\)/);
});

test('Play Config exposes elevated instance and user deletion controls', () => {
  assert.match(launcher, /request\.method === 'DELETE'.*\/api\\\/accounts/s);
  assert.match(launcher, /request\.method === 'DELETE'.*\/api\\\/instances/s);
  assert.match(launcher, /Administrators can only be removed by the head administrator panel/);
  assert.match(launcher, /ADMIN_TENANT_REMOVED/);
  assert.match(launcher, /verifyPassword\(input\.adminPassword, auth\.user\)/);
  assert.match(ui, /id=\"deleteInstance\"/);
  assert.match(ui, /class=\"danger deleteUser\"/);
});

test('launching a game does not require Play Config elevation on each device', () => {
  const match=launcher.match(/const elevatedPaths=(\/\^\\\/api[\s\S]*?\/);/);
  assert.ok(match,'elevated route expression exists');
  const elevated=Function(`return ${match[1]}`)();
  assert.equal(elevated.test('/api/instances/instance-one/launch'),false);
  assert.equal(elevated.test('/api/instances/instance-one/ledger'),true);
  assert.equal(elevated.test('/api/instances'),true);
  assert.match(launcher, /if \(!auth\.user\.root && elevatedPaths\.test\(url\.pathname\)\)/);
});

test('admin credit confirmation remains pinned to its original instance and user', () => {
  assert.match(ui, /const instance = adminInstance\(\),[\s\S]*?instanceId = instance\?\.id,[\s\S]*?member = instance\?\.members\.find/);
  assert.match(ui, /`\/api\/instances\/\$\{instanceId\}\/credits`/);
  assert.match(launcher, /if\(!currentMember\)throw apiError\(404,'Member not found'\)/);
});

test('mobile wallet reports survive page teardown and ignore idle upstream resets', () => {
  assert.match(launcher, /keepalive:true/);
  assert.match(launcher, /upstreamReset=shouldIgnoreUpstreamReset/);
  assert.match(launcher, /shouldIgnoreUpstreamReset\(\{upstreamBase,rawCredits,projected,localBalance,hidden:document\.hidden,idleFor\}\)/);
  assert.match(launcher, /if\(upstreamReset\)\{offset=localBalance-rawCredits;return localBalance\}/);
  const reset = { upstreamBase: 1000, rawCredits: 1000, projected: 150, localBalance: 140 };
  assert.equal(shouldIgnoreUpstreamReset({ ...reset, hidden: true, idleFor: 1000 }), true);
  assert.equal(shouldIgnoreUpstreamReset({ ...reset, hidden: false, idleFor: 60001 }), true);
  assert.equal(shouldIgnoreUpstreamReset({ ...reset, hidden: false, idleFor: 1000 }), false);
  assert.equal(shouldIgnoreUpstreamReset({ ...reset, rawCredits: 990, hidden: true, idleFor: 60001 }), false);
});

test('all inline UI scripts remain syntactically valid', () => {
  for (const match of ui.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
  for (const match of playConfig.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
});

test('root Play Config is a documented standalone command dashboard', () => {
  assert.match(ui, /window\.open\("\/play-config", "_blank", "noopener"\)/);
  assert.match(launcher, /url\.pathname === '\/play-config'/);
  assert.match(launcher, /if \(!auth\.user\.root\) throw apiError\(403, 'Head administrator required'\)/);
  for (const section of ['Administrators','Users','Instances & wallets','Game catalog','System policy','Operations & audit']) assert.match(playConfig, new RegExp(section.replace('&','&amp;|&')));
  assert.match(playConfig, /No server restart is required/);
  assert.match(playConfig, /root\.querySelectorAll\('\[data-permission\]'\)/);
  assert.match(playConfig, /Authorization lasts 15 minutes/);
});

test('sign out remains available from the main arcade header', () => {
  assert.match(ui, /id="mainLogout"[^>]*>Sign out<\/button>/);
  assert.match(ui, /el\("mainLogout"\)\.onclick = signOut/);
  assert.match(ui, /const signOut = async \(\) =>[\s\S]*?\/api\/logout/);
});

test('head admin atomically provisions a tenant user and local instance', () => {
  assert.match(launcher, /url\.pathname === '\/api\/admin\/provision-user'/);
  assert.match(launcher, /user\.role === 'admin' && !user\.root && user\.username === normalizeUsername\(input\.adminUsername\)/);
  assert.match(launcher, /tenantAdminId:owner\.id/);
  assert.match(launcher, /ownerUserId:owner\.id/);
  assert.match(launcher, /accessActive:true, lastActiveAt:now\(\)/);
  assert.match(launcher, /input\.activate !== true/);
  assert.match(launcher, /verifyPassword\(input\.adminPassword, auth\.user\)/);
  assert.match(launcher, /hashPassword\(crypto\.randomBytes\(32\)\.toString\('base64url'\)\)/);
  assert.match(launcher, /USER_INSTANCE_PROVISIONED/);
  assert.match(launcher, /source:'head-admin-provisioning'/);
  assert.match(playConfig, /id="provisionForm"/);
  const form=playConfig.match(/<form id="provisionForm"[\s\S]*?<\/form>/)?.[0]||'';
  for (const field of ['adminUsername','username','currency','instanceName','initialCredits','activate','adminPassword']) assert.match(form,new RegExp(`name="${field}"`));
  assert.doesNotMatch(form, /name="(?:nickname|password)"/);
  assert.match(form, /Create live active instance/);
  assert.match(playConfig, /result\.instance\.ownerUserId!==result\.owner\.id\|\|result\.user\.tenantAdminId!==result\.owner\.id/);
  assert.match(playConfig, /liveEvents\.addEventListener\('balance',scheduleRefresh\)/);
});

test('player-facing identity uses username only', () => {
  assert.doesNotMatch(playConfig, /Display name|Player display name|Temporary player password|name="nickname"/);
  assert.doesNotMatch(ui, /Nickname|name="nickname"/);
  assert.match(launcher, /function publicUser\(user\) \{ return \{ id: user\.id, username: user\.username, role:/);
  assert.doesNotMatch(launcher, /function publicUser\(user\)[^\n]*nickname/);
  assert.doesNotMatch(launcher, /return \{ userId: member\.userId,[^\n]*nickname/);
  assert.match(ui, /el\("accountName"\)\.textContent = state\.user\.username/);
});

test('instance activation targets assigned players and never the administrator owner', () => {
  assert.match(launcher, /\/members\\\/activate-all/);
  assert.match(launcher, /instance\.members\.filter\(member => member\.userId !== instance\.ownerUserId\)/);
  assert.match(launcher, /No player is assigned to this instance/);
  assert.match(launcher, /INSTANCE_PLAYERS_ACTIVATED/);
  assert.match(playConfig, /Activate all players/);
  assert.match(playConfig, /No player to activate/);
  assert.match(playConfig, /Permanent admin access/);
  assert.match(playConfig, /Administrator owner access/);
});

test('mobile game shell follows the visible viewport and preserves bottom controls', () => {
  const patch = mobileViewportScript();
  assert.match(patch, /visualViewport/);
  assert.match(patch, /--egt-visual-height/);
  assert.match(patch, /safe-area-inset-bottom/);
  assert.match(patch, /interactive-widget=resizes-content/);
  assert.match(patch, /#app-canvas/);
  assert.match(patch, /#app-html,#modal-pop-up-layer\{[^}]*pointer-events:none!important/);
  assert.match(patch, /#app-html>\* ,#modal-pop-up-layer>\*\{pointer-events:auto\}/);
  assert.match(launcher, /mobileViewportScript\(\)\+localLobbyNavigationScript\(\)\+currencyWebSocketScript/);
  for (const script of patch.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]));
});

test('native game Home and Menu footer taps return to the local arcade lobby', () => {
  const patch = localLobbyNavigationScript();
  assert.match(patch, /pointerup/);
  assert.match(patch, /touchend/);
  assert.match(patch, /x<=\.18\|\|x>=\.82/);
  assert.match(patch, /portrait\?\.76:\.9/);
  assert.match(patch, /window\.top\.location\.assign\('\/'\)/);
  assert.match(launcher, /mobileViewportScript\(\)\+localLobbyNavigationScript\(\)\+currencyWebSocketScript/);
  assert.doesNotMatch(launcher, /Return to game lobby/);
  for (const script of patch.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]));
});

test('personalized game HTML is never shared through the gzip cache', () => {
  assert.equal(compressionCacheVariant({contentType:'text/html; charset=utf-8',pathname:'/'}), null);
  assert.equal(compressionCacheVariant({contentType:'application/javascript',pathname:'/index.bundle.min.js',currency:'GBP'}), 'index-true-GBP');
  assert.match(launcher, /if \(variant === null\) payload = zlib\.gzipSync/);
});

test('administrator credits retain request evidence and show the resulting balance before confirmation', () => {
  assert.match(launcher, /source:'admin-balance-control'/);
  assert.match(launcher, /sessionFingerprint:auth\.tokenHash\.slice\(0,12\)/);
  assert.match(launcher, /balanceBefore,balanceAfter,\.\.\.evidence/);
  assert.match(ui, /Balance: \$\{member\.balance\.toLocaleString\(\)\} →/);
  assert.match(ui, /operationId = newOperationId\(\)/);
  assert.match(ui, /typeof crypto\.randomUUID === "function"/);
  assert.match(ui, /crypto\.getRandomValues\(bytes\)/);
});

test('clear slate hides the full pre-clear ledger without changing balances', () => {
  const store=fs.readFileSync('launcher-store.cjs','utf8');
  assert.match(store, /if \(options\.since\).*created_at>/);
  assert.match(launcher, /listLedger\(instance\.id, \{ since: instance\.clearedAt \|\| undefined/);
  assert.match(launcher, /instance\.activity = \[\]; instance\.clearedAt = now\(\)/);
});

test('game history attributes openings and spins to the wallet user', () => {
  assert.match(launcher, /actorUserId: walletUser\.id, actorUsername: walletUser\.username, amount: applied/);
  assert.match(launcher, /actorUserId: walletUser\.id, actorUsername: walletUser\.username, amount: 0/);
  assert.match(launcher, /audit\(instance, walletUser, reason/);
  assert.match(launcher, /audit\(instance, walletUser, 'GAME_LAUNCHED'/);
  assert.match(launcher, /launchedByUsername: auth\.user\.username/);
});

test('provider outcomes pass through unchanged while accounting remains server-wide', () => {
  const settings = freshRtpAccounting(75, 'epoch-one');
  assert.equal(applyGlobalRtp(settings, -40, 'instance-one:user-one').appliedDelta, -40);
  assert.equal(applyGlobalRtp(settings, -60, 'instance-two:user-two').appliedDelta, -60);
  const payout = applyGlobalRtp(settings, 5, 'instance-one:user-one');
  assert.equal(payout.appliedDelta, 5);
  const otherPayout = applyGlobalRtp(settings, 20, 'instance-two:user-two');
  assert.equal(otherPayout.appliedDelta, 20);
  assert.equal(settings.rtpTotalWagered, 100);
  assert.equal(settings.rtpTotalReturned, 25);
  assert.equal(applyGlobalRtp(settings, 20, 'instance-one:user-one').appliedDelta, 20);
  assert.equal(normalizeRtpPercent('92.35'), 92.35);
  assert.throws(() => normalizeRtpPercent(100.01), /between/);
  assert.match(launcher, /applyGlobalRtp\(db\.settings, accountableDelta, walletKey\)/);
  assert.match(launcher, /freshRtpAccounting\(nextRtp, now\(\)\)/);
  assert.match(ui, /Local-engine RTP/);
  assert.match(ui, /Custom RTP requires the local game engine/);
  assert.match(launcher, /nextRtp !== 100.*Custom RTP requires the local game engine/);
  assert.equal(applyGlobalRtp(freshRtpAccounting(10), 900, 'instance:user').appliedDelta, 900);
});

test('100% RTP mirrors each upstream settlement without accumulated-bet refunds', () => {
  const settings = freshRtpAccounting(100, 'epoch-pass-through');
  for (let spin = 0; spin < 13; spin += 1) assert.equal(applyGlobalRtp(settings, -1, 'instance:user').appliedDelta, -1);
  assert.equal(applyGlobalRtp(settings, 2, 'instance:user').appliedDelta, 2);
  assert.equal(settings.rtpTotalReturned, 2);
});

test('browser wallet serializes authoritative settlements before delivering balance packets', () => {
  assert.match(launcher, /reportQueue=Promise\.resolve\(\)/);
  assert.match(launcher, /operation=reportQueue\.then\(\(\)=>fetch/);
  assert.match(launcher, /const requestSequence=\+\+sequence/);
  assert.match(launcher, /localBalance=value\.balance;offset=localBalance-rawCredits/);
  assert.match(launcher, /shown=await report/);
  assert.match(launcher, /eventFor\(event\)\.then/);
  assert.match(launcher, /transformQueue=operation\.catch/);
  assert.match(launcher, /error\.message==='Wallet update failed'\)throw error/);
  const source = launcher.slice(launcher.indexOf('function legacyDurableSimulatedBridgeScript'), launcher.indexOf('async function checkForUpdates'));
  const build = new Function('shouldIgnoreUpstreamReset', `${source};return durableSimulatedBridgeScript`) (shouldIgnoreUpstreamReset);
  const inline = build('test-token').match(/^<script>([\s\S]*)<\/script>$/)?.[1];
  assert.ok(inline);
  assert.doesNotThrow(() => new Function(inline));
});

test('local engine exposes separate wager and gross-win settlement amounts', () => {
  assert.match(launcher, /settleLocalEngineRound\(context, settlement, engine\.balance\)/);
  assert.match(launcher, /grossSettlement: true/);
  assert.match(launcher, /addEntry\(-Math\.min\(balance, wager\), 'GAME_WAGER'/);
  assert.match(launcher, /addEntry\(win, 'GAME_WIN'/);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, 'egt-local-engine.cjs'), 'utf8'), /consumeSettlement\(\)/);
});

test('EGT game websocket is routed through an authenticated local protocol relay', () => {
  assert.match(launcher, /url\.pathname === '\/egt-game-websocket'/);
  assert.match(launcher, /target\.hostname !== 'game-server-demo\.egt-ong\.com'/);
  assert.match(launcher, /bridgeFor\(request, token\)/);
  assert.match(launcher, /captureEgtProtocolFrame\(context\.bridge, 'client_to_egt'/);
  assert.match(launcher, /captureEgtProtocolFrame\(context\.bridge, 'egt_to_client'/);
  assert.match(launcher, /egt-protocol-captures\.jsonl/);
  assert.match(launcher, /EGT_PROTOCOL_CAPTURE_ALL/);
  const source = launcher.slice(launcher.indexOf('function legacyDurableSimulatedBridgeScript'), launcher.indexOf('async function checkForUpdates'));
  const build = new Function('shouldIgnoreUpstreamReset', `${source};return durableSimulatedBridgeScript`)(shouldIgnoreUpstreamReset);
  const inline = build('relay-token').match(/^<script>([\s\S]*)<\/script>$/)[1];
  assert.match(inline, /\/egt-game-websocket\?bridge=/);
  assert.doesNotThrow(() => new Function(inline));
});

test('local EGT engine speaks captured loadGame and bet schemas', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 5000000, targetRtp: 100, random: () => 0 });
  const loaded = JSON.parse(JSON.parse(engine.messages(sockJsEncode({ event: 'loadGame', id: 1 }))[0].slice(1))[0]);
  assert.equal(loaded.event, 'loadGame'); assert.equal(loaded.balance.balance, 5000000); assert.equal(loaded.settings.clientSettings.configuredRtp, '9579');
  assert.deepEqual(loaded.settings.bets, [1, 2.5, 5, 10, 25, 50]);
  assert.deepEqual(loaded.settings.denominations, [1]);
  const result = JSON.parse(JSON.parse(engine.messages(sockJsEncode({ event: 'bet', bet: { level: 5, factor: 20, denomination: 1, lines: 20, gameMode: 'NORMAL_MODE' }, id: 2 }))[0].slice(1))[0]);
  assert.equal(result.event, 'bet'); assert.equal(result.state, 'win'); assert.ok(Number(result.game.state.totalWin) > 0); assert.equal(result.game.state.totalWin, result.game.result.spins[0].totalWinAmount);
  assert.equal(
    result.game.result.spins[0].entries.reduce((sum, entry) => sum + Number(entry.winAmount || 0), 0),
    Number(result.game.state.totalWin),
  );
});

test('all local titles expose and enforce the six global total bets', () => {
  const allowed = [20, 50, 100, 200, 500, 1000];
  for (const gameKey of ['EITHSlot', 'RORGKLSlot', 'OHBRSlot', 'TSHSASlot']) {
    const profile = JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`, 'utf8'));
    const engine = new EgtLocalSession({ profile, gameKey, balanceUnits: 1e9, targetRtp: 80, random: () => 0.5 });
    const loaded = engine.loadGame({ id: 1 }), factor = loaded.settings.factor;
    assert.deepEqual(loaded.settings.denominations, [1]);
    assert.deepEqual(loaded.settings.factors, [factor]);
    assert.deepEqual(loaded.settings.bets.map(level => Math.round(level * factor)), allowed);
    assert.equal(Math.round(loaded.game.state.bet.level * loaded.game.state.bet.factor * loaded.game.state.bet.denomination), 20);
    const opening = engine.balance;
    const rejected = engine.bet({ id: 2, bet: { level: 12 / factor, factor, denomination: 1, lines: loaded.settings.lines } });
    assert.equal(rejected.error?.code, 'INVALID_BET'); assert.equal(engine.balance, opening); assert.equal(engine.consumeSettlement(), null);
  }
});

test('every migrated title routes through an explicit local engine family', () => {
  const { DEFINITIONS, inventoryProfiles } = require('./egt-family-engines.cjs');
  const titles = inventoryProfiles();
  assert.equal(titles.length, 133);
  assert.equal(new Set(titles.map(title => title.gameKey)).size, 133);
  assert.equal(titles.some(title => !DEFINITIONS[title.family]), false);
  assert.equal(titles.some(title => !title.reels), false);
});

test('each local mechanics family owns a distinct WebSocket upgrade handler', () => {
  assert.match(launcher, /egtFamilyWebSockets = new Map\(Object\.keys\(EGT_FAMILY_DEFINITIONS\)/);
  assert.match(launcher, /new WebSocketServer\(\{ noServer: true \}\)/);
  assert.match(launcher, /const \{ familyId, familyServer \} = egtFamilyWebSocket\(profile\)/);
  assert.match(launcher, /return familyServer\.handleUpgrade\(request, socket, head/);
  assert.match(launcher, /egtRelayWebSockets\.handleUpgrade/);
  assert.match(launcher, /health\.familyWebSockets=Object\.fromEntries/);
});

test('each mechanics family instantiates its own engine class', () => {
  const { DEFINITIONS, ENGINE_CLASSES, createFamilyEngine, inventoryProfiles } = require('./egt-family-engines.cjs');
  assert.deepEqual(Object.keys(ENGINE_CLASSES).sort(), Object.keys(DEFINITIONS).sort());
  const titles = inventoryProfiles();
  for (const family of new Set(titles.map(title => title.family))) {
    const title = titles.find(value => value.family === family);
    const profile = JSON.parse(fs.readFileSync(`data/egt-profiles/${title.gameKey}.json`, 'utf8'));
    assert.equal(createFamilyEngine(profile, title.gameKey).constructor, ENGINE_CLASSES[family]);
  }
});

test('family engines own WebSocket request dispatch', () => {
  const familySource = fs.readFileSync('egt-family-engines.cjs', 'utf8');
  const localSource = fs.readFileSync('egt-local-engine.cjs', 'utf8');
  assert.match(familySource, /handle\(session, request\) \{ return session\.handleShared\(request\); \}/);
  assert.match(localSource, /handle\(request\) \{ return this\.familyEngine\.handle\(this, request\); \}/);
});

test('family evaluators select payline versus ways result protocols', () => {
  const { createFamilyEngine } = require('./egt-family-engines.cjs');
  const cases = [
    ['TWSHSlot', 'line'],
    ['EITHSlot', 'ways'],
    ['HFTTSlot', 'ways'],
  ];
  for (const [gameKey, mode] of cases) {
    const profile = JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`, 'utf8'));
    const engine = new EgtLocalSession({ profile, gameKey, balanceUnits: 1e9, targetRtp: 100, random: () => 0 });
    assert.equal(engine.familyEngine.constructor, createFamilyEngine(profile, gameKey).constructor);
    const bet = { level: 1000, factor: 5, denomination: 1, lines: Number(profile.settings.lines || 0) };
    const outcome = engine.familyEngine.outcome(engine, 5000, bet);
    assert.equal(outcome.spin.entries[0].mode, mode);
  }
});

test('family rule inventory traces migrated titles to extracted in-game help', () => {
  const rules = JSON.parse(fs.readFileSync('data/egt-family-rules.json', 'utf8'));
  assert.equal(rules.titleCount, 133);
  assert.ok(rules.directRuleSources >= 129);
  assert.ok(rules.directRuleSources + rules.inheritedRuleSources >= 132);
  assert.ok(rules.titles.find(title => title.gameKey === 'RORGKLSlot').rules['PAYTABLE.WILD_PART_1'].includes('Substitutes'));
});

test('family base protocol acknowledges collect and returns to playable idle state', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e8, targetRtp: 100, random: () => 0 });
  engine.bet({ id: 1, bet: { level: 20, denomination: 1, lines: 50, factor: 50 } });
  const response = engine.handle({ event: 'collect', id: 2, bet: { level: 20, denomination: 1, lines: 50, factor: 50 } });
  assert.equal(response.event, 'collect'); assert.equal(response.referenceId, 2); assert.equal(response.state, 'idle');
  assert.equal(response.error, undefined); assert.equal(response.game.state.rounds.length, 0);
  assert.equal(response.balance.balance, engine.balance);
});

test('reel-strip occurrence weighting keeps five-of-kind rare independently of RTP', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const { outcomeOccurrenceLikelihood, weightedPaytable } = require('./egt-local-engine.cjs');
  assert.ok(outcomeOccurrenceLikelihood(profile, 3, 5) < outcomeOccurrenceLikelihood(profile, 3, 3) / 50);
  const distribution = weightedPaytable(profile, 25);
  const fiveKindShare = distribution.groups.reduce((total, group, groupIndex) => total + group.values.reduce((sum, value, valueIndex) => sum + (value.occurs === 5 ? distribution.weights[groupIndex] * group.valueWeights[valueIndex] : 0), 0), 0);
  assert.ok(fiveKindShare <= 0.00000011, `five-kind conditional share ${fiveKindShare}`);
  assert.ok(distribution.groups.some(group => group.values.some(value => value.occurs === 2)), 'right-aligned four-entry paytables retain two-of-kind awards');
});

test('Gods and Kings simple-multiplier family completes a rule-derived free-spin lifecycle', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const { freeSpinRules } = require('./egt-family-engines.cjs');
  assert.deepEqual(freeSpinRules('RORGKLSlot'), { triggerCount: 3, count: 15, multiplier: 3, mode: 'simple-multiplier' });
  let seed = 0x46524545;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e8, targetRtp: 48, random });
  const bet = { level: 20, denomination: 1, lines: 50, factor: 50 }, opening = engine.balance;
  let naturalTrigger;
  while (!naturalTrigger?.triggersFreeSpins) naturalTrigger = engine.reelReservoir.candidate(50, 48);
  engine.reelReservoir.key = '50:48'; engine.reelReservoir.queue = [{ ...naturalTrigger, controlled: false }];
  const trigger = engine.bet({ id: 1, bet });
  assert.equal(trigger.state, 'freespin'); assert.equal(engine.activeFeature.remain, 15);
  assert.ok(trigger.game.result.spins[0].reels.flat().filter(symbol => symbol === 12).length >= 3);
  assert.equal(engine.consumeSettlement().wagerUnits, 1000);
  let response;
  for (let round = 0; round < 15; round += 1) response = engine.bet({ id: round + 2, bet });
  assert.equal(engine.activeFeature, null); assert.equal(response.state, 'win'); assert.equal(response.game.state.rounds[0].remain, 0);
  const award = engine.consumeSettlement(); assert.equal(award.wagerUnits, 0); assert.ok(award.winUnits > 0);
  assert.equal(engine.balance, opening - 1000 + award.winUnits);
  const collected = engine.collect({ id: 20, bet }); assert.equal(collected.state, 'idle'); assert.equal(collected.error, undefined);
});

test('RORGKL base spins show reel-strip scatters without falsely triggering free spins', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const { scatterCountProbabilities } = require('./egt-family-engines.cjs');
  const probabilities = scatterCountProbabilities(profile, 12);
  assert.ok(probabilities[1] > 0.2 && probabilities[1] < 0.3);
  assert.ok(probabilities[2] > 0.02 && probabilities[2] < 0.05);
  assert.ok(probabilities.slice(3).reduce((sum, value) => sum + value, 0) > 0.001);
  let seed = 0x5ca77e12;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e9, targetRtp: 80, random });
  const bet = { level: 20, denomination: 1, lines: 50, factor: 50 };
  const observed = { zero: 0, one: 0, two: 0, paidTwo: 0, trigger: 0 };
  for (let spin = 0; spin < 5000; spin += 1) {
    const response = engine.bet({ id: spin + 1, bet });
    const count = response.game.result.spins[0].reels.flatMap(reel => reel.slice(1, 4)).filter(symbol => symbol === 12).length;
    if (response.state === 'freespin') { observed.trigger += 1; while (engine.activeFeature) engine.bet({ id: 10000 + spin, bet }); }
    else if (count === 1) observed.one += 1;
    else if (count === 2) { observed.two += 1; const scatter = response.game.result.spins[0].entries.find(entry => entry.mode === 'scatter'); if (scatter?.win === 1000) observed.paidTwo += 1; }
    else observed.zero += 1;
  }
  assert.ok(observed.one > 900, JSON.stringify(observed));
  assert.ok(observed.two > 80, JSON.stringify(observed));
  assert.equal(observed.paidTwo, observed.two, JSON.stringify(observed));
  // A 500-spin untouched tranche may legitimately contain no rare trigger;
  // trigger lifecycle is covered deterministically above.
});

test('local whole-outcome engine converges at 100%, 50%, and 10% without scaling accepted wins', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  for (const target of [100, 50, 10]) {
    let seed = 0x12345678, returned = 0, acceptedWin = null;
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
    const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 1e12, targetRtp: target, random });
    for (let spin = 0; spin < 100000; spin += 1) { const outcome = engine.outcome(100, { factor: 20 }); returned += outcome.totalWin; if (outcome.totalWin) acceptedWin ||= outcome.totalWin; }
    const measured = returned / 100000;
    assert.ok(Math.abs(measured - target) < 3, `${target}% target measured ${measured}%`);
    assert.ok(acceptedWin > 0, 'accepted wins remain positive whole paytable outcomes');
  }
});

test('ordinary RTP retains small multi-line paytable awards instead of promoting rare patterns', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  let seed = 0x96f00d, hits = 0; const multiples = new Set(), symbols = new Set();
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 1e12, targetRtp: 96, random });
  for (let spin = 0; spin < 10000; spin += 1) {
    const outcome = engine.syntheticOutcome(100, { factor: 20 });
    if (!outcome.totalWin) continue;
    hits += 1;
    assert.equal(outcome.totalWin, outcome.spin.entries.reduce((sum, entry) => sum + Math.round(100 * entry.coef / 20) * entry.multiplier, 0), 'each simultaneous line follows the unscaled paytable coefficient');
    multiples.add(outcome.totalWin / 100); symbols.add(outcome.spin?.entries?.[0]?.symbol);
  }
  assert.ok(hits > 500 && hits < 9500, `96% RTP hit rate should remain meaningful, got ${hits / 100}%`);
  assert.ok(multiples.size >= 4, `expected varied payout multiples, got ${[...multiples]}`);
  assert.ok(symbols.size >= 5, `expected premium symbol participation, got ${[...symbols]}`);
});

test('EITH ways weighting keeps all ordinary symbols in the winning distribution', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/EITHSlot.json', 'utf8'));
  const { weightedPaytable } = require('./egt-local-engine.cjs');
  const distribution = weightedPaytable(profile, 5), shares = new Map();
  distribution.groups.forEach((group, groupIndex) => group.values.forEach((value, valueIndex) => {
    shares.set(value.symbol, (shares.get(value.symbol) || 0) + distribution.weights[groupIndex] * group.valueWeights[valueIndex]);
  }));
  assert.deepEqual([...shares.keys()].sort((left, right) => left - right), [0,1,2,3,4,5,6,7]);
  assert.ok(Math.max(...shares.values()) < 0.4, `ways symbol domination: ${JSON.stringify(Object.fromEntries(shares))}`);
  let seed = 0x45495448, returned = 0; const winningSymbols = new Set();
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'EITHSlot', balanceUnits: 1e12, targetRtp: 80, random });
  for (let spin = 0; spin < 20000; spin += 1) {
    const outcome = engine.syntheticOutcome(10000, { factor: 5, lines: 81 }); returned += outcome.totalWin;
    for (const entry of (outcome.spins?.[0] || outcome.spin).entries) winningSymbols.add(entry.symbol);
  }
  assert.equal(winningSymbols.size, 8);
  assert.ok(Math.abs(returned / 2000000 - 80) < 3, `EITH RTP was ${returned / 2000000}`);
});

test('local engine produces diverse non-repeating reel grids', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  let seed = 0x91e10da5;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 1e9, targetRtp: 96, random });
  const keys = [], wins = new Set();
  for (let spin = 0; spin < 100; spin += 1) {
    const outcome = engine.outcome(100, { factor: 20 });
    keys.push(JSON.stringify(outcome.spin?.reels || outcome.game?.result?.spins?.[0]?.reels));
    if (outcome.totalWin) wins.add(`${outcome.spin?.entries?.[0]?.symbol}:${outcome.totalWin}`);
  }
  assert.ok(new Set(keys).size >= 95, `expected at least 95 distinct grids, got ${new Set(keys).size}`);
  for (let index = 1; index < keys.length; index += 1) assert.notEqual(keys[index], keys[index - 1]);
  assert.ok(wins.size > 1, 'winning outcomes should not use one identical symbol/payout pattern');
});

test('ordinary spins do not inject feature symbols that trigger false anticipation', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/BESlot.json', 'utf8'));
  let seed = 7;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'BESlot', balanceUnits: 1e9, targetRtp: 96, random });
  for (let spin = 0; spin < 100; spin += 1) {
    const outcome = engine.syntheticOutcome(100, { factor: 20 });
    assert.ok(outcome.spin.reels.flat().every(symbol => symbol <= 7));
  }
});

test('payline losses never render an unregistered three-or-more symbol win', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TWSHSlot.json', 'utf8'));
  const sample = profile.eventFamilies?.bet?.find(item=>item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels || profile.settings.reels;
  const activePaylines = paylinesFor(profile, sample);
  let seed = 0x51a7e;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'TWSHSlot', balanceUnits: 1e9, targetRtp: 96, random });
  for (let spin = 0; spin < 2000; spin += 1) {
    const outcome = engine.syntheticOutcome(100, { factor: 20 }, false);
    for (const rows of activePaylines) {
      const firstThree = outcome.spin.reels.slice(0, 3).map((reel, index) => reel[rows[index] + 1]);
      assert.ok(!firstThree.every(symbol => symbol === firstThree[0]), `unregistered payline on spin ${spin}`);
    }
  }
});

test('registered payline wins align their declared cells and vary the winning line', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TWSHSlot.json', 'utf8'));
  const { wild } = require('./egt-family-engines.cjs').symbolRoles(profile);
  let seed = 0x20bad;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'TWSHSlot', balanceUnits: 1e9, targetRtp: 96, random });
  const lines = new Set();
  for (let spin = 0; spin < 200; spin += 1) {
    const outcome = engine.syntheticOutcome(100, { factor: 20 }, true), entry = outcome.spin.entries[0];
    lines.add(entry.line);
    for (let index = 0; index < entry.cells.length; index += 2) {
      const reel = entry.cells[index], visibleRow = entry.cells[index + 1];
      assert.ok([entry.symbol, wild].includes(outcome.spin.reels[reel][visibleRow + 1]));
    }
  }
  assert.ok(lines.size >= 15, `expected broad line variation, got ${lines.size}`);
});

test('multi-line wins do not reuse a fixed secondary-line template', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  let seed = 0x4c494e45;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e9, targetRtp: 80, random });
  const patterns = new Map();
  for (let spin = 0; spin < 500; spin += 1) {
    const entries = engine.syntheticOutcome(10000, { factor: 50 }, true).spin.entries;
    if (entries.length < 2) continue;
    const pattern = entries.map(entry => entry.line).sort((left, right) => left - right).join(',');
    patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
  }
  const maximumRepeat = Math.max(...patterns.values());
  assert.ok(patterns.size >= 100, `expected broad line-set variation, got ${patterns.size}`);
  assert.ok(maximumRepeat < 12, `one line template repeated ${maximumRepeat} times`);
});

test('RORGKL reservoir uses untouched reel windows and shuffles its RTP-controlled batch', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  let seed = 0x5245454c;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const reservoir = new RorgklReelReservoir({ profile, random });
  let total = 0, estimatedTotal = 0, untouched = 0, triggers = 0; const grids = new Set(), untouchedPositions = [];
  for (let spin = 0; spin < 10000; spin += 1) {
    const outcome = reservoir.outcome({ stake: 10000, bet: { factor: 50, lines: 50 }, targetRtp: 80 });
    total += outcome.totalWin; estimatedTotal += outcome.candidate.estimatedMultiple * 10000; grids.add(JSON.stringify(outcome.spin.reels));
    triggers += outcome.candidate.triggersFreeSpins ? 1 : 0;
    assert.equal(outcome.spin.entries.some(entry => entry.mode === 'line' && entry.occurs < 2), false, 'one-symbol line award');
    assert.equal(outcome.spin.reels.some(reel => reel.slice(1, 4).includes(13)), false, 'unsupported jackpot symbol rendered blank');
    if (!outcome.candidate.controlled) { untouched += 1; untouchedPositions.push(spin); }
    outcome.spin.reels.forEach((reel, reelIndex) => {
      const strip = profile.settings.fakeReels[reelIndex];
      assert.ok(strip.some((_, stop) => reel.every((symbol, offset) => symbol === strip[(stop + offset - 2 + strip.length) % strip.length])), `reel ${reelIndex} is not a strip window`);
    });
    for (const entry of outcome.spin.entries.filter(entry => entry.mode === 'line')) for (let index = 0; index < entry.cells.length; index += 2) {
      const reel = entry.cells[index], row = entry.cells[index + 1], symbol = outcome.spin.reels[reel][row + 1];
      assert.ok(symbol === entry.symbol || symbol === 11, 'declared win must already exist on the stopped reels');
    }
  }
  assert.equal(untouched, 500);
  assert.ok(grids.size > 9950, `expected almost all grids to differ, got ${grids.size}`);
  assert.ok(untouchedPositions.some(position => position < 1000) && untouchedPositions.some(position => position > 9000), 'untouched outcomes must be interspersed');
  assert.ok(triggers >= 22 && triggers <= 40, `trigger frequency drifted to ${triggers}`);
  assert.ok(total >= 0, 'base settlements remain monetary');
  assert.ok(Math.abs(estimatedTotal / 1000000 - 80) < 0.1, `batch RTP including reserved feature value was ${estimatedTotal / 1000000}`);
  assert.ok(Math.abs(reservoir.lastStats.estimatedRtp - 80) < 0.1);
});

test('81-ways wins include a terminal no-win cascade that clears staged symbols', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/EITHSlot.json', 'utf8'));
  let seed = 0x81ca5cade;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey: 'EITHSlot', balanceUnits: 1e9, targetRtp: 100, random });
  const outcome = engine.syntheticOutcome(100, { factor: 5 }, true);
  assert.equal(outcome.spins.length, 2);
  assert.equal(outcome.spins[0].entries[0].mode, 'ways');
  assert.equal(outcome.spins[0].entries[0].ways, 1);
  assert.deepEqual(outcome.spins[1].entries, []);
  assert.equal(outcome.spins[1].totalWin, 0);
  let common = new Set(outcome.spins[1].reels[0].slice(1, 4));
  for (let reel = 1; reel < 3; reel += 1) common = new Set(outcome.spins[1].reels[reel].slice(1, 4).filter(symbol => common.has(symbol)));
  assert.equal(common.size, 0, 'terminal cascade must not stage another unregistered ways win');
  engine.outcome = () => outcome;
  const response = engine.bet({ id: 1, bet: { level: 20, factor: 5, denomination: 1, lines: 81 } });
  assert.equal(response.game.result.spins.length, 2);
  assert.equal(response.game.result.totalWin, outcome.totalWin);
});

test('non-cascade ways titles keep a single authored spin frame', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/BESlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'BESlot', balanceUnits: 1e9, targetRtp: 100, random: () => 0.25 });
  const outcome = engine.syntheticOutcome(100, { factor: 20 }, true);
  assert.equal(outcome.spin.entries[0].mode, 'ways');
  assert.equal(outcome.spins, undefined);
});

test('a collected win is cleared from the following spin response', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 1e9, targetRtp: 0, random: () => 0.5 });
  engine.pendingWin = 500;
  const response = engine.bet({ id: 1, bet: { level: 5, factor: 20, denomination: 1 } });
  assert.equal(response.game.result.lastWin, '0');
  assert.equal(response.game.result.lastWinAmount, '0');
  assert.deepEqual(response.game.result.spins[0].entries, []);
});

test('shared reels bundle receives a short normal stop schedule', () => {
  const source = 'this.gameInitialReelRotationTime=340,this.gameInitialReelRotationTimeInQuickSpin=250,this.gameBetweenReelsDelay=320,this.gameBetweenReelsDelayInQuickSpin=150,this.gameAnticipationReelsDelay=2050';
  const patched = patchReelsTimingBundle(source);
  assert.equal(patched.replacements, 5);
  assert.match(patched.source, /gameInitialReelRotationTime=180/);
  assert.match(patched.source, /gameBetweenReelsDelay=110/);
  assert.match(patched.source, /gameAnticipationReelsDelay=900/);
});

test('local EGT sessions restore unsettled state and emit captured jackpot pushes', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/TSHSASlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'TSHSASlot', balanceUnits: 5000000, targetRtp: 100, random: () => 0 });
  const bet = JSON.parse(JSON.parse(engine.messages(sockJsEncode({ event: 'bet', bet: { level: 5, factor: 20, denomination: 1 }, id: 1 }))[0].slice(1))[0]);
  const restored = JSON.parse(JSON.parse(engine.messages(sockJsEncode({ event: 'loadGame', id: 2 }))[0].slice(1))[0]);
  assert.equal(restored.sessionKey, bet.sessionKey);
  assert.equal(restored.state, bet.state);
  assert.equal(restored.game.state.matchId, bet.game.state.matchId);
  const pushed = engine.pushMessages('jpstats').map(message => JSON.parse(JSON.parse(message.slice(1))[0]));
  assert.equal(pushed[0]?.event, 'jpstats');
  assert.ok(pushed[0]?.jackpotStats?.[0]?.levelStats?.length);
  assert.match(launcher, /egtLocalSessions/);
  assert.match(launcher, /engine\.pushMessages\('jpstats'\)/);
});

test('synthetic free-spin outcomes stay disabled without a title-specific protocol', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/BORSlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'BORSlot', balanceUnits: 1e9, targetRtp: 100, random: () => 0 });
  const bet = { level: 10, factor: 10, denomination: 1, lines: 10 };
  for (let spin = 0; spin < 100; spin += 1) {
    const response = engine.bet({ id: spin + 1, bet });
    assert.notEqual(response.state, 'freespin');
    assert.equal(engine.activeFeature?.type === 'FREESPIN', false);
  }
});

test('synthetic hold-and-spin outcomes stay disabled across title profiles', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e9, targetRtp: 100, random: () => 0 });
  const bet = { level: 20, factor: 50, denomination: 1, lines: 50 };
  for (let spin = 0; spin < 100; spin += 1) {
    const response = engine.bet({ id: spin + 1, bet });
    assert.notEqual(response.state, 'holdspin');
    assert.notEqual(engine.activeFeature?.type, 'HOLDSPIN');
    while (engine.activeFeature) engine.bet({ id: 1000 + spin, bet });
  }
});

test('RORGKL scatter fillers never create an unregistered three-scatter feature', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  assert.equal(Math.max(...Object.keys(profile.settings.paytable).map(Number)), 12);
  assert.equal(require('./egt-local-engine.cjs').ordinarySymbols(profile).includes(12), false);
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e9, targetRtp: 48 });
  const bet = { level: 20, factor: 50, denomination: 1, lines: 50 };
  for (let spin = 0; spin < 1000; spin += 1) {
    const response = engine.bet({ id: spin + 1, bet });
    const symbols = response.game.result.spins.flatMap(frame => frame.reels.flatMap(reel => reel.slice(1, 4)));
    const scatterCount = symbols.filter(symbol => symbol === 12).length;
    if (response.state === 'freespin') assert.ok(scatterCount >= 3);
    else { assert.ok(scatterCount <= 2); assert.equal(response.game.result.spins.some(frame => frame.bonuses?.some(bonus => bonus.type === 'FREESPIN')), false); }
    while (engine.activeFeature) engine.bet({ id: 10000 + spin, bet });
  }
});

test('family symbol roles drive wild substitution without leaking special fillers', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json', 'utf8'));
  const { symbolRoles } = require('./egt-family-engines.cjs');
  assert.deepEqual(symbolRoles(profile), { scatter: 12, wild: 11, coins: [13] });
  const pool = require('./egt-local-engine.cjs').ordinarySymbols(profile);
  assert.equal(pool.includes(11), false); assert.equal(pool.includes(12), false); assert.equal(pool.includes(13), false);
  const engine = new EgtLocalSession({ profile, gameKey: 'RORGKLSlot', balanceUnits: 1e9, targetRtp: 100, random: () => 0 });
  const response = engine.syntheticOutcome(5000, { factor: 5 }, true);
  assert.equal(response.totalWin > 0, true); assert.equal(response.spin.entries[0].multiplier, 2);
  assert.equal(response.spin.reels.flat().includes(11), true);
});

test('Bell Link scatter variants follow in-game info reel eligibility and never leak as filler', () => {
  const { scatterEligibleReels, scatterSymbols } = require('./egt-family-engines.cjs');
  for (const gameKey of ['BCBLSlot', 'FZWBLSlot']) {
    const profile = JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`, 'utf8'));
    profile.gameKey = gameKey;
    assert.deepEqual(scatterSymbols(profile, gameKey), [9, 10]);
    assert.deepEqual(scatterEligibleReels(profile, 9), [0, 2, 4]);
    assert.deepEqual(scatterEligibleReels(profile, 10), [0, 1, 2, 3, 4]);
    const pool = require('./egt-local-engine.cjs').ordinarySymbols(profile);
    assert.equal(pool.includes(9), false); assert.equal(pool.includes(10), false);
    const engine = new EgtLocalSession({ profile, gameKey, balanceUnits: 1e9, targetRtp: 80, random: () => 0.5 });
    const bet = { level: 0.4, factor: 50, denomination: 1, lines: 40 };
    for (let spin = 0; spin < 100; spin += 1) {
      const response = engine.bet({ id: spin + 1, bet });
      const visible = response.game.result.spins.flatMap(frame => frame.reels.map(reel => reel.slice(1, 4)));
      for (const symbol of [9, 10]) for (let reel = 0; reel < visible.length; reel += 1) {
        if (visible[reel].includes(symbol)) assert.ok(scatterEligibleReels(profile, symbol).includes(reel));
      }
      for (const entry of response.game.result.spins.flatMap(frame => frame.entries || []).filter(entry => entry.mode === 'scatter')) {
        assert.ok([9, 10].includes(entry.symbol)); assert.equal(Number(entry.winAmount), Number(entry.win));
      }
    }
  }
});

test('BCBL uses all forty authoritative four-row paylines and completes win collection', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json', 'utf8'));
  const sample = profile.eventFamilies.bet.find(item=>item.game?.result?.spins?.[0]?.reels).game.result.spins[0].reels;
  assert.equal(PAYLINES_40_4ROW.length, 40);
  assert.equal(new Set(PAYLINES_40_4ROW.map(JSON.stringify)).size, 40);
  assert.deepEqual(paylinesFor(profile, sample), PAYLINES_40_4ROW);
  let seed=0x4243424c;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/0x100000000};
  const engine=new EgtLocalSession({profile,gameKey:'BCBLSlot',balanceUnits:1e9,targetRtp:80,random});
  const bet={level:2,factor:50,denomination:1,lines:40,gameMode:'NORMAL_MODE'},seen=new Set();
  for(let spin=0;spin<1000;spin++){
    const outcome=engine.syntheticOutcome(100,bet,true),entry=outcome.spin.entries[0];seen.add(entry.line);
    const rows=PAYLINES_40_4ROW[entry.line];
    for(let cell=0;cell<entry.cells.length;cell+=2)assert.equal(entry.cells[cell+1],rows[entry.cells[cell]]);
  }
  assert.equal(seen.size,40);
  let won;for(let attempt=0;attempt<100&&!won?.game?.result?.spins?.[0]?.entries?.length;attempt++)won=engine.bet({id:attempt+1,bet});assert.equal(won.state,'win');
  const collected=engine.collect({id:2,bet});assert.equal(collected.state,'idle');
});

test('BLBL uses bundled symbol roles but emits atomic wins without unsupported expanding wilds', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BLBLSlot.json','utf8'));
  const {symbolRoles,scatterSymbols,scatterEligibleReels}=require('./egt-family-engines.cjs');
  assert.deepEqual(symbolRoles(profile),{scatter:10,wild:8,coins:[]});
  assert.deepEqual(scatterSymbols(profile,'BLBLSlot'),[9,10]);
  assert.deepEqual(scatterEligibleReels(profile,9),[0,2,4]);
  assert.deepEqual(scatterEligibleReels(profile,10),[0,1,2,3,4]);
  let seed=0x424c424c;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/0x100000000};
  const engine=new EgtLocalSession({profile,gameKey:'BLBLSlot',balanceUnits:1e9,targetRtp:80,random});
  for(let spin=0;spin<1000;spin++){
    const outcome=engine.syntheticOutcome(100,{factor:50,lines:40},true);
    assert.equal(outcome.spin.entries.length,1);
    assert.equal(outcome.spin.entries[0].multiplier,1);
    assert.equal(outcome.spin.reels.flat().includes(8),false);
    assert.equal(outcome.spin.reels.flat().includes(9),false);
  }
});

test('Bell Link scatter inference never promotes premium line symbol seven', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BDBLSlot.json','utf8'));
  const {symbolRoles,scatterSymbols}=require('./egt-family-engines.cjs');
  assert.deepEqual(scatterSymbols(profile,'BDBLSlot'),[9]);
  assert.deepEqual(symbolRoles(profile),{scatter:9,wild:8,coins:[101,102,103,105,108,110]});
});

test('five-line Bell Link does not invent a wild when its rules declare none', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/FDHBLSlot.json','utf8'));
  const {symbolRoles,scatterSymbols}=require('./egt-family-engines.cjs');
  assert.deepEqual(scatterSymbols(profile,'FDHBLSlot'),[7]);
  assert.equal(symbolRoles(profile).scatter,7);assert.equal(symbolRoles(profile).wild,null);
});

test('client-authored metadata overrides heuristic Bell Link symbol roles and paylines', () => {
  const { clientMathMetadata } = require('./egt-client-metadata.cjs');
  const { symbolRoles, scatterSymbols } = require('./egt-family-engines.cjs');
  const cases = {
    BCBLSlot: { wild: 8, scatters: [9, 10], lines: 40 },
    BDBLSlot: { wild: 8, scatters: [9], lines: 40 },
    FDHBLSlot: { wild: null, scatters: [7], lines: 5 },
    SACBLSlot: { wild: 10, scatters: [], lines: 5 },
  };
  for (const [gameKey, expected] of Object.entries(cases)) {
    const profile = JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`, 'utf8'));
    const metadata = clientMathMetadata(gameKey);
    const sample = profile.eventFamilies?.bet?.find(item => item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels || profile.settings.reels;
    assert.equal(metadata.sourceSha256.length, 64);
    assert.equal(metadata.paylines.length, expected.lines);
    assert.deepEqual(scatterSymbols(profile, gameKey), expected.scatters);
    assert.equal(symbolRoles(profile).wild, expected.wild);
    assert.deepEqual(paylinesFor(profile, sample), metadata.paylines);
  }
});

test('unanimous shared client line catalogs fill inherited Bell Link layouts without overriding symbol inference', () => {
  const { clientMathMetadata } = require('./egt-client-metadata.cjs');
  const { symbolRoles } = require('./egt-family-engines.cjs');
  for (const [gameKey, lineCount] of [['FSHSlot',40],['TSHSlot',20]]) {
    const profile=JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`,'utf8'));
    const metadata=clientMathMetadata(gameKey),sample=profile.eventFamilies?.bet?.find(item=>item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels||profile.settings.reels;
    assert.equal(metadata.symbolsAuthoritative,false);assert.equal(metadata.paylines.length,lineCount);
    assert.match(metadata.paylinesSource,/^shared-client-catalog:/);assert.equal(metadata.paylinesSourceSha256.length,64);
    assert.deepEqual(paylinesFor(profile,sample),metadata.paylines);
    assert.ok(symbolRoles(profile).scatter !== undefined);
  }
});

test('BLBL RTP selection cannot collapse into an every-spin win rate', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BLBLSlot.json','utf8'));
  let seed=0x52545038;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/0x100000000};
  const engine=new EgtLocalSession({profile,gameKey:'BLBLSlot',balanceUnits:1e9,targetRtp:80,random});
  let wins=0;
  for(let spin=0;spin<10000;spin++)wins+=engine.syntheticOutcome(100,{factor:50,lines:40}).totalWin>0;
  assert.ok(wins>2800&&wins<3200,`expected about 30% wins, received ${wins/100}%`);
});

test('fixed reel RNG selects one stop and exposes adjacent circular symbols', () => {
  const strips=[[1,2,3,4],[5,6,7,8]],picks=[0,3];
  const result=spinReelStrips(strips,3,max=>{const value=picks.shift();assert.ok(value<max);return value});
  assert.deepEqual(result.stops,[0,3]);
  assert.deepEqual(result.reels,[[4,1,2,3,4],[7,8,5,6,7]]);
});

test('fixed evaluator chooses the highest legal wild substitution', () => {
  const { bestLineMatch, evaluatePaylines } = require('./egt-fixed-reel-engine.cjs');
  const paytable={1:{coef:[5,20,50]},2:{coef:[10,15,25]},8:{coef:[2,3,100]}};
  assert.deepEqual(bestLineMatch([8,8,1,1,2],paytable,8,[]),{symbol:1,occurs:4,coefficient:20});
  assert.deepEqual(bestLineMatch([8,8,8,8,8],paytable,8,[]),{symbol:8,occurs:5,coefficient:100});
  const reels=[[0,8,0],[0,8,0],[0,1,0],[0,1,0],[0,2,0]];
  const entries=evaluatePaylines({reels,paylines:[[0,0,0,0,0]],paytable,wild:8,scatters:[],stake:100,factor:1});
  assert.equal(entries[0].symbol,1);assert.equal(entries[0].occurs,4);assert.equal(entries[0].win,2000);
});

test('fixed ways evaluator counts only complete left-to-right virtual paths', () => {
  const { evaluateWays } = require('./egt-fixed-reel-engine.cjs');
  const reels=[
    [9,1,1,9],
    [9,1,2,9],
    [9,1,1,9],
  ];
  const entries=evaluateWays({reels,paytable:{1:{coef:[5]},2:{coef:[50]}},stake:100,factor:5,rows:2});
  assert.equal(entries.length,1);
  assert.deepEqual({...entries[0],cells:undefined},{mode:'ways',symbol:1,winAmount:'400',cells:undefined,coef:5,multiplier:1,occurs:3,win:400,ways:4});
  assert.deepEqual(entries[0].cells,[0,0,0,1,1,0,2,0,2,1]);
});

test('family routing distinguishes static ways from declared toppling games', () => {
  const { classifyFamily }=require('./egt-family-engines.cjs');
  const load=gameKey=>JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`,'utf8'));
  assert.equal(classifyFamily(load('BESlot')),'ways-coin');
  assert.equal(classifyFamily(load('SUCSlot')),'ways-coin');
  assert.equal(classifyFamily(load('TFWSlot')),'ways-coin');
  assert.equal(classifyFamily(load('EITHSlot')),'ways-cascade');
  assert.equal(classifyFamily(load('FXSFSSlot')),'ways-cascade');
});

test('shared SG jackpot service does not classify ordinary Super Hot as Bell Link', () => {
  const {classifyFamily}=require('./egt-family-engines.cjs'),load=gameKey=>JSON.parse(fs.readFileSync(`data/egt-profiles/${gameKey}.json`,'utf8'));
  assert.equal(classifyFamily(load('FSHSlot')),'classic-lines-coin');
  assert.equal(classifyFamily(load('TSHSlot')),'classic-lines-coin');
  assert.equal(classifyFamily(load('FSHBLSlot')),'bell-link');
  assert.equal(classifyFamily(load('TSHBLSlot')),'bell-link');
});

test('exact ways RTP expands one random row path by the configured ways count', () => {
  const { exactWaysRtp } = require('./egt-exact-math.cjs');
  const math=exactWaysRtp({strips:[[1,2],[1,2],[1,2]],paytable:{1:{coef:[1]},2:{coef:[1]}},factor:1,rows:2});
  assert.equal(math.virtualWays,8);
  assert.equal(math.expectedPerWay,0.25);
  assert.equal(math.rtp,2);
});

test('dynamic exact line math matches exhaustive wild-substitution enumeration', () => {
  const {sequenceAward,exactLineRtp}=require('./egt-exact-math.cjs');
  const strips=[[8,1,2],[8,1,2],[8,1,2]],paytable={1:{coef:[2,5]},2:{coef:[3,4]},8:{coef:[1,7]}};
  let exhaustive=0;
  for(const a of strips[0])for(const b of strips[1])for(const c of strips[2])exhaustive+=sequenceAward([a,b,c],{paytable,wild:8,scatters:[],factor:1})/27;
  const exact=exactLineRtp({strips,paytable,paylines:[[0,0,0]],wild:8,scatters:[],factor:1});
  assert.ok(Math.abs(exact.expectedPerLine-exhaustive)<1e-12,`${exact.expectedPerLine} != ${exhaustive}`);
});

test('maximum-exposure report is a deterministic bound rather than a simulation observation', () => {
  const config={evaluation:'ways',rows:2,strips:[[1,2],[1,2],[1,2]],paylines:[],paytable:{1:{coef:[5]},2:{coef:[10]},9:{coef:[2,20]}},scatters:[9],scatterEligibleReels:{9:[0,1,2]}};
  const exposure=theoreticalBaseMaximumWinMultiple(config,5);
  assert.equal(exposure.topologyCount,8);
  assert.equal(exposure.lineOrWaysUpperBound,16);
  assert.equal(exposure.scatterUpperBound,4);
  assert.equal(exposure.totalUpperBound,20);
});

test('toppling removes only winning cells, drops survivors and refills from authored strips', () => {
  const {toppleReels}=require('./egt-fixed-reel-engine.cjs');
  const nextAbove=[3,3,3],strips=[[7,8,9,4],[7,8,9,5],[7,8,9,6]];
  const reels=[[0,1,2,3,0],[0,1,5,6,0],[0,1,8,9,0]];
  const result=toppleReels({reels,winningCells:[0,0,1,0,2,0],strips,nextAbove});
  assert.deepEqual(result.map(reel=>reel.slice(1,-1)),[[4,2,3],[5,5,6],[6,8,9]]);
  assert.deepEqual(nextAbove,[2,2,2]);
});

test('fixed cascade engine pays each toppling state and includes a terminal grid', () => {
  const {fixedCascadeOutcome}=require('./egt-fixed-reel-engine.cjs');
  const profile={settings:{reels:Array.from({length:3},()=>Array(4)),paytable:{1:{coef:[5]}}}};
  const outcome=fixedCascadeOutcome({profile,strips:[[1,2,3,4],[1,2,4,3],[1,2,5,3]],roles:{wild:null},scatters:[],eligibleReels:()=>[],stake:100,factor:5,randomInt:()=>0,maxCascades:4});
  assert.equal(outcome.totalWin,100);
  assert.equal(outcome.spins.length,2);
  assert.equal(outcome.spins[0].entries[0].ways,1);
  assert.equal(outcome.spins[1].entries.length,0);
  assert.deepEqual(outcome.spins[1].reels.map(reel=>reel.slice(1,-1)),[[3,2],[4,2],[5,2]]);
});

test('BCBL fixed-strip outcome evaluates only symbols actually visible on authored paylines', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const {symbolRoles,scatterSymbols,scatterEligibleReels}=require('./egt-family-engines.cjs');
  let state=0x46495844;const randomInt=max=>{state=(1664525*state+1013904223)>>>0;return state%max};
  for(let spin=0;spin<1000;spin++){
    const result=fixedReelOutcome({profile,paylines:PAYLINES_40_4ROW,roles:symbolRoles(profile),scatters:scatterSymbols(profile,'BCBLSlot'),eligibleReels:symbol=>scatterEligibleReels(profile,symbol),stake:100,factor:50,randomInt});
    assert.equal(result.spin.reels.length,5);assert.ok(result.stops.every((stop,reel)=>stop>=0&&stop<profile.settings.fakeReels[reel].length));
    assert.equal(result.totalWin,result.spin.entries.reduce((sum,entry)=>sum+entry.win,0));
    for(const entry of result.spin.entries.filter(entry=>entry.mode==='line'))for(let i=0;i<entry.cells.length;i+=2){
      const reel=entry.cells[i],row=entry.cells[i+1],shown=result.spin.reels[reel][row+1];
      assert.ok(shown===entry.symbol||shown===symbolRoles(profile).wild);
    }
  }
});

test('fixed math configurations are immutable and content-addressed', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const first=buildMathConfiguration(profile,PAYLINES_40_4ROW,48),second=buildMathConfiguration(profile,PAYLINES_40_4ROW,48);
  assert.equal(first.versionHash,second.versionHash);assert.match(first.versionHash,/^[a-f0-9]{64}$/);
  assert.equal(first.targetRtp,48);assert.equal(first.family,'bell-link');assert.equal(first.paylines.length,40);
  assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first.strips[0]),true);
  assert.throws(()=>first.strips[0].push(999),TypeError);
});

test('complete configurations content-address feature and jackpot mathematics', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const config=buildMathConfiguration(profile,PAYLINES_40_4ROW,96,{
    source:'original-mathematics',featureMathComplete:true,runtimeProtocolReady:true,
    featureModels:[{type:'hold-and-spin',triggerCount:6}],jackpotModel:{contributionRtp:0.01},
  });
  assert.equal(config.baseGameOnly,false);assert.equal(config.featureMathComplete,true);assert.equal(config.runtimeProtocolReady,true);
  assert.equal(config.featureModels[0].triggerCount,6);assert.equal(config.jackpotModel.contributionRtp,0.01);
  assert.equal(Object.isFrozen(config.featureModels[0]),true);
  const changed=buildMathConfiguration(profile,PAYLINES_40_4ROW,96,{source:'original-mathematics',featureMathComplete:true,featureModels:[{type:'hold-and-spin',triggerCount:7}]});
  assert.notEqual(config.versionHash,changed.versionHash);
});

test('exact reel math derives BCBL base RTP without using simulated outcomes', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const config=buildMathConfiguration(profile,PAYLINES_40_4ROW,48),math=exactBaseGameMath(config,50);
  assert.ok(math.rtp>0.45&&math.rtp<0.51,`unexpected exact RTP ${math.rtp}`);
  assert.ok(math.lineRtp>0);assert.ok(math.scatterRtp>=0);
});

test('visible scatter math enumerates circular windows including stacked symbols', () => {
  const distribution=visibleCountDistribution([9,9,1,2],9,3);
  assert.equal([...distribution.values()].reduce((a,b)=>a+b,0),1);
  assert.deepEqual(Object.fromEntries(distribution),{'1':0.5,'2':0.5});
});

test('offline reel optimizer preserves special stops while moving exact RTP toward its target', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const base=buildMathConfiguration(profile,PAYLINES_40_4ROW,55),before=exactBaseGameMath(base,50).rtp;
  const result=optimizeReelConfiguration({profile,paylines:PAYLINES_40_4ROW,targetRtp:55,factor:50,seed:123,maxIterations:40,tolerance:0.001});
  assert.ok(Math.abs(result.math.rtp-.55)<Math.abs(before-.55));
  const mutable=new Set(tunableSymbols(profile,base.roles,base.scatters));
  for(let reel=0;reel<base.strips.length;reel++)for(let stop=0;stop<base.strips[reel].length;stop++)if(!mutable.has(base.strips[reel][stop]))assert.equal(result.config.strips[reel][stop],base.strips[reel][stop]);
});

test('BCBL websocket rejects base-only artifacts as selectable total-RTP configurations', () => {
  for(const target of [48,80,90,96]) assert.equal(selectMathConfiguration('BCBLSlot',target),null);
  assert.equal(selectMathConfiguration('BCBLSlot',70),null);
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const engine=new EgtLocalSession({profile,gameKey:'BCBLSlot',balanceUnits:1e9,targetRtp:80,enableFixedMath:true});
  assert.equal(engine.mathConfig,null);
  const outcome=engine.outcome(100,{factor:50,lines:40});
  assert.equal(outcome.spin.reels.length,5);assert.equal(outcome.totalWin,outcome.spin.entries.reduce((sum,entry)=>sum+entry.win,0));
});

test('math registry requires both exact convergence and complete feature mathematics', () => {
  for(const gameKey of ['BCBLSlot','BDBLSlot'])for(const target of [48,80,90,96])assert.equal(selectMathConfiguration(gameKey,target),null);
  assert.equal(selectMathConfiguration('FDHBLSlot',96),null);
  assert.equal(selectMathConfiguration('FDHBLSlot',95).runtimeProtocolReady,true);
});

test('configuration builder cannot publish incomplete feature math as total-game RTP', () => {
  const source=fs.readFileSync('build-egt-math-config.cjs','utf8');
  assert.match(source,/!baseOnly && !familySpec\.featureMathComplete/);
  assert.match(source,/Use --base-only only for offline reel work/);
  assert.match(source,/artifactType: baseOnly \? 'base-game-lab' : 'complete-game'/);
  assert.match(source,/totalRtp: null/);
});

test('free-spin math composes trigger rate, retriggers and multiplier exactly', () => {
  const feature = exactFreeSpinMath({
    triggerDistribution: { 3: 0.01 }, initialSpins: { 3: 10 },
    freeSpinRtpPerSpin: 0.05, retriggerDistribution: { 3: 0.02 },
    retriggerSpins: { 3: 10 }, multiplier: 3,
  });
  assert.ok(Math.abs(feature.expectedFreeSpinsPerPaidSpin - 0.125) < 1e-12);
  assert.ok(Math.abs(feature.rtp - 0.01875) < 1e-12);
  assert.equal(feature.triggerHitFrequency, 100);
});

test('free-spin math rejects a non-terminating retrigger process', () => {
  assert.throws(() => exactFreeSpinMath({ triggerDistribution: { 3: 0.01 }, initialSpins: 10, freeSpinRtpPerSpin: 0.1, retriggerDistribution: { 3: 0.1 }, retriggerSpins: 10 }), /does not terminate/);
});

test('hold-and-spin math uses an exact finite-state respin calculation', () => {
  const noLandings = exactHoldSpinFromState({ cells: 15, occupied: 6, landingProbability: 0, meanCoinValue: 2 });
  assert.deepEqual(noLandings, { payout: 0, respins: 3 });
  const alwaysLand = exactHoldSpinFromState({ cells: 8, occupied: 6, landingProbability: 1, meanCoinValue: 2, fullGridAward: 10 });
  assert.deepEqual(alwaysLand, { payout: 14, respins: 1 });
  const feature = exactHoldSpinMath({ triggerDistribution: { 6: 0.005 }, cells: 15, initialOccupied: { 6: 6 }, landingProbability: 0, meanCoinValue: 2 });
  assert.equal(feature.triggerHitFrequency, 200); assert.equal(feature.rtp, 0.06); assert.equal(feature.expectedRespinsPerTrigger, 3);
  const authoredInitial=exactHoldSpinMath({triggerDistribution:{6:.005},cells:15,initialOccupied:{6:6},initialCoinValue:{6:21},landingProbability:0,meanCoinValue:2});
  assert.equal(authoredInitial.rtp,.105);
});

test('Bell Link family math derives trigger values and full-grid contribution exactly', () => {
  const strips=[[1,9,2],[1,9,2]],values={9:4},statistics=bellTriggerStatistics({strips,coinValueBySymbol:values,rows:1,triggerCount:2});
  assert.equal(statistics.triggerDistribution[2],1/9);
  assert.equal(statistics.initialCoinValue[2],8);
  const feature=buildBellFeatureMath({statistics,cells:2,coinValueBySymbol:values,landingProbability:.1,jackpotRtp:.02});
  assert.ok(Math.abs(feature.combined.rtp-feature.coinMath.rtp-.02)<1e-12);
  assert.ok(feature.fullGridAward>0);
  assert.equal(Object.values(coinValueSchedule([101,102,103])).reduce((a,b)=>a+b,0)/3,50);
  let seed=7;const randomInt=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max};
  const model={triggerDistribution:statistics.triggerDistribution,cells:2,coinSymbols:[9],coinValueBySymbol:values,initialCoinValue:statistics.initialCoinValue,lives:3,resetLives:3,landingProbability:.1,meanCoinValue:4,fullGridAward:feature.fullGridAward};
  const simulation=simulateHoldFeatureConditional(model,20000,1,randomInt);
  assert.ok(Math.abs(simulation.estimatedPaidSpinRtp-feature.combined.rtp)<=simulation.standardError*6+1e-12);
});

test('FDHBL production math executes a full persisted hold-spin protocol through its live gate', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/FDHBLSlot.json','utf8'));
  const artifact=JSON.parse(fs.readFileSync('data/egt-math-configs/FDHBLSlot.json','utf8')),config=artifact.configurations['95'].config,coins=new Set(config.roles.coins.map(Number));
  const stops=config.strips.map(strip=>{for(let stop=0;stop<strip.length;stop+=1)if(Array.from({length:config.rows},(_,row)=>strip[(stop+row)%strip.length]).some(symbol=>coins.has(Number(symbol))))return stop;throw new Error('reel has no trigger coin');});
  const randomInt=max=>stops.length?stops.shift():max-1;
  const engine=new EgtLocalSession({profile,gameKey:'FDHBLSlot',balanceUnits:100000,targetRtp:95,randomInt});engine.mathConfig=config;
  const factor=engine.betSettings.factor,bet={level:20/factor,factor,denomination:1,lines:engine.betSettings.lines};
  let response=engine.bet({id:'trigger',event:'bet',bet});
  assert.equal(response.state,'holdspin');assert.equal(response.game.state.rounds[0].type,'HOLDSPIN');assert.ok(engine.activeFeature);
  for(let index=0;engine.activeFeature&&index<10;index+=1)response=engine.bet({id:`hold-${index}`,event:'bet',bet});
  assert.equal(engine.activeFeature,null);assert.ok(['win','idle'].includes(response.state));assert.equal(response.game.state.rounds[0].remain,0);
  assert.equal(response.game.result.spins[0].type,'HOLDSPIN');
  assert.equal(response.game.result.bellLink.pos.length,response.game.result.bellLink.val.length);
  assert.deepEqual(response.game.result.restorePoints,['base']);
  assert.ok(Array.isArray(response.game.restore.base.spins[0].bonuses));
  assert.equal(response.game.restore.base.spins[0].bonuses.length,0);
  assert.ok(engine.consumeSettlement().winUnits>0);
  assert.equal(selectMathConfiguration('FDHBLSlot',95).versionHash,config.versionHash);
});

test('configuration-driven hold-and-spin persists cells, resets lives and settles exactly once', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const sample=structuredClone(profile.eventFamilies.bet.find(item=>item.game?.result?.spins?.[0]?.reels).game.result.spins[0].reels);
  for(let reel=0;reel<sample.length;reel++)for(let row=1;row<sample[reel].length-1;row++)sample[reel][row]=0;
  const coinSymbols=[101];for(let position=0;position<5;position++){const reel=Math.floor(position/4),row=position%4;sample[reel][row+1]=101;}
  const engine=new EgtLocalSession({profile,gameKey:'BCBLSlot',balanceUnits:10000,targetRtp:96,randomInt:()=>0});
  const model={type:'hold-and-spin',cells:20,triggerCount:5,coinSymbols,lives:3,resetLives:3,landingProbability:0,coinValueBySymbol:{101:1},blankSymbol:0};
  const trigger=engine.holdSpinTrigger(100,{factor:50,lines:40},{baseOutcome:{totalWin:50,spin:{entries:[],mutations:[],totalWinAmount:'50',reels:sample,type:'SPIN',bonuses:[],totalWin:50}},model});
  assert.equal(trigger.state,'holdspin');assert.equal(trigger.familyFeature.occupied.length,5);assert.equal(trigger.familyFeature.totalWin,550);
  engine.activeFeature={...structuredClone(trigger.familyFeature),type:'HOLDSPIN',game:structuredClone(trigger.game),context:{}};
  assert.equal(engine.continueFeature({id:1}).state,'holdspin');assert.equal(engine.activeFeature.remain,2);
  assert.equal(engine.continueFeature({id:2}).state,'holdspin');assert.equal(engine.activeFeature.remain,1);
  const final=engine.continueFeature({id:3});assert.equal(final.state,'win');assert.equal(engine.activeFeature,null);
  assert.equal(engine.balance,10550);assert.equal(engine.consumeSettlement().winUnits,550);assert.equal(final.game.state.rounds[0].remain,0);
  assert.equal(final.game.state.rounds[0].count,6);assert.equal(final.game.result.bellLink.pos.length,5);
  assert.deepEqual(final.game.result.restorePoints,['base']);assert.deepEqual(final.game.restore.base.spins[0].bonuses,[]);
  assert.deepEqual(final.game.result.bellLink.val,[100,100,100,100,100]);assert.equal(final.game.result.bellLink.totalWin,550);
});

test('hold-and-spin new coins reset lives and a full grid completes immediately', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const sample=structuredClone(profile.eventFamilies.bet.find(item=>item.game?.result?.spins?.[0]?.reels).game.result.spins[0].reels);
  for(let reel=0;reel<sample.length;reel++)for(let row=1;row<sample[reel].length-1;row++)sample[reel][row]=0;
  for(let position=0;position<5;position++){const reel=Math.floor(position/4),row=position%4;sample[reel][row+1]=101;}
  const engine=new EgtLocalSession({profile,gameKey:'BCBLSlot',balanceUnits:0,targetRtp:96,randomInt:()=>0});
  const model={type:'hold-and-spin',cells:6,triggerCount:5,coinSymbols:[101],lives:3,resetLives:3,landingProbability:1,coinValueBySymbol:{101:1},fullGridAward:10,fullGridMultiplier:3,blankSymbol:0};
  const trigger=engine.holdSpinTrigger(100,{factor:50,lines:40},{baseOutcome:{totalWin:0,spin:{entries:[],mutations:[],totalWinAmount:'0',reels:sample,type:'SPIN',bonuses:[],totalWin:0}},model});
  engine.activeFeature={...structuredClone(trigger.familyFeature),type:'HOLDSPIN',game:structuredClone(trigger.game),context:{}};
  const final=engine.continueFeature({id:1});assert.equal(final.state,'win');assert.equal(final.game.result.bellLink.multiplier,3);
  assert.equal(final.game.state.rounds[0].remain,0);assert.equal(final.game.state.rounds[0].count,4);
  assert.equal(final.game.result.bellLink.pos.length,6);assert.equal(final.game.result.bellLink.val.length,6);
  assert.equal(engine.balance,1600);assert.equal(engine.activeFeature,null);
});

test('configuration-driven free spins use alternate strips, retrigger and terminate cleanly', () => {
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json','utf8'));profile.settings.paytable={};
  const draws=[...Array(10).fill(0),...Array(30).fill(1)],randomInt=max=>(draws.shift()||0)%max;
  const engine=new EgtLocalSession({profile,gameKey:'RORGKLSlot',balanceUnits:0,targetRtp:96,randomInt});
  const strips=Array.from({length:5},(_,reel)=>[12,(reel+0)%5,(reel+1)%5,(reel+2)%5,(reel+3)%5]);
  const model={type:'free-spins',scatterSymbol:12,triggerCount:3,initialSpins:2,retriggerSpins:1,multiplier:3,freeSpinStrips:strips};
  engine.mathConfig={rows:3,strips,paylines:[[1,1,1,1,1]],roles:{scatter:12,wild:11,coins:[]},scatters:[12],scatterEligibleReels:{12:[0,1,2,3,4]},featureModels:[model]};
  const trigger=engine.outcome(100,{factor:50,lines:50});assert.equal(trigger.state,'freespin');assert.equal(trigger.familyFeature.remain,2);
  engine.activeFeature={...structuredClone(trigger.familyFeature),type:'FREESPIN',game:structuredClone(trigger.game),context:{}};
  const retrigger=engine.continueFeature({id:1});assert.equal(retrigger.state,'freespin');assert.equal(engine.activeFeature.remain,2);
  assert.equal(retrigger.game.state.rounds[0].remain,2);
  assert.equal(engine.continueFeature({id:2}).state,'freespin');assert.equal(engine.activeFeature.remain,1);
  const final=engine.continueFeature({id:3});assert.equal(final.state,'win');assert.equal(engine.activeFeature,null);assert.deepEqual(final.game.result.spins[0].bonuses,[]);
  assert.equal(engine.consumeSettlement().winUnits,0);
});

test('total game math reports base, feature and jackpot RTP separately', () => {
  const total = composeGameMath({ base: { rtp: 0.48 }, features: [{ rtp: 0.4 }, { rtp: 0.07 }], jackpotRtp: 0.01 });
  assert.equal(total.baseRtp, 0.48); assert.equal(total.jackpotRtp, 0.01);
  assert.ok(Math.abs(total.featureRtp - 0.47) < 1e-12); assert.ok(Math.abs(total.totalRtp - 0.96) < 1e-12);
  assert.deepEqual(total.features, [{ rtp: 0.4 }, { rtp: 0.07 }]);
});

test('family math specs derive Bell Link and free-spin trigger rates from fixed reel windows', () => {
  const bellProfile=JSON.parse(fs.readFileSync('data/egt-profiles/BCBLSlot.json','utf8'));
  const bell=deriveFamilyMathSpec(bellProfile),hold=bell.featureModels[0];
  assert.equal(hold.triggerCount,5);assert.equal(hold.cells,20);
  assert.ok(Number(hold.triggerDistribution[5])>0);
  assert.ok(Math.abs(Object.values(hold.allCoinCountDistribution).reduce((a,b)=>a+b,0)-1)<1e-12);
  assert.equal(bell.featureMathComplete,false);assert.ok(bell.gaps.includes('coin-value distribution'));

  const freeProfile=JSON.parse(fs.readFileSync('data/egt-profiles/RORGKLSlot.json','utf8'));
  const free=deriveFamilyMathSpec(freeProfile),model=free.featureModels[0];
  assert.equal(model.triggerCount,3);assert.equal(model.initialSpins,15);assert.equal(model.multiplier,3);
  assert.ok(Number(model.triggerDistribution[3])>0);assert.ok(Number(model.retriggerDistribution[3])>0);
  assert.ok(Math.abs(Object.values(model.baseScatterCountDistribution).reduce((a,b)=>a+b,0)-1)<1e-12);
});

test('offline math validator reports RTP, stop uniformity, correlation, runs and exposure', () => {
  assert.deepEqual(chiSquareUniform([10,10,10]),{statistic:0,degreesOfFreedom:2,expectedPerStop:10});
  assert.ok(serialCorrelation([0,1,0,1,0,1])<0);assert.ok(Number.isFinite(runsAboveMedian([0,1,0,1,0,1]).z));
  const profile=JSON.parse(fs.readFileSync('data/egt-profiles/FDHBLSlot.json','utf8'));
  const sample=profile.eventFamilies.bet.find(item=>item.game?.result?.spins?.[0]?.reels).game.result.spins[0].reels;
  const config=buildMathConfiguration(profile,paylinesFor(profile,sample),48);
  let state=0x56414c49;const randomInt=max=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state%max};
  const report=simulateMathConfiguration({config,profile,factor:5,spins:2000,randomInt});
  assert.equal(report.spins,2000);assert.equal(report.reels.length,5);assert.ok(report.hitFrequency>=0&&report.hitFrequency<=1);
  assert.ok(Number.isFinite(report.simulatedRtp));assert.ok(Number.isFinite(report.theoreticalRtp));assert.ok(report.maximumObservedWinMultiple>=0);
  assert.equal(report.reels.every(reel=>reel.chiSquare.degreesOfFreedom===config.strips[reel.reel].length-1),true);
  const checks=highConfidenceChecks(report);assert.equal(typeof checks.passed,'boolean');assert.ok(Array.isArray(checks.failures));
});

test('captured jackpot winner events remain available as unsolicited pushes', () => {
  const profile = JSON.parse(fs.readFileSync('data/egt-profiles/FBCSlot.json', 'utf8'));
  const engine = new EgtLocalSession({ profile, gameKey: 'FBCSlot', balanceUnits: 1e8, targetRtp: 100, random: () => 0.5 });
  const pushed = engine.pushMessages('jpwinner').map(message => JSON.parse(JSON.parse(message.slice(1))[0]));
  assert.equal(pushed[0]?.event, 'jpwinner');
  assert.ok(pushed[0]?.jackpotWinner?.amount > 0);
});

test('provider-authored spin win and credited balance remain unchanged', async () => {
  const source = launcher.slice(launcher.indexOf('function legacyDurableSimulatedBridgeScript'), launcher.indexOf('async function checkForUpdates'));
  const build = new Function('shouldIgnoreUpstreamReset', `${source};return durableSimulatedBridgeScript`) (shouldIgnoreUpstreamReset);
  const inline = build('test-token').match(/^<script>([\s\S]*)<\/script>$/)[1];
  let wallet = 4, upstream = null;
  class FakeSocket extends EventTarget {
    emit(raw, win = 0) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ balance: { balance: raw * 100, units: 100 }, win: win * 100, wins: [{ amount: win * 100 }] }) })); }
  }
  Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  class FakeCustomEvent extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } }
  const window = new EventTarget();
  Object.assign(window, { WebSocket: FakeSocket });
  const context = {
    window, document: { hidden: false }, WebSocket: FakeSocket, CustomEvent: FakeCustomEvent, MessageEvent,
    XMLHttpRequest: class { open() {} send() { this.status = 200; this.responseText = JSON.stringify({ balance: wallet, lastSequence: 0 }); } },
    fetch: async (_url, options) => {
      const update = JSON.parse(options.body);
      let rawDelta = 0;
      if (update.initialize || upstream === null) upstream = update.upstreamBalance;
      else {
        const delta = Math.round((update.upstreamBalance - upstream) * 100) / 100;
        rawDelta = delta;
        upstream = update.upstreamBalance;
        wallet = Math.round((wallet + delta) * 100) / 100;
      }
      return { ok: true, json: async () => ({ balance: wallet, rawDelta, applied: rawDelta }) };
    },
    JSON, Number, Math, Date, Promise, WeakMap, Error
  };
  vm.runInNewContext(inline, context);
  const socket = new window.WebSocket('ws://test'), displayed = [];
  socket.addEventListener('message', event => { const packet = JSON.parse(event.data); displayed.push({ balance: packet.balance.balance / 100, win: packet.win / 100, lineWin: packet.wins[0].amount / 100 }); });
  for (const [raw, win] of [[500, 0], [499, 0], [519, 20]]) { socket.emit(raw, win); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.deepEqual(displayed, [
    { balance: 4, win: 0, lineWin: 0 },
    { balance: 3, win: 0, lineWin: 0 },
    { balance: 23, win: 20, lineWin: 20 },
  ]);
});

test('cabinet lobby keeps responsive navigation and game launch controls wired', () => {
  assert.match(ui, /id="cabinet-theme"/);
  assert.match(ui, /className = "cabinetMarquee"/);
  assert.match(ui, /className = "cabinetDock"/);
  assert.match(ui, /id="dockGames"/);
  assert.match(ui, /el\("dockMenu"\)\.onclick/);
  assert.match(ui, /querySelectorAll\("\.game"\)/);
});

test('Evolution Lightning Roulette uses a fresh validated official demo launch', () => {
  assert.match(ui, /\["First Person Lightning Roulette", "EVOFPLR"/);
  assert.match(ui, /location\.assign\([\s\S]*?launch\.externalUrl \|\|/);
  assert.match(launcher, /result\?\.payload/);
  assert.match(launcher, /launchUrl\.hostname !== 'showcase\.evo-games\.com'/);
  assert.match(launcher, /gameKey === EVOLUTION_LIGHTNING_KEY \? await evolutionLightningDemoUrl\(\)/);
  assert.match(launcher, /return `\/evolution-demo\/\$\{ticket\}/);
  assert.match(launcher, /serveEvolutionDemo\(request, response, evolutionMatch\[1\]\)/);
  assert.match(launcher, /setup\.currencyCode = currency/);
  assert.match(launcher, /new WebSocketServer\(\{ noServer: true \}\)/);
  assert.match(launcher, /durableSimulatedBridgeScript\(demo\.bridgeToken\)/);
});

test('head administrator exclusively controls RTP and delegated admin permissions', () => {
  assert.match(launcher, /Only the head administrator can control RTP/);
  assert.match(launcher, /ADMIN_PERMISSION_KEYS/);
  assert.match(launcher, /Head administrator required/);
  assert.match(launcher, /ADMIN_PERMISSIONS_UPDATED/);
  assert.match(launcher, /requestedAdminPermissions\(input\.permissions\)/);
  assert.match(launcher, /Only the head administrator can create administrators/);
  assert.match(launcher, /Administrators can only be removed by the head administrator panel/);
  assert.match(ui, /id = "adminManagementBox"|id="adminManagementBox"/);
  assert.match(ui, /state\.permissions\.canManageRtp/);
  assert.match(ui, /\/api\/admins/);
  assert.match(ui, /"No managed instance"/);
  assert.match(ui, /Administrator created and active immediately/);
  assert.match(ui, /if \(state\.permissions\.canManageAdmins\) loadAdmins\(\)/);
  assert.match(launcher, /removedUsers=db\.users\.filter/);
  assert.match(launcher, /removedInstances=db\.instances\.filter/);
  assert.match(launcher, /DELETE FROM app_sessions WHERE user_id=ANY/);
  assert.match(launcher, /DELETE FROM game_bridges WHERE session_user_id=ANY/);
});

test('audit RTP override is scoped to its explicit wallet and leaves live RTP untouched', () => {
  assert.match(launcher, /bridge\?\.walletUserId === auditWallet/);
  assert.match(launcher, /return Number\(db\.settings\.rtpPercent\)/);
  assert.match(launcher, /targetRtp: localTargetRtp\(context\.bridge\)/);
  assert.doesNotMatch(launcher, /db\.settings\.rtpPercent\s*=\s*auditRtp/);
});

test('delegated permissions render before the administrator owns an instance', () => {
  assert.match(ui, /el\("rootTools"\)\.hidden = !state\.permissions\.canManageUsers/);
  assert.match(ui, /el\("instanceCreateBox"\)\.hidden = !state\.permissions\.canManageInstances/);
  assert.match(ui, /el\("settingsBox"\)\.hidden = !state\.permissions\.canManageSettings/);
  assert.match(ui, /el\("monitoringBox"\)\.hidden = !state\.permissions\.canViewMonitoring/);
  assert.match(ui, /el\("accountManagementBox"\)\.hidden = !state\.permissions\.canManageUsers;[\s\S]*?if \(!instance\)/);
  assert.match(ui, /bindToggle\.disabled = !instance/);
  assert.match(ui, /if \(!instance\) bindToggle\.checked = false/);
});

test('delegated administrators and wallets remain tenant isolated', () => {
  const store=fs.readFileSync('launcher-store.cjs','utf8');
  assert.match(store, /tenant_admin_id/);
  assert.match(store, /access_active/);
  assert.match(store, /last_active_at/);
  assert.match(store, /DELETE FROM instances WHERE NOT/);
  assert.match(store, /DELETE FROM users WHERE NOT/);
  assert.match(launcher, /instance\.ownerUserId === user\.id/);
  assert.match(launcher, /target\?\.tenantAdminId === admin\.id/);
  assert.match(launcher, /user\.tenantAdminId === instance\.ownerUserId/);
  assert.match(launcher, /accounts: hasPermission\(user, 'manageUsers'\) \? db\.users\.filter/);
});
