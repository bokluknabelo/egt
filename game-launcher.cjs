const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocket, WebSocketServer } = require('ws');
const { patchGameBundle, patchReelsTimingBundle, currencyWebSocketScript, mobileViewportScript, localLobbyNavigationScript } = require('./game-client-patches.cjs');
const { shouldIgnoreUpstreamReset } = require('./wallet-bridge-policy.cjs');
const { applyGlobalRtp, freshRtpAccounting, normalizeRtpPercent, roundMoney } = require('./rtp-policy.cjs');
const { compressionCacheVariant } = require('./game-proxy-policy.cjs');
const { EgtLocalSession } = require('./egt-local-engine.cjs');
const { DEFINITIONS: EGT_FAMILY_DEFINITIONS, classifyFamily: classifyEgtFamily } = require('./egt-family-engines.cjs');
const { selectMathConfiguration } = require('./egt-math-registry.cjs');
const { initStorage, saveState, saveStateWithLedger, saveGameSettlements, listLedger, recordError, monitoringSnapshot, recordUpdateCheck, recentUpdateChecks, saveSession, loadSessions, deleteSession, pruneSessions, saveGameBridge, loadGameBridges, pruneGameBridges: pruneStoredGameBridges, pruneOperationalData, pool } = require('./launcher-store.cjs');

const port = Number(process.env.PORT || 8080);
const root = __dirname;
const indexPath = path.join(root, 'index.html');
const playConfigPath = path.join(root, 'play-config.html');
const iconDir = path.join(root, 'game-icons');
const iconManifestPath = path.join(root, 'data', 'game-icons.json');
const dataPath = process.env.LAUNCHER_DATA_PATH || path.join(root, 'data', 'launcher-auth.json');
const dataDir = path.dirname(dataPath);
const setupTokenPath = `${dataPath}.setup-token`;
const sessions = new Map();
const loginAttempts = new Map();
const eventClients = new Set();
const gameBridges = new Map();
const walletQueues = new Map();
const gameClientCache = new Map();
const gameClientInflight = new Map();
const evolutionDemos = new Map();
const egtProtocolCaptureSeen = new Set();
const egtProtocolCapturePath = path.join(dataDir, 'egt-protocol-captures.jsonl');
const egtLocalProfiles = new Map();
const egtLocalSessions = new Map();
const egtLocalClients = new Map();
const GAME_CACHE_TTL = 6 * 60 * 60 * 1000;
const GAME_CACHE_LIMIT = 192 * 1024 * 1024;
const ADMIN_PERMISSION_KEYS = ['manageUsers','manageInstances','manageBalances','manageAccess','deleteInstances','viewLedger','manageCatalog','manageSettings','viewMonitoring'];
const EVOLUTION_LIGHTNING_KEY = 'EVOFPLR';
const EVOLUTION_PRODUCT_URL = 'https://games.evolution.com/first-person/first-person-lightning-roulette/';
let gameClientCacheBytes = 0;
let iconSyncRunning = false;
let shuttingDown=false;

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function defaultSettings() { return { playerCanLaunchGames: true, auditGameLaunches: true, allowAdminInstanceCreation: true, hidePlayLabels: true, defaultLanguage: 'en', automaticUpdates: true, updateIntervalMinutes: 60, upstreamBundleHash: '', lastUpdateCheckAt: null, ...freshRtpAccounting(100) }; }
function blankDb() { return { version: 2, users: [], instances: [], catalog: [], settings: defaultSettings(), systemAudit: [] }; }
function loadFallbackDb() {
  if (!fs.existsSync(dataPath)) return blankDb();
  try { const stored = JSON.parse(fs.readFileSync(dataPath, 'utf8')); return { ...blankDb(), ...stored, settings: { ...defaultSettings(), ...(stored.settings || {}) }, catalog: stored.catalog || [], systemAudit: stored.systemAudit || [] }; }
  catch (error) { throw new Error(`Cannot read account database: ${error.message}`); }
}
let db = blankDb();

function requiredSetupToken() {
  if (db.users.length) return '';
  if (process.env.LAUNCHER_SETUP_TOKEN) return process.env.LAUNCHER_SETUP_TOKEN;
  if (!fs.existsSync(setupTokenPath)) fs.writeFileSync(setupTokenPath, crypto.randomBytes(12).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(setupTokenPath, 'utf8').trim();
}

async function persist() { await saveState(db); }

function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function now() { return new Date().toISOString(); }
function normalizeUsername(value) { return String(value || '').trim().toLowerCase(); }
function validUsername(value) { return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 4 && value.length <= 128; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'));
}
function publicUser(user) { return { id: user.id, username: user.username, role: user.role, root: Boolean(user.root), currency: user.currency || 'RON', permissions: user.role === 'admin' ? user.permissions || {} : {}, tenantAdminId: user.tenantAdminId || null, createdAt: user.createdAt }; }
function publicInstance(instance, viewer) {
  const visibleMembers = canAdmin(viewer, instance) ? instance.members : instance.members.filter(member => member.userId === viewer.id);
  const members = visibleMembers.map(member => {
    const user = db.users.find(item => item.id === member.userId);
    return { userId: member.userId, username: user?.username || 'deleted-user', currency: user?.currency || 'RON', balance: member.balance, accessActive: memberAccessActive(member), lastActiveAt: member.lastActiveAt || null };
  });
  return { id: instance.id, name: instance.name, ownerUserId: instance.ownerUserId, ownerUsername: db.users.find(user => user.id === instance.ownerUserId)?.username || '', members, activity: canAdmin(viewer, instance) ? instance.activity.slice(-100).reverse() : [], createdAt: instance.createdAt, clearedAt: instance.clearedAt || null };
}
function hasPermission(user, permission) { return Boolean(user?.root || (user?.role === 'admin' && user.permissions?.[permission] === true)); }
function canAdmin(user, instance) { return Boolean(user && (user.root || (user.role === 'admin' && instance.ownerUserId === user.id))); }
function sameTenant(admin, target) { return Boolean(admin?.root || (admin?.role === 'admin' && target?.tenantAdminId === admin.id)); }
function memberAccessActive(member) { return Boolean(member?.accessActive); }
function memberFor(user, instance) { return user && instance.members.find(member => member.userId === user.id); }
function canAccess(user, instance) { return Boolean(user && (canAdmin(user, instance) || memberAccessActive(memberFor(user, instance)))); }
function activateMember(instance, member, actor) { member.accessActive = true; member.lastActiveAt = now(); audit(instance, actor, 'INSTANCE_ACCESS_ACTIVATED', { userId: member.userId, persistent: true }); }
function touchMemberAccess(instance, user) { const member = memberFor(user, instance); if (member && memberAccessActive(member)) member.lastActiveAt = now(); return member; }
async function revokeMemberGameSessions(instanceId, userId) {
  const revoked = [];
  for (const [hash, bridge] of gameBridges) {
    if (bridge.instanceId !== instanceId || (bridge.sessionUserId !== userId && bridge.walletUserId !== userId)) continue;
    gameBridges.delete(hash); revoked.push(hash);
    const sessionId = `${hash}:${bridge.gameKey}`;
    egtLocalSessions.delete(sessionId);
    for (const client of egtLocalClients.get(sessionId) || []) if (client.readyState < WebSocket.CLOSING) client.close(4003, 'Access deactivated by administrator');
    egtLocalClients.delete(sessionId);
  }
  if (revoked.length) await pool.query('DELETE FROM game_bridges WHERE token_hash=ANY($1::text[])', [revoked]);
}
function audit(instance, actor, type, details = {}) {
  instance.activity.push({ id: id('evt'), at: now(), actorUserId: actor.id, actorUsername: actor.username, type, details });
  if (instance.activity.length > 1000) instance.activity.splice(0, instance.activity.length - 1000);
}
function systemAudit(actor, type, details = {}) {
  db.systemAudit.push({ id: id('sys'), at: now(), actorUserId: actor.id, actorUsername: actor.username, type, details });
  if (db.systemAudit.length > 1000) db.systemAudit.splice(0, db.systemAudit.length - 1000);
}
function inferCategory(title) {
  if (/bell link/i.test(title)) return 'Bell Link';
  if (/burning|hot|fruits|clover|crown|dazzling|shining/i.test(title)) return 'Classic';
  if (/olympus|hermes|alexander|ra\b/i.test(title)) return 'Adventure';
  return 'Featured';
}
function syncCatalogFromIndex() {
  const source = fs.readFileSync(indexPath, 'utf8'); let changed = false;
  for (const match of source.matchAll(/\[\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g)) {
    if (db.catalog.some(game => game.key === match[2])) continue;
    db.catalog.push({ title: match[1], key: match[2], accent: match[3], tone: match[4], category: inferCategory(match[1]), enabled: true, createdAt: now(), updatedAt: now() }); changed = true;
  }
  let icons = {};
  try { icons = JSON.parse(fs.readFileSync(iconManifestPath, 'utf8')); } catch {}
  for (const [key, metadata] of Object.entries(icons)) {
    const game = db.catalog.find(item => item.key === key), icon = typeof metadata === 'string' ? metadata : metadata?.icon;
    if (!game || !/^\/game-icons\/[a-z0-9][a-z0-9._-]*$/i.test(icon || '') || game.icon === icon) continue;
    game.icon = icon; game.updatedAt = metadata?.updatedAt || now(); changed = true;
  }
  return changed;
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => { const at = value.indexOf('='); return [decodeURIComponent(value.slice(0, at)), decodeURIComponent(value.slice(at + 1))]; }));
}
function sessionFor(request) {
  const token = parseCookies(request).egt_session;
  const hash = token && tokenHash(token), session = hash && sessions.get(hash);
  if (!session) return null;
  const user = db.users.find(item => item.id === session.userId);
  return user ? { tokenHash: hash, session, user } : null;
}
function requireAuth(request) { const auth = sessionFor(request); if (!auth) throw apiError(401, 'Authentication required'); return auth; }
function requireCsrf(request, auth) { if (request.headers['x-csrf-token'] !== auth.session.csrf) throw apiError(403, 'Invalid CSRF token'); }
function requireAdminElevation(auth) { if (auth.user.role!=='admin') throw apiError(403,'Administrator account required'); if(!auth.session.adminAuthorizedUntil||auth.session.adminAuthorizedUntil<Date.now()) throw apiError(403,'Play Config authorization required'); }
function requirePermission(user, permission) { if (!hasPermission(user, permission)) throw apiError(403, `${permission} permission required`); }
function requestedAdminPermissions(input) { const source = input && typeof input === 'object' ? input : {}; return Object.fromEntries(ADMIN_PERMISSION_KEYS.map(key => [key, source[key] === true])); }
function apiError(status, message) { const error = new Error(message); error.status = status; return error; }
async function evolutionLightningDemoUrl() {
  const headers = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36', accept: 'text/html,application/xhtml+xml' };
  const page = await fetch(EVOLUTION_PRODUCT_URL, { headers, signal: AbortSignal.timeout(30000) });
  if (!page.ok) throw apiError(502, `Evolution demo page returned ${page.status}`);
  const html = await page.text(), nonce = html.match(/["']nonce["']\s*:\s*["']([a-f0-9]+)["']/i)?.[1];
  if (!nonce) throw apiError(502, 'Evolution demo launch token was not found');
  const cookie = page.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const start = await fetch('https://games.evolution.com/wp-json/games/v1/start?id=6565&mobile=false', {
    headers: { ...headers, accept: 'application/json', referer: EVOLUTION_PRODUCT_URL, 'x-wp-nonce': nonce, 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!start.ok) throw apiError(502, `Evolution demo launch returned ${start.status}`);
  const result = await start.json(), rawUrl = result?.payload || (typeof result?.data === 'string' ? result.data : result?.data?.url) || result?.url;
  let launchUrl; try { launchUrl = new URL(rawUrl); } catch { throw apiError(502, 'Evolution returned an invalid demo URL'); }
  if (launchUrl.protocol !== 'https:' || launchUrl.hostname !== 'showcase.evo-games.com' || launchUrl.pathname !== '/entry') throw apiError(502, 'Evolution returned an unexpected demo host');
  return launchUrl.href;
}
async function createEvolutionDemo(sessionUserId, upstreamUrl, bridgeToken) {
  const ticket = crypto.randomBytes(24).toString('base64url');
  const cookies = new Map(); let target = upstreamUrl, finalUrl, documentHtml;
  for (let redirects = 0; redirects < 5; redirects++) {
    const upstream = await fetch(target, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 Chrome/149.0.0.0', cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; ') }, signal: AbortSignal.timeout(30000) });
    for (const value of upstream.headers.getSetCookie()) { const pair = value.split(';', 1)[0], at = pair.indexOf('='); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) { target = new URL(upstream.headers.get('location'), target).href; continue; }
    if (!upstream.ok || !/text\/html/i.test(upstream.headers.get('content-type') || '')) throw apiError(502, `Evolution client returned ${upstream.status}`);
    finalUrl = new URL(target); documentHtml = await upstream.text(); break;
  }
  if (!documentHtml || !finalUrl) throw apiError(502, 'Evolution client redirect did not complete');
  const launchParams = new URLSearchParams(finalUrl.hash.slice(1)); launchParams.delete('demo'); launchParams.delete('app');
  const fragment = launchParams.size ? `#${launchParams}` : '';
  const demo = { sessionUserId, upstreamUrl, bridgeToken, cookies, documentHtml, fragment, expiresAt: Date.now() + 30 * 60 * 1000 };
  evolutionDemos.set(ticket, demo);
  return `/evolution-demo/${ticket}${demo.fragment}`;
}
function evolutionDemoFor(request) {
  const auth = requireAuth(request), ticket = parseCookies(request).evo_demo, demo = ticket && evolutionDemos.get(ticket);
  if (!demo || demo.sessionUserId !== auth.user.id || demo.expiresAt < Date.now()) throw apiError(404, 'Evolution game session expired');
  demo.expiresAt = Date.now() + 30 * 60 * 1000; return { auth, demo, ticket };
}
function serveEvolutionDemo(request, response, ticket) {
  const auth = requireAuth(request), demo = evolutionDemos.get(ticket);
  if (!demo || demo.sessionUserId !== auth.user.id || demo.expiresAt < Date.now()) throw apiError(404, 'Evolution demo session expired');
  demo.expiresAt = Date.now() + 30 * 60 * 1000;
  const injection = durableSimulatedBridgeScript(demo.bridgeToken) + `<script>try{Object.defineProperty(navigator,'serviceWorker',{value:undefined})}catch{}</script>`;
  const html = demo.documentHtml.replace('<head>', `<head>${injection}`).replaceAll('Demo Casino', 'Casino');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'set-cookie': `evo_demo=${ticket}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800` });
  response.end(html);
}
async function proxyEvolutionResource(request, response, url) {
  const { demo } = evolutionDemoFor(request), target = new URL(url.pathname + url.search, 'https://showcase.evo-games.com');
  const headers = { accept: request.headers.accept || '*/*', 'user-agent': request.headers['user-agent'] || 'Mozilla/5.0', cookie: [...demo.cookies].map(([key,value]) => `${key}=${value}`).join('; '), referer: 'https://showcase.evo-games.com/frontend/evo/r2/' };
  const init = { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) };
  if (!['GET','HEAD'].includes(request.method)) init.body = Buffer.concat(await (async()=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return chunks})());
  const upstream = await fetch(target, init); let payload = Buffer.from(await upstream.arrayBuffer()), contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  if (url.pathname === '/setup' && /json/i.test(contentType)) { const setup = JSON.parse(payload); const bridge = bridgeFor(request, demo.bridgeToken), currency = bridge.walletUser.currency || 'RON'; setup.currencyCode = currency; setup.currencySymbol = { EUR: '€', GBP: '£', RON: 'RON' }[currency] || currency; setup.currencyDecimals = 2; payload = Buffer.from(JSON.stringify(setup)); }
  const out = { 'content-type': contentType, 'content-length': payload.length, 'cache-control': 'no-store' };
  response.writeHead(upstream.status, out); response.end(payload);
}
function sendJson(response, status, value, headers = {}) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); response.end(JSON.stringify(value)); }
async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 100000) throw apiError(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw apiError(400, 'Invalid JSON'); }
}
function routeMatch(pathname, expression) { return pathname.match(expression); }
function structuredLog(level, event, details = {}) {
  const safe = JSON.parse(JSON.stringify(details, (key, value) => /password|cookie|csrf|token/i.test(key) ? '[REDACTED]' : value));
  const entry = { at: now(), level, service: 'launcher', event, ...safe };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
function decodedSockJsMessages(data) {
  if (Buffer.isBuffer(data)) data = data.toString('utf8');
  if (typeof data !== 'string') return [];
  try {
    const envelope = JSON.parse(data[0] === 'a' ? data.slice(1) : data);
    const values = Array.isArray(envelope) ? envelope : [envelope];
    return values.map(value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } });
  } catch { return []; }
}
function sanitizedProtocolValue(value) {
  if (Array.isArray(value)) return value.map(sanitizedProtocolValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [/session|token|password|cookie|playerId/i.test(key) ? key : key, /session|token|password|cookie|playerId/i.test(key) ? '[REDACTED]' : sanitizedProtocolValue(child)]));
}
function protocolShape(value, depth = 0) {
  if (depth > 7) return typeof value;
  if (Array.isArray(value)) return value.length ? [protocolShape(value[0], depth + 1)] : [];
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, protocolShape(child, depth + 1)]));
}
function captureEgtProtocolFrame(bridge, direction, data) {
  for (const value of decodedSockJsMessages(data)) {
    if (!value || typeof value !== 'object') continue;
    const event = String(value.event || value[0]?.event || 'unknown'), shape = protocolShape(value);
    const signature = crypto.createHash('sha256').update(`${bridge.gameKey}:${direction}:${event}:${JSON.stringify(shape)}`).digest('hex');
    if (egtProtocolCaptureSeen.has(signature) && process.env.EGT_PROTOCOL_CAPTURE_ALL !== '1') continue;
    egtProtocolCaptureSeen.add(signature);
    const entry = { capturedAt: now(), gameKey: bridge.gameKey, direction, event, signature, shape, sample: sanitizedProtocolValue(value) };
    fs.appendFile(egtProtocolCapturePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }, error => { if (error) structuredLog('error', 'egt_protocol_capture_failed', { message: error.message }); });
    structuredLog('info', 'egt_protocol_shape_captured', { gameKey: bridge.gameKey, direction, event, signature: signature.slice(0, 12) });
  }
}
function localEgtProfile(gameKey) {
  if (egtLocalProfiles.has(gameKey)) return egtLocalProfiles.get(gameKey);
  const filename = path.join(dataDir, 'egt-profiles', `${gameKey}.json`);
  if (!fs.existsSync(filename)) return null;
  const profile = JSON.parse(fs.readFileSync(filename, 'utf8')); egtLocalProfiles.set(gameKey, profile); return profile;
}
function localEgtGameKeys() {
  const directory = path.join(dataDir, 'egt-profiles');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).map(name => name.slice(0, -5));
}
async function limitedBody(response,limit=128*1024*1024){const declared=Number(response.headers.get('content-length')||0);if(declared>limit)throw apiError(502,'Upstream resource exceeds proxy limit');const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw apiError(502,'Upstream resource exceeds proxy limit');chunks.push(chunk)}return Buffer.concat(chunks,size)}
function cachedResourceBytes(resource){let total=resource.payload.length;for(const payload of resource.gzipVariants?.values()||[])total+=payload.length;return total}
function broadcastInstance(instance, type = 'state') {
  const message = `event: ${type}\ndata: ${JSON.stringify({ instanceId: instance.id, at: now() })}\n\n`;
  for (const client of eventClients) {
    const user = db.users.find(item => item.id === client.userId);
    if (user && canAccess(user, instance)) client.response.write(message);
  }
}
function broadcastAll(type = 'state') {
  const message = `event: ${type}\ndata: ${JSON.stringify({ at: now() })}\n\n`;
  for (const client of eventClients) client.response.write(message);
}
async function pruneGameBridgeCache() {
  // Game bridges are durable. They are revoked by logout, account/instance removal,
  // or explicit player deactivation, never by elapsed time.
}
async function createGameBridge(sessionUser, walletUser, instance, gameKey) {
  await pruneGameBridgeCache();
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = tokenHash(token), bridge = { sessionUserId: sessionUser.id, walletUserId: walletUser.id, currency: walletUser.currency || 'RON', instanceId: instance.id, gameKey, upstreamBalance: null, lastSequence: 0, updatedAt: Date.now(), queue: Promise.resolve() };
  gameBridges.set(hash, bridge); await saveGameBridge(hash, bridge);
  return token;
}
function bridgeFor(request, token) {
  const auth = requireAuth(request), bridgeHash = tokenHash(token), bridge = gameBridges.get(bridgeHash);
  if (!bridge || bridge.sessionUserId !== auth.user.id) throw apiError(404, 'Game session unavailable');
  const instance = db.instances.find(item => item.id === bridge.instanceId); if (!instance) throw apiError(404, 'Instance not found');
  if (!canAdmin(auth.user, instance) && !memberAccessActive(memberFor(auth.user, instance))) throw apiError(404, 'Instance not found');
  const accessMember = canAdmin(auth.user, instance) ? null : touchMemberAccess(instance, auth.user);
  const walletMember = instance.members.find(item => item.userId === bridge.walletUserId), walletUser = db.users.find(item => item.id === bridge.walletUserId);
  if ((!canAdmin(auth.user, instance) && !accessMember) || !walletMember || !walletUser) throw apiError(403, 'Game wallet is unavailable');
  bridge.updatedAt = Date.now();
  return { auth, bridge, bridgeHash, instance, member: walletMember, walletUser };
}
function simulatedBridgeScript(token) {
  const safeToken = JSON.stringify(token);
  return `<script>(()=>{const token=${safeToken};let localBalance=0,upstreamBase=null,offset=0,sequence=0,reportQueue=Promise.resolve();const endpoint='/api/game-bridge/'+encodeURIComponent(token);try{const xhr=new XMLHttpRequest;xhr.open('GET',endpoint,false);xhr.send();if(xhr.status===200)localBalance=JSON.parse(xhr.responseText).balance}catch{}const Native=window.WebSocket,wrapped=new WeakMap();function report(rawCredits){if(!Number.isFinite(rawCredits))return;if(upstreamBase===null){upstreamBase=rawCredits;offset=localBalance-rawCredits}const shown=Math.max(0,Math.round(rawCredits+offset));localBalance=shown;const requestSequence=++sequence;reportQueue=reportQueue.then(()=>fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({sequence:requestSequence,upstreamBalance:Math.round(rawCredits)})})).then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(requestSequence!==sequence)return;localBalance=v.balance;offset=localBalance-rawCredits;window.dispatchEvent(new CustomEvent('egt-simulated-balance',{detail:v}))}).catch(()=>{});return shown}function transform(data){if(typeof data!=='string')return data;const sockjs=data[0]==='a';try{const value=JSON.parse(sockjs?data.slice(1):data);let found=false;const visit=(node,parent,key)=>{if(typeof node==='string'){try{const nested=JSON.parse(node);visit(nested,null,null);if(found&&parent)parent[key]=JSON.stringify(nested)}catch{}return}if(!node||typeof node!=='object')return;if(node.balance&&typeof node.balance==='object'&&Number.isFinite(Number(node.balance.balance))){const units=Math.max(1,Number(node.balance.units)||1),shown=report(Number(node.balance.balance)/units);if(shown!==undefined)node.balance.balance=Math.round(shown*units);found=true}for(const childKey of Object.keys(node))if(childKey!=='balance')visit(node[childKey],node,childKey)};visit(value,null,null);return found?(sockjs?'a':'')+JSON.stringify(value):data}catch{return data}}function eventFor(event){const changed=transform(event.data);return changed===event.data?event:new MessageEvent('message',{data:changed,origin:event.origin,lastEventId:event.lastEventId,source:event.source,ports:event.ports})}class SimulatedWebSocket extends Native{addEventListener(type,listener,options){if(type!=='message'||!listener)return super.addEventListener(type,listener,options);let fn=wrapped.get(listener);if(!fn){fn=event=>typeof listener==='function'?listener.call(this,eventFor(event)):listener.handleEvent(eventFor(event));wrapped.set(listener,fn)}return super.addEventListener(type,fn,options)}removeEventListener(type,listener,options){return super.removeEventListener(type,wrapped.get(listener)||listener,options)}set onmessage(listener){if(this.__bridgeOnMessage)super.removeEventListener('message',this.__bridgeOnMessage);this.__bridgeOnMessage=listener?event=>listener.call(this,eventFor(event)):null;if(this.__bridgeOnMessage)super.addEventListener('message',this.__bridgeOnMessage)}get onmessage(){return this.__bridgeOnMessage||null}}Object.defineProperties(SimulatedWebSocket,{CONNECTING:{value:Native.CONNECTING},OPEN:{value:Native.OPEN},CLOSING:{value:Native.CLOSING},CLOSED:{value:Native.CLOSED}});window.WebSocket=SimulatedWebSocket;window.__EGT_SIMULATED_WALLET__={token,get balance(){return localBalance}}})();</script>`;
}
function legacyDurableSimulatedBridgeScript(token) {
  const safeToken = JSON.stringify(token);
  const resetPolicySource = shouldIgnoreUpstreamReset.toString();
  return `<script>(()=>{const token=${safeToken},endpoint='/api/game-bridge/'+encodeURIComponent(token);let localBalance=0,upstreamBase=null,offset=0,sequence=0,lastUpstream=null,lastChangeAt=Date.now(),reportQueue=Promise.resolve(),transformQueue=Promise.resolve();const eventCache=new WeakMap(),wrapped=new WeakMap();try{const xhr=new XMLHttpRequest;xhr.open('GET',endpoint,false);xhr.send();if(xhr.status===200){const initial=JSON.parse(xhr.responseText);localBalance=initial.balance;sequence=Number(initial.lastSequence)||0}}catch{}${resetPolicySource};async function report(rawCredits){if(!Number.isFinite(rawCredits))return localBalance;const time=Date.now(),idleFor=time-lastChangeAt,projected=Math.round((rawCredits+offset)*100)/100,initializing=upstreamBase===null,upstreamReset=shouldIgnoreUpstreamReset({upstreamBase,rawCredits,projected,localBalance,hidden:document.hidden,idleFor});if(lastUpstream!==null&&rawCredits!==lastUpstream)lastChangeAt=time;lastUpstream=rawCredits;if(upstreamReset){offset=localBalance-rawCredits;return localBalance}if(initializing){upstreamBase=rawCredits;offset=localBalance-rawCredits}const requestSequence=++sequence;const operation=reportQueue.then(()=>fetch(endpoint,{method:'POST',credentials:'same-origin',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({sequence:requestSequence,upstreamBalance:Math.round(rawCredits*100)/100,initialize:initializing})})).then(response=>response.ok?response.json():Promise.reject(new Error('Wallet update failed'))).then(value=>{localBalance=value.balance;offset=localBalance-rawCredits;window.dispatchEvent(new CustomEvent('egt-simulated-balance',{detail:value}));return localBalance});reportQueue=operation.catch(()=>localBalance);return operation}async function transform(data){if(typeof data!=='string')return data;const sockjs=data[0]==='a';try{const value=JSON.parse(sockjs?data.slice(1):data);let found=false;const visit=async(node,parent,key)=>{if(typeof node==='string'){try{const nested=JSON.parse(node);await visit(nested,null,null);if(found&&parent)parent[key]=JSON.stringify(nested)}catch{}return}if(!node||typeof node!=='object')return;if(node.balance&&typeof node.balance==='object'&&Number.isFinite(Number(node.balance.balance))){const units=Math.max(1,Number(node.balance.units)||1),shown=await report(Number(node.balance.balance)/units);node.balance.balance=Math.round(shown*units);found=true}for(const childKey of Object.keys(node))if(childKey!=='balance')await visit(node[childKey],node,childKey)};await visit(value,null,null);return found?(sockjs?'a':'')+JSON.stringify(value):data}catch{return data}}function eventFor(event){if(eventCache.has(event))return eventCache.get(event);const operation=transformQueue.then(async()=>{const changed=await transform(event.data);return changed===event.data?event:new MessageEvent('message',{data:changed,origin:event.origin,lastEventId:event.lastEventId,source:event.source,ports:event.ports})});transformQueue=operation.catch(()=>event);eventCache.set(event,operation);return operation}const Native=window.WebSocket;class SimulatedWebSocket extends Native{addEventListener(type,listener,options){if(type!=='message'||!listener)return super.addEventListener(type,listener,options);let fn=wrapped.get(listener);if(!fn){fn=event=>eventFor(event).then(changed=>typeof listener==='function'?listener.call(this,changed):listener.handleEvent(changed)).catch(()=>{});wrapped.set(listener,fn)}return super.addEventListener(type,fn,options)}removeEventListener(type,listener,options){return super.removeEventListener(type,wrapped.get(listener)||listener,options)}set onmessage(listener){if(this.__bridgeOnMessage)super.removeEventListener('message',this.__bridgeOnMessage);this.__bridgeOnMessage=listener?event=>eventFor(event).then(changed=>listener.call(this,changed)).catch(()=>{}):null;if(this.__bridgeOnMessage)super.addEventListener('message',this.__bridgeOnMessage)}get onmessage(){return this.__bridgeOnMessage||null}}Object.defineProperties(SimulatedWebSocket,{CONNECTING:{value:Native.CONNECTING},OPEN:{value:Native.OPEN},CLOSING:{value:Native.CLOSING},CLOSED:{value:Native.CLOSED}});window.WebSocket=SimulatedWebSocket;window.__EGT_SIMULATED_WALLET__={token,get balance(){return localBalance}}})();</script>`;
}
function durableSimulatedBridgeScript(token) {
  const spinHelpers = `;function spinWinKey(key){return /^(?:win|won|payout|award|profit|totalwin|totalwon|winamount|winvalue|gamblewin|lastwin|creditswon)$/.test(String(key).replace(/[^a-z]/gi,'').toLowerCase())}function scaleSpinWin(node,ratio,units,inWin=false){if(!node||typeof node!=='object')return;for(const key of Object.keys(node)){const value=node[key],context=inWin||spinWinKey(key)||/^(?:wins|winlines|payouts|awards)$/i.test(key);if(Number.isFinite(value)&&(spinWinKey(key)||(inWin&&/^(?:amount|value|credits|credit|money|payout|win)$/i.test(key))))node[key]=Math.round(value*ratio*units)/units;else if(value&&typeof value==='object')scaleSpinWin(value,ratio,units,context)}}`;
  const relayConstructor = `constructor(url,protocols){let destination=url;try{const parsed=new URL(String(url),location.href);if(parsed.hostname==='game-server-demo.egt-ong.com'){const scheme=location.protocol==='https:'?'wss:':'ws:';destination=scheme+'//'+location.host+'/egt-game-websocket?bridge='+encodeURIComponent(token)+'&target='+encodeURIComponent(parsed.href)}}catch{}if(protocols===undefined)super(destination);else super(destination,protocols)}`;
  return legacyDurableSimulatedBridgeScript(token)
    .replace(';async function report(rawCredits)', `${spinHelpers};async function report(rawCredits)`)
    .replace('if(!Number.isFinite(rawCredits))return localBalance;', 'if(!Number.isFinite(rawCredits))return {balance:localBalance,applied:0,rawDelta:0};')
    .replace('return localBalance}if(initializing)', 'return {balance:localBalance,applied:0,rawDelta:0}}if(initializing)')
    .replace('return localBalance});reportQueue=operation.catch(()=>localBalance);return operation}', 'return value});reportQueue=operation.catch(()=>({balance:localBalance,applied:0,rawDelta:0}));return operation}')
    .replace('shown=await report(Number(node.balance.balance)/units);node.balance.balance=Math.round(shown*units);found=true', 'settlement=await report(Number(node.balance.balance)/units);node.balance.balance=Math.round(settlement.balance*units);if(settlement.rawDelta>0&&settlement.applied>=0){const ratio=settlement.applied/settlement.rawDelta;if(ratio!==1)scaleSpinWin(node,ratio,units)}found=true')
    .replace('}catch{return data}}function eventFor', `}catch(error){if(error&&error.message==='Wallet update failed')throw error;return data}}function eventFor`)
    .replace('class SimulatedWebSocket extends Native{', `class SimulatedWebSocket extends Native{${relayConstructor}`);
}
async function checkForUpdates(actor = null) {
  const checkedAt = now(); const previousHash = db.settings.upstreamBundleHash || '';
  try {
    const response = await fetch('https://games.egt-ong.com/', { headers: { 'user-agent': 'EGT-Account-Arcade-Update-Monitor' } });
    if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
    const html = await response.text(); const match = html.match(/index\.bundle\.min\.js\?hash=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error('Upstream bundle hash was not found');
    const currentHash = match[1], changed = Boolean(previousHash && previousHash !== currentHash);
    db.settings.upstreamBundleHash = currentHash; db.settings.lastUpdateCheckAt = checkedAt;
    if (changed) { gameClientCache.clear(); gameClientCacheBytes = 0; systemAudit(actor || { id: 'system', username: 'system' }, 'UPSTREAM_UPDATED', { previousHash, currentHash }); }
    await persist(); await recordUpdateCheck(changed ? 'updated' : 'current', previousHash, currentHash, { changed });
    structuredLog('info', 'update_check', { changed, currentHash });
    return { ok: true, changed, previousHash, currentHash, checkedAt };
  } catch (error) {
    db.settings.lastUpdateCheckAt = checkedAt; await persist(); await recordUpdateCheck('failed', previousHash, null, { message: error.message }); await recordError('error', 'update-check', error.message);
    structuredLog('error', 'update_check_failed', { message: error.message });
    return { ok: false, error: error.message, checkedAt };
  }
}
async function proxyGameClient(request, response, url) {
  requireAuth(request);
  const relativePath = url.pathname.startsWith('/game-client/') ? url.pathname.slice('/game-client/'.length) : url.pathname.slice(1);
  const upstreamSearch = new URLSearchParams(url.searchParams); upstreamSearch.delete('bridge');
  const target = new URL(relativePath + (upstreamSearch.size ? `?${upstreamSearch}` : ''), 'https://games.egt-ong.com/');
  const cacheKey = target.href; const cached = !request.headers.range && gameClientCache.get(cacheKey);
  let resource;
  if (cached && Date.now() - cached.cachedAt < GAME_CACHE_TTL) {
    gameClientCache.delete(cacheKey); gameClientCache.set(cacheKey, cached); resource = cached;
  } else {
    if (cached) { gameClientCache.delete(cacheKey); gameClientCacheBytes -= cachedResourceBytes(cached); }
    const headers = { accept: request.headers.accept || '*/*', 'user-agent': request.headers['user-agent'] || 'EGT-Account-Arcade' };
    if (request.headers.range) headers.range = request.headers.range;
    const fetchResource=async()=>{const upstream=await fetch(target,{headers,redirect:'follow',signal:AbortSignal.timeout(30000)});if(!upstream.ok&&upstream.status!==206)throw apiError(upstream.status,`Game client upstream returned ${upstream.status}`);return {status:upstream.status,payload:await limitedBody(upstream),contentType:upstream.headers.get('content-type')||'application/octet-stream',contentRange:upstream.headers.get('content-range'),acceptRanges:upstream.headers.get('accept-ranges'),cachedAt:Date.now()}};
    if(!request.headers.range){let pending=gameClientInflight.get(cacheKey);if(!pending){pending=fetchResource().finally(()=>gameClientInflight.delete(cacheKey));gameClientInflight.set(cacheKey,pending)}resource=await pending}else resource=await fetchResource();
    if (!request.headers.range && resource.status === 200 && resource.payload.length < GAME_CACHE_LIMIT / 2 && !gameClientCache.has(cacheKey)) {
      gameClientCache.set(cacheKey, resource); gameClientCacheBytes += resource.payload.length;
      while (gameClientCacheBytes > GAME_CACHE_LIMIT && gameClientCache.size) { const [oldestKey, oldest] = gameClientCache.entries().next().value; gameClientCache.delete(oldestKey); gameClientCacheBytes -= cachedResourceBytes(oldest); }
    }
  }
  let payload = resource.payload;
  const contentType = resource.contentType;
  if (/text\/html/i.test(contentType)) {
    let html = payload.toString('utf8');
    const bridgeToken = url.searchParams.get('bridge');
    const bridge = bridgeToken && gameBridges.get(tokenHash(bridgeToken));
    const injection = bridge && bridge.sessionUserId === sessionFor(request)?.user.id ? durableSimulatedBridgeScript(bridgeToken) : '';
    html = html.replace('<head>', '<head><base href="/game-client/">'+mobileViewportScript()+localLobbyNavigationScript()+currencyWebSocketScript(bridge?.currency || sessionFor(request)?.session.activeGameCurrency || 'RON')+injection+'<link rel="preconnect" href="https://game-server-demo.egt-ong.com"><link rel="preconnect" href="https://egtdemo-lobby-release-ext.egt-ong.com">');
    payload = Buffer.from(html);
  } else if (/javascript/i.test(contentType) && /(^|\/)index\.bundle\.min\.js$/.test(target.pathname)) {
    const currency = sessionFor(request)?.session.activeGameCurrency || 'RON';
    payload = Buffer.from(patchGameBundle(payload.toString('utf8'), { hidePlayLabels: db.settings.hidePlayLabels, currency }).source);
  } else if (/javascript/i.test(contentType) && /(^|\/)components\/reels\.chunk\.js$/.test(target.pathname)) {
    payload = Buffer.from(patchReelsTimingBundle(payload.toString('utf8')).source);
  }
  const compressible = /(?:javascript|json|text\/|svg)/i.test(contentType) && payload.length > 1024 && !request.headers.range && /\bgzip\b/i.test(request.headers['accept-encoding'] || '');
  if (compressible) {
    const variant = compressionCacheVariant({ contentType, pathname: target.pathname, hidePlayLabels: db.settings.hidePlayLabels, currency: sessionFor(request)?.session.activeGameCurrency || 'RON' });
    if (variant === null) payload = zlib.gzipSync(payload, { level: 6 });
    else {
      resource.gzipVariants ||= new Map();
      if (resource.gzipVariants.has(variant)) payload = resource.gzipVariants.get(variant);
      else { payload = zlib.gzipSync(payload, { level: 6 }); resource.gzipVariants.set(variant, payload); if(gameClientCache.get(cacheKey)===resource){gameClientCacheBytes+=payload.length;while(gameClientCacheBytes>GAME_CACHE_LIMIT&&gameClientCache.size){const [oldestKey,oldest]=gameClientCache.entries().next().value;gameClientCache.delete(oldestKey);gameClientCacheBytes-=cachedResourceBytes(oldest)}} }
    }
  }
  const responseHeaders = {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': /index\.bundle\.min\.js$/.test(target.pathname) || /text\/html/i.test(contentType) ? 'no-store' : 'public, max-age=86400, stale-while-revalidate=604800',
    'x-content-type-options': 'nosniff',
    'x-game-cache': cached && resource === cached ? 'HIT' : 'MISS',
  };
  if (compressible) { responseHeaders['content-encoding'] = 'gzip'; responseHeaders.vary = 'accept-encoding'; }
  if (resource.contentRange) responseHeaders['content-range'] = resource.contentRange;
  if (resource.acceptRanges) responseHeaders['accept-ranges'] = resource.acceptRanges;
  response.writeHead(resource.status, responseHeaders); response.end(payload);
}
function visibleInstances(user) { return db.instances.filter(instance => canAccess(user, instance)); }
function playableInstances(user) { return db.instances.filter(instance => memberAccessActive(memberFor(user, instance))); }
function playablePublicInstances(user) {
  if (user.role !== 'admin') return playableInstances(user).map(instance => publicInstance(instance, { ...user, role: 'player', root: false }));
  return db.instances.filter(instance => canAdmin(user, instance)).map(instance => {
    const item = publicInstance(instance, user);
    item.members = item.members.filter(member => member.userId !== instance.ownerUserId && memberAccessActive(instance.members.find(source => source.userId === member.userId)));
    return item;
  }).filter(instance => instance.members.length);
}
function instanceFor(user, instanceId, admin = false) {
  const instance = db.instances.find(item => item.id === instanceId);
  if (!instance || (admin ? !canAdmin(user, instance) : !canAccess(user, instance))) throw apiError(404, 'Instance not found');
  return instance;
}
async function stateFor(user, csrf) {
  if (syncCatalogFromIndex()) await persist();
  return {
    user: publicUser(user), csrf,
    accounts: hasPermission(user, 'manageUsers') ? db.users.filter(account => user.root || sameTenant(user, account)).map(publicUser) : [],
    instances: playablePublicInstances(user),
    managedInstances: user.role === 'admin' ? db.instances.filter(instance => canAdmin(user, instance)).map(instance => publicInstance(instance, user)) : [],
    catalog: db.catalog.filter(game => game.enabled).map(game => {
      const profile = localEgtProfile(game.key);
      return { ...game, family: profile ? classifyEgtFamily(profile) : 'external' };
    }),
    settings: { ...db.settings, localGameEngineActive: process.env.EGT_GAME_ENGINE === 'local', localGameKeys: localEgtGameKeys() },
    permissions: { canLaunchGames: user.role === 'admin' || db.settings.playerCanLaunchGames, canManageUsers: hasPermission(user,'manageUsers'), canManageInstances: hasPermission(user,'manageInstances'), canManageBalances: hasPermission(user,'manageBalances'), canManageAccess: hasPermission(user,'manageAccess'), canDeleteInstances: hasPermission(user,'deleteInstances'), canViewLedger: hasPermission(user,'viewLedger'), canManageCatalog: hasPermission(user,'manageCatalog'), canManageSettings: hasPermission(user,'manageSettings'), canViewMonitoring: hasPermission(user,'viewMonitoring'), canManageAdmins: Boolean(user.root), canManageRtp: Boolean(user.root) },
    systemAudit: user.root ? db.systemAudit.slice(-200).reverse() : [],
  };
}

async function api(request, response, url) {
  let match;
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') return sendJson(response, 200, { setupRequired: db.users.length === 0 });
  if (request.method === 'POST' && url.pathname === '/api/setup') {
    if (db.users.length) throw apiError(409, 'Setup is already complete');
    const input = await body(request); const username = normalizeUsername(input.username);
    const expectedToken = requiredSetupToken();
    const suppliedToken = String(input.setupToken || '');
    const suppliedTokenBuffer = Buffer.from(suppliedToken); const expectedTokenBuffer = Buffer.from(expectedToken);
    if (!expectedToken || suppliedTokenBuffer.length !== expectedTokenBuffer.length || !crypto.timingSafeEqual(suppliedTokenBuffer, expectedTokenBuffer)) throw apiError(403, 'Invalid one-time setup code');
    if (!validUsername(username)) throw apiError(400, 'Username must be 3–32 letters, numbers, dots, dashes, or underscores');
    if (!validPassword(input.password)) throw apiError(400, 'Password must be 4–128 characters');
    const instanceName = String(input.instanceName || '').trim(); if (instanceName.length < 2 || instanceName.length > 60) throw apiError(400, 'Instance name must be 2–60 characters');
    const credentials = hashPassword(input.password);
    const user = { id: id('usr'), username, nickname: String(input.nickname || username).trim().slice(0, 40) || username, role: 'admin', root: true, currency: 'RON', passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: now() }; user.tenantAdminId=user.id;
    const instance = { id: id('ins'), name: instanceName, ownerUserId: user.id, members: [{ userId: user.id, balance: 0 }], activity: [], createdAt: now(), clearedAt: null };
    audit(instance, user, 'INSTANCE_CREATED', { name: instanceName }); db.users.push(user); db.instances.push(instance); await persist();
    if (fs.existsSync(setupTokenPath)) fs.unlinkSync(setupTokenPath);
    return sendJson(response, 201, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/login') {
    const key = request.socket.remoteAddress || 'unknown'; const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) throw apiError(429, 'Too many login attempts; try again later');
    const input = await body(request); const username = normalizeUsername(input.username); const user = db.users.find(item => item.username === username);
    if (!user || !validPassword(input.password) || !verifyPassword(input.password, user)) {
      attempt.count += 1; if (attempt.count >= 5) { attempt.until = Date.now() + 60000; attempt.count = 0; } loginAttempts.set(key, attempt);
      throw apiError(401, 'Invalid username or password');
    }
    loginAttempts.delete(key); const token = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
    const hash = tokenHash(token), session = { userId: user.id, csrf, activeGameCurrency: user.currency || 'RON', expiresAt: null }; sessions.set(hash, session); await saveSession(hash, session);
    return sendJson(response, 200, await stateFor(user, csrf), { 'set-cookie': `egt_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000` });
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const auth = requireAuth(request); requireCsrf(request, auth); sessions.delete(auth.tokenHash); await deleteSession(auth.tokenHash);
    return sendJson(response, 200, { ok: true }, { 'set-cookie': 'egt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/authorize') {
    const auth = requireAuth(request); requireCsrf(request, auth);
    if (auth.user.role !== 'admin') throw apiError(403, 'Administrator account required');
    const input = await body(request);
    if (typeof input.adminPassword !== 'string' || !verifyPassword(input.adminPassword, auth.user)) throw apiError(401, 'Administrator password confirmation failed');
    auth.session.adminAuthorizedUntil = Date.now()+15*60*1000; await saveSession(auth.tokenHash,auth.session);
    return sendJson(response, 200, { ok: true, expiresAt: auth.session.adminAuthorizedUntil });
  }
  if (request.method === 'GET' && url.pathname === '/api/state') { const auth = requireAuth(request); return sendJson(response, 200, await stateFor(auth.user, auth.session.csrf)); }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    const auth = requireAuth(request); response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`); const client = { userId: auth.user.id, response }; eventClients.add(client); request.on('close', () => eventClients.delete(client)); return;
  }

  let bridgeMatch;
  if ((bridgeMatch = routeMatch(url.pathname, /^\/api\/game-bridge\/([A-Za-z0-9_-]+)$/))) {
    const context = bridgeFor(request, bridgeMatch[1]);
    if (request.method === 'GET') return sendJson(response, 200, { balance: context.member.balance, gameKey: context.bridge.gameKey, lastSequence: context.bridge.lastSequence, simulated: true });
    if (request.method !== 'POST') throw apiError(405, 'Method not allowed');
    const input = await body(request), sequence = Number(input.sequence), upstreamBalance = Number(input.upstreamBalance), initialize = input.initialize === true;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(upstreamBalance) || Math.abs(upstreamBalance) > 1000000000 || Math.abs(upstreamBalance * 100 - Math.round(upstreamBalance * 100)) > 0.000001) throw apiError(400, 'Invalid simulated wallet update');
    const walletKey = `${context.instance.id}:${context.walletUser.id}`;
    const operation = (walletQueues.get(walletKey) || Promise.resolve()).then(async () => {
      const { bridge, bridgeHash, instance, member, walletUser, auth } = bridgeFor(request, bridgeMatch[1]);
      if (sequence <= bridge.lastSequence) return { balance: member.balance, applied: 0, duplicate: true, simulated: true };
      bridge.lastSequence = sequence;
      if (initialize || bridge.upstreamBalance === null) { bridge.upstreamBalance = upstreamBalance; await saveGameBridge(bridgeHash, bridge); return { balance: member.balance, applied: 0, initialized: true, simulated: true }; }
      const rawDelta = roundMoney(upstreamBalance - bridge.upstreamBalance); bridge.upstreamBalance = upstreamBalance;
      if (!rawDelta) { await saveGameBridge(bridgeHash, bridge); return { balance: member.balance, applied: 0, simulated: true }; }
      const balanceBefore = roundMoney(Number(member.balance));
      const accountableDelta = rawDelta < 0 ? -Math.min(balanceBefore, Math.abs(rawDelta)) : rawDelta;
      const rtp = applyGlobalRtp(db.settings, accountableDelta, walletKey);
      const balanceAfter = roundMoney(Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, balanceBefore + rtp.appliedDelta))), applied = roundMoney(balanceAfter - balanceBefore);
      member.balance = balanceAfter;
      if (applied) {
        const reason = applied < 0 ? 'GAME_WAGER' : 'GAME_WIN';
        const rtpDetails = { rawAmount: rtp.rawDelta, rtpPercent: rtp.rtpPercent, rtpEpoch: db.settings.rtpEpoch, walletWagered: rtp.walletWagered, walletReturned: rtp.walletReturned, globalWagered: rtp.totalWagered, globalReturned: rtp.totalReturned, globalRawReturned: rtp.rawReturned };
        const transaction = { id: id('txn'), instanceId: instance.id, userId: walletUser.id, username: walletUser.username, actorUserId: walletUser.id, actorUsername: walletUser.username, amount: applied, balanceBefore, balanceAfter, reason, reference: `${bridge.gameKey}:${sequence}`, details: { ...rtpDetails, launchedByUserId: auth.user.id, launchedByUsername: auth.user.username } };
        audit(instance, walletUser, reason, { transactionId: transaction.id, userId: walletUser.id, username: walletUser.username, launchedByUserId: auth.user.id, launchedByUsername: auth.user.username, gameKey: bridge.gameKey, amount: applied, balance: balanceAfter, simulated: true, ...rtpDetails });
        await saveGameSettlements(db, [transaction]); broadcastInstance(instance, 'balance');
      } else await persist();
      await saveGameBridge(bridgeHash, bridge);
      return { balance: balanceAfter, applied, rawDelta, rtpPercent: rtp.rtpPercent, simulated: true };
    });
    const settled = operation.catch(() => {}); context.bridge.queue = settled; walletQueues.set(walletKey, settled); settled.finally(() => { if (walletQueues.get(walletKey) === settled) walletQueues.delete(walletKey); });
    return sendJson(response, 200, await operation);
  }

  const auth = requireAuth(request); if (request.method !== 'GET') requireCsrf(request, auth);
  const elevatedPaths=/^\/api\/(?:admins(?:\/|$)|catalog-admin(?:\/|$)|accounts(?:\/|$)|instances(?:$|\/[^/]+$|\/[^/]+\/(?:ledger(?:\.csv)?|members(?:\/[^/]+\/(?:currency|access))?|clear)(?:\/|$))|admin\/(?:monitoring|check-updates|report)(?:\/|$)|settings(?:\/|$)|catalog(?:\/|$))/;
  if(elevatedPaths.test(url.pathname)) requireAdminElevation(auth);
  if (!auth.user.root && elevatedPaths.test(url.pathname)) {
    if (/^\/api\/accounts(?:\/|$)/.test(url.pathname)) requirePermission(auth.user,'manageUsers');
    else if (url.pathname === '/api/instances') requirePermission(auth.user,'manageInstances');
    else if (/^\/api\/instances\/[^/]+\/(?:credits|reset-balances|members\/[^/]+\/currency)$/.test(url.pathname)) requirePermission(auth.user,'manageBalances');
    else if (/^\/api\/instances\/[^/]+\/members(?:\/|$)/.test(url.pathname)) requirePermission(auth.user,'manageAccess');
    else if (/^\/api\/instances\/[^/]+\/ledger(?:\.csv)?$/.test(url.pathname)) requirePermission(auth.user,'viewLedger');
    else if (request.method === 'DELETE' && /^\/api\/instances\/[^/]+$/.test(url.pathname)) requirePermission(auth.user,'deleteInstances');
    else if (/^\/api\/instances\//.test(url.pathname)) requirePermission(auth.user,'manageInstances');
    else if (/^\/api\/(?:catalog-admin|catalog)(?:\/|$)/.test(url.pathname)) requirePermission(auth.user,'manageCatalog');
    else if (url.pathname === '/api/settings') requirePermission(auth.user,'manageSettings');
    else if (/^\/api\/admin\//.test(url.pathname)) requirePermission(auth.user,'viewMonitoring');
  }
  if (request.method === 'GET' && url.pathname === '/api/admins') {
    if (!auth.user.root) throw apiError(403, 'Head administrator required');
    return sendJson(response, 200, { admins: db.users.filter(user => user.role === 'admin').map(publicUser), permissionKeys: ADMIN_PERMISSION_KEYS });
  }
  if (request.method === 'POST' && url.pathname === '/api/admins') {
    if (!auth.user.root) throw apiError(403, 'Head administrator required');
    const input = await body(request), username = normalizeUsername(input.username);
    if (!validUsername(username) || db.users.some(user => user.username === username)) throw apiError(400, 'Choose a unique valid username');
    if (!validPassword(input.password)) throw apiError(400, 'Password must be 4–128 characters');
    const credentials = hashPassword(input.password), user = { id:id('usr'), username, nickname:username, role:'admin', root:false, permissions:requestedAdminPermissions(input.permissions), currency:'RON', passwordSalt:credentials.salt, passwordHash:credentials.hash, createdAt:now() }; user.tenantAdminId=user.id;
    db.users.push(user); systemAudit(auth.user,'ADMIN_CREATED',{userId:user.id,username,permissions:user.permissions}); await persist(); broadcastAll(); return sendJson(response,201,{user:publicUser(user)});
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/admins\/([^/]+)$/))) {
    if (!auth.user.root) throw apiError(403, 'Head administrator required'); const user=db.users.find(item=>item.id===match[1]&&item.role==='admin'); if(!user)throw apiError(404,'Administrator not found'); if(user.root)throw apiError(409,'Head administrator permissions cannot be changed');
    const input=await body(request); user.permissions=requestedAdminPermissions(input.permissions); if(input.password!==undefined){if(!validPassword(input.password))throw apiError(400,'Password must be 4–128 characters');const credentials=hashPassword(input.password);user.passwordSalt=credentials.salt;user.passwordHash=credentials.hash}
    systemAudit(auth.user,'ADMIN_PERMISSIONS_UPDATED',{userId:user.id,username:user.username,permissions:user.permissions});await persist();broadcastAll();return sendJson(response,200,{user:publicUser(user)});
  }
  if (request.method === 'DELETE' && (match = routeMatch(url.pathname, /^\/api\/admins\/([^/]+)$/))) {
    if (!auth.user.root) throw apiError(403, 'Head administrator required'); const index=db.users.findIndex(item=>item.id===match[1]&&item.role==='admin');if(index<0)throw apiError(404,'Administrator not found');const user=db.users[index];if(user.root)throw apiError(409,'Head administrator cannot be removed');
    const removedUsers=db.users.filter(item=>item.id===user.id||item.tenantAdminId===user.id),removedUserIds=new Set(removedUsers.map(item=>item.id)),removedInstances=db.instances.filter(instance=>instance.ownerUserId===user.id),removedInstanceIds=new Set(removedInstances.map(instance=>instance.id));
    db.instances=db.instances.filter(instance=>!removedInstanceIds.has(instance.id));for(const instance of db.instances)instance.members=instance.members.filter(member=>!removedUserIds.has(member.userId));db.users=db.users.filter(item=>!removedUserIds.has(item.id));
    for(const [hash,session] of sessions)if(removedUserIds.has(session.userId))sessions.delete(hash);for(const [hash,bridge] of gameBridges)if(removedUserIds.has(bridge.sessionUserId)||removedUserIds.has(bridge.walletUserId)||removedInstanceIds.has(bridge.instanceId))gameBridges.delete(hash);
    await pool.query('DELETE FROM app_sessions WHERE user_id=ANY($1::text[])',[[...removedUserIds]]);await pool.query('DELETE FROM game_bridges WHERE session_user_id=ANY($1::text[]) OR wallet_user_id=ANY($1::text[]) OR instance_id=ANY($2::text[])',[[...removedUserIds],[...removedInstanceIds]]);
    systemAudit(auth.user,'ADMIN_TENANT_REMOVED',{userId:user.id,username:user.username,removedUserCount:removedUsers.length,removedInstanceCount:removedInstances.length});await persist();broadcastAll();return sendJson(response,200,{ok:true,removedUsers:removedUsers.length,removedInstances:removedInstances.length});
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/provision-user') {
    if (!auth.user.root) throw apiError(403, 'Head administrator required');
    const input = await body(request), owner = db.users.find(user => user.role === 'admin' && !user.root && user.username === normalizeUsername(input.adminUsername));
    if (!owner) throw apiError(400, 'Select a valid delegated administrator');
    const username = normalizeUsername(input.username); if (!validUsername(username) || db.users.some(user => user.username === username)) throw apiError(400, 'Choose a unique valid username');
    const currency = ['RON','EUR','GBP'].includes(input.currency) ? input.currency : 'RON';
    const instanceName = String(input.instanceName || `${username} Local`).trim(); if (instanceName.length < 2 || instanceName.length > 60) throw apiError(400, 'Instance name must be 2–60 characters');
    const initialCredits = Number(input.initialCredits || 0); if (!Number.isInteger(initialCredits) || initialCredits < 0 || initialCredits > 50000 || (initialCredits > 0 && initialCredits < 50)) throw apiError(400, 'Initial credits must be 0 or an integer between 50 and 50,000');
    if (input.activate !== true) throw apiError(400, 'The new player instance must be activated');
    if (typeof input.adminPassword !== 'string' || !verifyPassword(input.adminPassword, auth.user)) throw apiError(401, 'Head administrator password confirmation failed');
    const credentials = hashPassword(crypto.randomBytes(32).toString('base64url')), user = { id:id('usr'), username, nickname:username, role:'player', root:false, tenantAdminId:owner.id, currency, passwordSalt:credentials.salt, passwordHash:credentials.hash, createdAt:now() };
    const member = { userId:user.id, balance:initialCredits, accessActive:true, lastActiveAt:now() }, instance = { id:id('ins'), name:instanceName, ownerUserId:owner.id, members:[{userId:owner.id,balance:0},member], activity:[], createdAt:now(), clearedAt:null };
    audit(instance,auth.user,'INSTANCE_CREATED',{name:instanceName,ownerUsername:owner.username,memberUsername:user.username,startingBalance:initialCredits,provisionedByHeadAdmin:true});
    audit(instance,auth.user,'INSTANCE_ACCESS_ACTIVATED',{userId:user.id,persistent:true}); db.users.push(user); db.instances.push(instance);
    const transactions = initialCredits ? [{id:id('txn'),instanceId:instance.id,userId:user.id,username:user.username,actorUserId:auth.user.id,actorUsername:auth.user.username,amount:initialCredits,balanceBefore:0,balanceAfter:initialCredits,reason:'ADMIN_CREDIT',reference:id('provision'),details:{source:'head-admin-provisioning',ownerAdminId:owner.id,ownerAdminUsername:owner.username}}] : [];
    systemAudit(auth.user,'USER_INSTANCE_PROVISIONED',{userId:user.id,username:user.username,instanceId:instance.id,instanceName,ownerAdminId:owner.id,ownerAdminUsername:owner.username,initialCredits,currency});
    if (transactions.length) await saveStateWithLedger(db,transactions); else await persist(); broadcastAll();
    return sendJson(response,201,{user:publicUser(user),instance:publicInstance(instance,auth.user),owner:publicUser(owner),initialCredits});
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog-admin') {
    requirePermission(auth.user,'manageCatalog'); if (syncCatalogFromIndex()) await persist();
    return sendJson(response, 200, { catalog: db.catalog, settings: db.settings, systemAudit: db.systemAudit.slice(-300).reverse() });
  }
  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    requirePermission(auth.user,'manageUsers');
    const input = await body(request); const username = normalizeUsername(input.username); const role = input.role === 'admin' ? 'admin' : 'player';
    if (role === 'admin' && !auth.user.root) throw apiError(403, 'Only the head administrator can create administrators');
    if (!validUsername(username) || db.users.some(user => user.username === username)) throw apiError(400, 'Choose a unique valid username');
    if (!validPassword(input.password)) throw apiError(400, 'Password must be 4–128 characters');
    const currency = ['RON','EUR','GBP'].includes(input.currency) ? input.currency : 'RON';
    const credentials = hashPassword(input.password); const user = { id: id('usr'), username, nickname:username, role, root: false, tenantAdminId: auth.user.id, currency, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: now() };
    db.users.push(user); await persist(); broadcastAll(); return sendJson(response, 201, { user: publicUser(user) });
  }
  if (request.method === 'DELETE' && (match = routeMatch(url.pathname, /^\/api\/accounts\/([^/]+)$/))) {
    requirePermission(auth.user,'manageUsers');
    const userIndex = db.users.findIndex(user => user.id === match[1]); if (userIndex < 0) throw apiError(404, 'Account not found');
    const user = db.users[userIndex]; if (!sameTenant(auth.user,user)) throw apiError(404,'Account not found'); if (user.role === 'admin') throw apiError(409, 'Administrators can only be removed by the head administrator panel');
    if (db.instances.some(instance => instance.ownerUserId === user.id)) throw apiError(409, 'Delete this administrator’s owned instances first');
    for (const instance of db.instances) instance.members = instance.members.filter(member => member.userId !== user.id);
    db.users.splice(userIndex, 1); systemAudit(auth.user, 'ACCOUNT_DELETED', { userId: user.id, username: user.username }); await persist(); broadcastAll(); return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/instances') {
    if (auth.user.role !== 'admin') throw apiError(403, 'Administrator account required');
    if (!auth.user.root && !db.settings.allowAdminInstanceCreation) throw apiError(403, 'Instance creation is disabled for administrators');
    const input = await body(request); const name = String(input.name || '').trim(); if (name.length < 2 || name.length > 60) throw apiError(400, 'Instance name must be 2–60 characters');
    let owner = auth.user;
    if (auth.user.root && input.ownerUsername) { owner = db.users.find(user => user.username === normalizeUsername(input.ownerUsername) && user.role === 'admin'); if (!owner) throw apiError(400, 'Owner must be an administrator account'); }
    let targetMember = null;
    if (input.memberUsername) { targetMember = db.users.find(user => user.username === normalizeUsername(input.memberUsername) && user.tenantAdminId === owner.id); if (!targetMember) throw apiError(400, 'Player/member account was not found in this administrator tenant'); }
    let sourceInstance = null, sourceMembership = null, startingBalance = 0;
    if (targetMember && targetMember.id !== owner.id) {
      const memberships = db.instances.map(instance => ({ instance, member: instance.members.find(member => member.userId === targetMember.id) })).filter(item => item.member);
      const requestedSource = input.sourceInstanceId && memberships.find(item => item.instance.id === input.sourceInstanceId);
      const selectedSource = requestedSource || memberships.filter(item => item.member.balance > 0).sort((a, b) => Date.parse(b.instance.createdAt) - Date.parse(a.instance.createdAt))[0];
      if (selectedSource) { sourceInstance = selectedSource.instance; sourceMembership = selectedSource.member; startingBalance = sourceMembership.balance; sourceMembership.balance = 0; }
    }
    const members = [{ userId: owner.id, balance: 0 }];
    if (targetMember && targetMember.id !== owner.id) members.push({ userId: targetMember.id, balance: startingBalance, accessActive: true, lastActiveAt: now() });
    const instance = { id: id('ins'), name, ownerUserId: owner.id, members, activity: [], createdAt: now(), clearedAt: null };
    const transactions = [];
    if (targetMember && startingBalance > 0) {
      const transferId = id('xfer');
      transactions.push({ id: id('txn'), instanceId: sourceInstance.id, userId: targetMember.id, username: targetMember.username, actorUserId: auth.user.id, actorUsername: auth.user.username, amount: -startingBalance, balanceBefore: startingBalance, balanceAfter: 0, reason: 'INSTANCE_TRANSFER_OUT', reference: transferId, details: { destinationInstanceId: instance.id } });
      transactions.push({ id: id('txn'), instanceId: instance.id, userId: targetMember.id, username: targetMember.username, actorUserId: auth.user.id, actorUsername: auth.user.username, amount: startingBalance, balanceBefore: 0, balanceAfter: startingBalance, reason: 'INSTANCE_TRANSFER_IN', reference: transferId, details: { sourceInstanceId: sourceInstance.id } });
      audit(sourceInstance, auth.user, 'BALANCE_TRANSFERRED_OUT', { transferId, userId: targetMember.id, destinationInstanceId: instance.id, amount: startingBalance });
    }
    audit(instance, auth.user, 'INSTANCE_CREATED', { name, ownerUsername: owner.username, memberUsername: targetMember?.username || null, startingBalance, sourceInstanceId: sourceInstance?.id || null }); db.instances.push(instance); if (transactions.length) await saveStateWithLedger(db, transactions); else await persist(); if (sourceInstance) broadcastInstance(sourceInstance, 'balance'); broadcastAll(); return sendJson(response, 201, { instance: publicInstance(instance, auth.user), transferredBalance: startingBalance, sourceInstanceId: sourceInstance?.id || null });
  }

  if (request.method === 'DELETE' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)$/))) {
    const instance = instanceFor(auth.user, match[1], true); const input = await body(request);
    if (typeof input.adminPassword !== 'string' || !verifyPassword(input.adminPassword, auth.user)) throw apiError(401, 'Administrator password confirmation failed');
    const index = db.instances.findIndex(item => item.id === instance.id); db.instances.splice(index, 1);
    systemAudit(auth.user, 'INSTANCE_DELETED', { instanceId: instance.id, name: instance.name }); await persist(); broadcastAll(); return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'GET' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/ledger$/))) {
    const instance = instanceFor(auth.user, match[1], true); const entries = await listLedger(instance.id, { since: instance.clearedAt || undefined, userId: url.searchParams.get('userId') || undefined, reason: url.searchParams.get('reason') || undefined, limit: url.searchParams.get('limit') || 300 });
    return sendJson(response, 200, { entries });
  }
  if (request.method === 'GET' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/ledger\.csv$/))) {
    const instance = instanceFor(auth.user, match[1], true); const entries = await listLedger(instance.id, { since: instance.clearedAt || undefined, limit: 50000 }); const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
    const rows = [['Transaction ID','Timestamp','User','Administrator','Amount','Balance before','Balance after','Reason','Reference'], ...entries.map(entry => [entry.id,entry.createdAt,entry.username,entry.actorUsername,entry.amount,entry.balanceBefore,entry.balanceAfter,entry.reason,entry.reference || ''])];
    const csv = rows.map(row => row.map(quote).join(',')).join('\r\n'); response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${instance.id}-ledger.csv"`, 'cache-control': 'no-store' }); return response.end(csv);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/monitoring') {
    requirePermission(auth.user,'viewMonitoring'); const ownedIds=auth.user.root?null:db.instances.filter(instance=>instance.ownerUserId===auth.user.id).map(instance=>instance.id);const snapshot = await monitoringSnapshot(ownedIds); snapshot.updateChecks = auth.user.root ? await recentUpdateChecks() : []; snapshot.runtime = { uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage(), sessions: sessions.size, realtimeClients: eventClients.size, gameCacheEntries: gameClientCache.size, gameCacheBytes: gameClientCacheBytes, node: process.version };
    return sendJson(response, 200, snapshot);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/check-updates') {
    if(!auth.user.root)throw apiError(403,'Head administrator required'); return sendJson(response, 200, await checkForUpdates(auth.user));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/report') {
    requirePermission(auth.user,'viewMonitoring');
    const input = await body(request), level = ['warning','error','fatal'].includes(input.level) ? input.level : 'error';
    const source = String(input.source || 'external').slice(0, 80), message = String(input.message || '').trim();
    if (!message) throw apiError(400, 'Problem report message is required');
    await recordError(level, source, message, input.details && typeof input.details === 'object' ? input.details : {});
    return sendJson(response, 201, { recorded: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    requirePermission(auth.user,'manageSettings');
    const input = await body(request);
    if (input.rtpPercent !== undefined && !auth.user.root) throw apiError(403, 'Only the head administrator can control RTP');
    for (const key of ['playerCanLaunchGames','auditGameLaunches','allowAdminInstanceCreation','hidePlayLabels','automaticUpdates']) if (typeof input[key] === 'boolean') db.settings[key] = input[key];
    if (['en','ro','bg'].includes(input.defaultLanguage)) db.settings.defaultLanguage = input.defaultLanguage;
    if (input.updateIntervalMinutes !== undefined) db.settings.updateIntervalMinutes = Math.min(1440, Math.max(5, Number(input.updateIntervalMinutes) || 60));
    if (input.rtpPercent !== undefined) {
      let nextRtp; try { nextRtp = normalizeRtpPercent(input.rtpPercent); } catch (error) { throw apiError(400, error.message); }
      if (nextRtp !== 100 && process.env.EGT_GAME_ENGINE !== 'local') throw apiError(409, 'Custom RTP requires the local game engine');
      if (nextRtp !== Number(db.settings.rtpPercent)) Object.assign(db.settings, freshRtpAccounting(nextRtp, now()));
    }
    systemAudit(auth.user, 'SETTINGS_UPDATED', { ...db.settings }); await persist(); return sendJson(response, 200, { settings: db.settings });
  }
  if (request.method === 'POST' && url.pathname === '/api/catalog') {
    requirePermission(auth.user,'manageCatalog'); const input = await body(request); const key = String(input.key || '').trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(key) || db.catalog.some(game => game.key === key)) throw apiError(400, 'Choose a unique valid game key');
    const title = String(input.title || '').trim(), category = String(input.category || 'Imported').trim(); if (title.length < 2 || title.length > 100 || category.length < 2 || category.length > 40) throw apiError(400, 'Invalid title or category');
    const icon = /^\/game-icons\/[a-z0-9][a-z0-9._-]*$/i.test(input.icon || '') ? input.icon : '';
    const hue = [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360; const game = { key, title, category, enabled: input.enabled !== false, accent: input.accent || `hsl(${hue} 82% 62%)`, tone: input.tone || `hsl(${hue} 48% 15%)`, icon, createdAt: now(), updatedAt: now() };
    db.catalog.push(game); systemAudit(auth.user, 'GAME_ADDED', { key, title }); await persist(); broadcastAll(); return sendJson(response, 201, { game });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/catalog\/([A-Za-z0-9_-]+)$/))) {
    requirePermission(auth.user,'manageCatalog'); const game = db.catalog.find(item => item.key === match[1]); if (!game) throw apiError(404, 'Game not found'); const input = await body(request);
    if (typeof input.enabled === 'boolean') game.enabled = input.enabled; if (input.title) game.title = String(input.title).slice(0, 100); if (input.category) game.category = String(input.category).slice(0, 40); if (/^\/game-icons\/[a-z0-9][a-z0-9._-]*$/i.test(input.icon || '')) game.icon = input.icon; game.updatedAt = now();
    systemAudit(auth.user, 'GAME_UPDATED', { key: game.key, enabled: game.enabled, category: game.category }); await persist(); broadcastAll(); return sendJson(response, 200, { game });
  }
  if (request.method === 'DELETE' && (match = routeMatch(url.pathname, /^\/api\/catalog\/([A-Za-z0-9_-]+)$/))) {
    requirePermission(auth.user,'manageCatalog'); const index = db.catalog.findIndex(item => item.key === match[1]); if (index < 0) throw apiError(404, 'Game not found'); const [game] = db.catalog.splice(index, 1);
    systemAudit(auth.user, 'GAME_REMOVED', { key: game.key, title: game.title }); await persist(); broadcastAll(); return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/members$/))) {
    const instance = instanceFor(auth.user, match[1], true); const input = await body(request); const member = db.users.find(user => user.username === normalizeUsername(input.username) && user.tenantAdminId === instance.ownerUserId);
    if (!member) throw apiError(404, 'Account not found'); if (instance.members.some(item => item.userId === member.id)) throw apiError(409, 'Account is already a member');
    const source = db.instances.filter(item => item.id !== instance.id).map(item => ({ instance: item, membership: item.members.find(existing => existing.userId === member.id) })).filter(item => item.membership?.balance > 0).sort((a, b) => Date.parse(b.instance.createdAt) - Date.parse(a.instance.createdAt))[0];
    const transferredBalance = source?.membership.balance || 0, transactions = [];
    if (source) {
      source.membership.balance = 0; const transferId = id('xfer');
      transactions.push({ id: id('txn'), instanceId: source.instance.id, userId: member.id, username: member.username, actorUserId: auth.user.id, actorUsername: auth.user.username, amount: -transferredBalance, balanceBefore: transferredBalance, balanceAfter: 0, reason: 'INSTANCE_TRANSFER_OUT', reference: transferId, details: { destinationInstanceId: instance.id } });
      transactions.push({ id: id('txn'), instanceId: instance.id, userId: member.id, username: member.username, actorUserId: auth.user.id, actorUsername: auth.user.username, amount: transferredBalance, balanceBefore: 0, balanceAfter: transferredBalance, reason: 'INSTANCE_TRANSFER_IN', reference: transferId, details: { sourceInstanceId: source.instance.id } });
      audit(source.instance, auth.user, 'BALANCE_TRANSFERRED_OUT', { transferId, userId: member.id, destinationInstanceId: instance.id, amount: transferredBalance });
    }
    const newMember = { userId: member.id, balance: transferredBalance }; instance.members.push(newMember); activateMember(instance, newMember, auth.user); audit(instance, auth.user, 'MEMBER_ADDED', { userId: member.id, username: member.username, transferredBalance, sourceInstanceId: source?.instance.id || null }); if (transactions.length) await saveStateWithLedger(db, transactions); else await persist(); if (source) broadcastInstance(source.instance, 'balance'); broadcastInstance(instance, 'balance'); return sendJson(response, 200, { instance: publicInstance(instance, auth.user), transferredBalance, sourceInstanceId: source?.instance.id || null });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/members\/activate-all$/))) {
    const instance = instanceFor(auth.user, match[1], true), players = instance.members.filter(member => member.userId !== instance.ownerUserId);
    if (!players.length) throw apiError(409, 'No player is assigned to this instance');
    for (const member of players) activateMember(instance,member,auth.user);
    audit(instance,auth.user,'INSTANCE_PLAYERS_ACTIVATED',{playerCount:players.length,persistent:true}); await persist(); broadcastAll();
    return sendJson(response,200,{instance:publicInstance(instance,auth.user),activatedUsers:players.length});
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/members\/([^/]+)\/access$/))) {
    const instance = instanceFor(auth.user, match[1], true), member = instance.members.find(item => item.userId === match[2]); if (!member) throw apiError(404, 'Member not found');
    const input = await body(request); if (input.active === false) { member.accessActive = false; member.lastActiveAt = null; await revokeMemberGameSessions(instance.id, member.userId); audit(instance, auth.user, 'INSTANCE_ACCESS_DEACTIVATED', { userId: member.userId }); } else activateMember(instance, member, auth.user);
    await persist(); broadcastAll(); return sendJson(response, 200, { instance: publicInstance(instance, auth.user) });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/members\/([^/]+)\/currency$/))) {
    const instance = instanceFor(auth.user, match[1], true), member = instance.members.find(item => item.userId === match[2]); if (!member) throw apiError(404, 'Member not found');
    const input = await body(request), currency = String(input.currency || '').toUpperCase(); if (!['RON','EUR','GBP'].includes(currency)) throw apiError(400, 'Currency must be RON, EUR, or GBP');
    const memberUser = db.users.find(item => item.id === member.userId); if (!memberUser) throw apiError(404, 'Account not found');
    const previousCurrency = memberUser.currency || 'RON'; memberUser.currency = currency; audit(instance, auth.user, 'USER_CURRENCY_CHANGED', { userId: memberUser.id, username: memberUser.username, previousCurrency, currency }); await persist(); broadcastInstance(instance); return sendJson(response, 200, { user: publicUser(memberUser) });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/credits$/))) {
    const instance = instanceFor(auth.user, match[1], true); const input = await body(request); const amount = Number(input.amount);
    if (typeof input.adminPassword !== 'string' || !verifyPassword(input.adminPassword, auth.user)) throw apiError(401, 'Administrator password confirmation failed');
    if (!Number.isInteger(amount) || amount < 50 || amount > 50000) throw apiError(400, 'Credits must be an integer between 50 and 50,000');
    const member = instance.members.find(item => item.userId === input.userId); if (!member) throw apiError(404, 'Member not found');
    const operationId=/^[A-Za-z0-9_-]{8,80}$/.test(String(input.operationId||''))?String(input.operationId):id('credit');
    const evidence={operationId,source:'admin-balance-control',sessionFingerprint:auth.tokenHash.slice(0,12),remoteAddress:request.socket.remoteAddress||'unknown',userAgent:String(request.headers['user-agent']||'').slice(0,240)};
    const walletKey=`${instance.id}:${member.userId}`,operation=(walletQueues.get(walletKey)||Promise.resolve()).then(async()=>{const currentInstance=instanceFor(auth.user,match[1],true),currentMember=currentInstance.members.find(item=>item.userId===input.userId);if(!currentMember)throw apiError(404,'Member not found');const memberUser=db.users.find(item=>item.id===currentMember.userId);if(!memberUser)throw apiError(404,'Account not found');const balanceBefore=Number(currentMember.balance),balanceAfter=balanceBefore+amount;currentMember.balance=balanceAfter;const transaction={id:id('txn'),instanceId:currentInstance.id,userId:currentMember.userId,username:memberUser.username,actorUserId:auth.user.id,actorUsername:auth.user.username,amount,balanceBefore,balanceAfter,reason:'ADMIN_CREDIT',reference:operationId,details:evidence};audit(currentInstance,auth.user,'CREDITS_ADDED',{transactionId:transaction.id,userId:currentMember.userId,amount,balanceBefore,balanceAfter,...evidence});await saveStateWithLedger(db,[transaction]);broadcastInstance(currentInstance,'balance');return {instance:publicInstance(currentInstance,auth.user),transaction}});
    const settled=operation.catch(()=>{});walletQueues.set(walletKey,settled);settled.finally(()=>{if(walletQueues.get(walletKey)===settled)walletQueues.delete(walletKey)});return sendJson(response,200,await operation);
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/reset-balances$/))) {
    const instance = instanceFor(auth.user, match[1], true); const input = await body(request);
    if (typeof input.adminPassword !== 'string' || !verifyPassword(input.adminPassword, auth.user)) throw apiError(401, 'Administrator password confirmation failed');
    const transactions = [];
    for (const member of instance.members) { const before = member.balance; member.balance = 0; if (before) { const memberUser = db.users.find(item => item.id === member.userId); transactions.push({ id: id('txn'), instanceId: instance.id, userId: member.userId, username: memberUser?.username || 'unknown', actorUserId: auth.user.id, actorUsername: auth.user.username, amount: -before, balanceBefore: before, balanceAfter: 0, reason: 'ADMIN_RESET' }); } }
    audit(instance, auth.user, 'BALANCES_RESET', { memberCount: instance.members.length, transactionCount: transactions.length }); if (transactions.length) await saveStateWithLedger(db, transactions); else await persist(); broadcastInstance(instance, 'balance'); return sendJson(response, 200, { instance: publicInstance(instance, auth.user) });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/clear$/))) {
    const instance = instanceFor(auth.user, match[1], true); instance.activity = []; instance.clearedAt = now(); audit(instance, auth.user, 'SLATE_CLEARED'); await persist();
    return sendJson(response, 200, { instance: publicInstance(instance, auth.user) });
  }
  if (request.method === 'POST' && (match = routeMatch(url.pathname, /^\/api\/instances\/([^/]+)\/launch$/))) {
    const instance = instanceFor(auth.user, match[1]); const input = await body(request); const gameKey = String(input.gameKey || ''); if (!/^[A-Za-z0-9_-]{2,40}$/.test(gameKey)) throw apiError(400, 'Invalid game key');
    if (!canAdmin(auth.user, instance)) touchMemberAccess(instance, auth.user);
    if (auth.user.role !== 'admin' && !db.settings.playerCanLaunchGames) throw apiError(403, 'Game launching is disabled for players');
    const game = db.catalog.find(item => item.key === gameKey && item.enabled); if (!game) throw apiError(404, 'Game is disabled or unavailable');
    if (process.env.EGT_GAME_ENGINE === 'local' && Number(db.settings.rtpPercent) !== 100 && !localEgtProfile(gameKey)) throw apiError(409, 'This title has not been migrated to the local RTP engine yet');
    const requestedWalletUserId = String(input.walletUserId || auth.user.id);
    if (!canAdmin(auth.user, instance) && requestedWalletUserId !== auth.user.id) throw apiError(403, 'Players can only launch their own wallet');
    const walletMember = instance.members.find(item => item.userId === requestedWalletUserId);
    const walletUser = walletMember && db.users.find(item => item.id === walletMember.userId); if (!walletUser) throw apiError(403, 'Game wallet is unavailable');
    if (!memberAccessActive(walletMember)) throw apiError(404, 'Instance is not active for this account');
    auth.session.activeGameCurrency = walletUser.currency || 'RON'; await saveSession(auth.tokenHash, auth.session);
    const bridge = await createGameBridge(auth.user, walletUser, instance, gameKey);
    const upstreamEvolutionUrl = gameKey === EVOLUTION_LIGHTNING_KEY ? await evolutionLightningDemoUrl() : '';
    const externalUrl = upstreamEvolutionUrl ? await createEvolutionDemo(auth.user.id, upstreamEvolutionUrl, bridge) : '';
    const opening = { id: id('txn'), instanceId: instance.id, userId: walletUser.id, username: walletUser.username, actorUserId: walletUser.id, actorUsername: walletUser.username, amount: 0, balanceBefore: walletMember.balance, balanceAfter: walletMember.balance, reason: 'GAME_SESSION_OPENED', reference: gameKey, details: { gameKey, launchedByUserId: auth.user.id, launchedByUsername: auth.user.username } };
    audit(instance, walletUser, 'GAME_LAUNCHED', { userId: walletUser.id, username: walletUser.username, launchedByUserId: auth.user.id, launchedByUsername: auth.user.username, gameKey, openingBalance: walletMember.balance, simulatedWallet: !externalUrl, officialDemo: Boolean(externalUrl) });
    await saveStateWithLedger(db, [opening]); return sendJson(response, 200, { ok: true, ...(externalUrl ? { externalUrl } : { bridge }) });
  }
  throw apiError(404, 'Not found');
}

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  if (request.url.startsWith('/api/')) response.on('finish', () => structuredLog('info', 'http_request', { method: request.method, path: request.url.split('?')[0], status: response.statusCode, durationMs: Date.now() - startedAt }));
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    if (url.pathname === '/play-config') {
      const auth = requireAuth(request);
      if (!auth.user.root) throw apiError(403, 'Head administrator required');
      const html = fs.readFileSync(playConfigPath);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
      return response.end(html);
    }
    const evolutionMatch = routeMatch(url.pathname, /^\/evolution-demo\/([A-Za-z0-9_-]+)$/);
    if (evolutionMatch) return serveEvolutionDemo(request, response, evolutionMatch[1]);
    if (['/setup','/config','/style','/log'].includes(url.pathname) || url.pathname.startsWith('/frontend/evo/')) return await proxyEvolutionResource(request, response, url);
    if (url.pathname.startsWith('/game-client/') || url.pathname.startsWith('/assets/')) return await proxyGameClient(request, response, url);
    if (url.pathname.startsWith('/game-icons/')) {
      requireAuth(request);
      const filename = path.basename(decodeURIComponent(url.pathname.slice('/game-icons/'.length)));
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(filename)) throw apiError(400, 'Invalid game icon');
      const file = path.join(iconDir, filename); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw apiError(404, 'Game icon not found');
      const extension = path.extname(filename).toLowerCase(), contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
      response.writeHead(200, { 'content-type': contentType, 'content-length': fs.statSync(file).size, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }); return fs.createReadStream(file).pipe(response);
    }
    if (url.pathname === '/health') { const health={ok:true,setupRequired:db.users.length===0,shuttingDown};if(url.searchParams.get('deep')==='1'){const started=Date.now(),disk=fs.statfsSync(root);try{await pool.query('SELECT 1');health.database={ok:true,latencyMs:Date.now()-started};health.disk={availableBytes:disk.bavail*disk.bsize,totalBytes:disk.blocks*disk.bsize};health.cache={entries:gameClientCache.size,bytes:gameClientCacheBytes,inflight:gameClientInflight.size};health.familyWebSockets=Object.fromEntries([...egtFamilyWebSockets].map(([familyId,familyServer])=>[familyId,{connections:familyServer.clients.size}]));health.upstreamBundleHash=db.settings.upstreamBundleHash||null}catch(error){health.ok=false;health.database={ok:false,error:error.message}}}return sendJson(response,health.ok?200:503,health); }
    if (url.pathname !== '/' && url.pathname !== '/index.html') { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return response.end('Not found'); }
    const html = fs.readFileSync(indexPath); response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self' https://games.egt-ong.com; connect-src 'self'; img-src 'self' data:" }); response.end(html);
  } catch (error) {
    structuredLog(error.status && error.status < 500 ? 'warn' : 'error', 'request_error', { method: request.method, path: request.url.split('?')[0], status: error.status || 500, message: error.message });
    if (!error.status || error.status >= 500) await recordError('error', 'http', error.message, { method: request.method, path: request.url.split('?')[0] }).catch(() => {});
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

const evolutionWebSockets = new WebSocketServer({ noServer: true });
const egtRelayWebSockets = new WebSocketServer({ noServer: true });
const egtFamilyWebSockets = new Map(Object.keys(EGT_FAMILY_DEFINITIONS).map(familyId => [familyId, new WebSocketServer({ noServer: true })]));
function egtFamilyWebSocket(profile) {
  const familyId = classifyEgtFamily(profile), familyServer = egtFamilyWebSockets.get(familyId);
  if (!familyServer) throw new Error(`No WebSocket engine registered for EGT family ${familyId}`);
  return { familyId, familyServer };
}
function localTargetRtp(bridge) {
  const auditWallet = String(process.env.EGT_AUDIT_WALLET_USER_ID || '');
  const auditRtp = Number(process.env.EGT_AUDIT_RTP);
  if (auditWallet && bridge?.walletUserId === auditWallet && Number.isFinite(auditRtp) && auditRtp >= 0 && auditRtp <= 100) return auditRtp;
  return Number(db.settings.rtpPercent);
}
async function settleLocalEngineRound(context, settlement, engineBalanceUnits) {
  if (!settlement || (!settlement.wagerUnits && !settlement.winUnits)) return;
  const walletKey = `${context.instance.id}:${context.walletUser.id}`;
  const operation = (walletQueues.get(walletKey) || Promise.resolve()).then(async () => {
    const member = context.instance.members.find(item => item.userId === context.walletUser.id);
    let balance = roundMoney(Number(member.balance));
    const entries = [];
    const addEntry = (amount, reason, accounting) => {
      const balanceBefore = balance; balance = roundMoney(balance + amount);
      const transaction = { id: id('txn'), instanceId: context.instance.id, userId: context.walletUser.id, username: context.walletUser.username, actorUserId: context.walletUser.id, actorUsername: context.walletUser.username, amount, balanceBefore, balanceAfter: balance, reason, reference: `${context.bridge.gameKey}:${settlement.reference}`, details: { rawAmount: accounting.rawDelta, rtpPercent: accounting.rtpPercent, rtpEpoch: db.settings.rtpEpoch, walletWagered: accounting.walletWagered, walletReturned: accounting.walletReturned, globalWagered: accounting.totalWagered, globalReturned: accounting.totalReturned, globalRawReturned: accounting.rawReturned, launchedByUserId: context.auth.user.id, launchedByUsername: context.auth.user.username, grossSettlement: true } };
      audit(context.instance, context.walletUser, reason, { transactionId: transaction.id, userId: context.walletUser.id, username: context.walletUser.username, gameKey: context.bridge.gameKey, amount, balance, grossSettlement: true });
      entries.push(transaction);
    };
    const wager = roundMoney(Number(settlement.wagerUnits || 0) / 100);
    const win = roundMoney(Number(settlement.winUnits || 0) / 100);
    if (wager > 0) addEntry(-Math.min(balance, wager), 'GAME_WAGER', applyGlobalRtp(db.settings, -Math.min(balance, wager), walletKey));
    if (win > 0) addEntry(win, 'GAME_WIN', applyGlobalRtp(db.settings, win, walletKey));
    member.balance = balance;
    context.bridge.upstreamBalance = roundMoney(Number(engineBalanceUnits) / 100);
    if (entries.length) { await saveGameSettlements(db, entries); broadcastInstance(context.instance, 'balance'); }
    await saveGameBridge(context.bridgeHash, context.bridge);
  });
  const settled = operation.catch(() => {}); walletQueues.set(walletKey, settled); settled.finally(() => { if (walletQueues.get(walletKey) === settled) walletQueues.delete(walletKey); });
  return operation;
}
server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/egt-game-websocket') {
      const token = url.searchParams.get('bridge') || '', context = bridgeFor(request, token);
      const profile = localEgtProfile(context.bridge.gameKey), targetRtp = localTargetRtp(context.bridge);
      const useLocalEngine = process.env.EGT_GAME_ENGINE === 'local' && profile && selectMathConfiguration(context.bridge.gameKey, targetRtp);
      if (useLocalEngine) {
        const { familyId, familyServer } = egtFamilyWebSocket(profile);
        return familyServer.handleUpgrade(request, socket, head, client => {
        const sessionId = `${context.bridgeHash}:${context.bridge.gameKey}`;
        let localSession = egtLocalSessions.get(sessionId);
        if (!localSession) { localSession = { engine: new EgtLocalSession({ profile, gameKey: context.bridge.gameKey, balanceUnits: Number(context.member.balance) * 100, targetRtp }) }; egtLocalSessions.set(sessionId, localSession); }
        const engine = localSession.engine; engine.targetRtp = targetRtp;
        if (!egtLocalClients.has(sessionId)) egtLocalClients.set(sessionId, new Set());
        egtLocalClients.get(sessionId).add(client);
        structuredLog('info', 'egt_family_websocket_opened', { gameKey: context.bridge.gameKey, familyId });
        client.send('o');
        let localMessageQueue = Promise.resolve();
        client.on('message', data => { localMessageQueue = localMessageQueue.then(async () => {
          captureEgtProtocolFrame(context.bridge, 'client_to_local', data);
          const responses = engine.messages(data), settlement = engine.consumeSettlement();
          if (settlement) await settleLocalEngineRound(context, settlement, engine.balance);
          for (const response of responses) { captureEgtProtocolFrame(context.bridge, 'local_to_client', response); if (client.readyState === WebSocket.OPEN) client.send(response); }
          if (decodedSockJsMessages(data).some(value => value?.event === 'loadGame')) for (const response of engine.pushMessages('jpstats')) { captureEgtProtocolFrame(context.bridge, 'local_to_client', response); if (client.readyState === WebSocket.OPEN) client.send(response); }
        }).catch(error => { structuredLog('error', 'egt_local_settlement_error', { gameKey: context.bridge.gameKey, message: error.message }); }); });
        const jackpotTimer = setInterval(() => { for (const response of engine.pushMessages('jpstats')) if (client.readyState === WebSocket.OPEN) client.send(response); }, 10000); jackpotTimer.unref();
        client.on('close', () => { clearInterval(jackpotTimer); const clients = egtLocalClients.get(sessionId); clients?.delete(client); if (clients && !clients.size) egtLocalClients.delete(sessionId); });
        client.on('error', error => structuredLog('warn', 'egt_local_engine_client_error', { gameKey: context.bridge.gameKey, message: error.message }));
        });
      }
      let target; try { target = new URL(url.searchParams.get('target') || ''); } catch { return socket.destroy(); }
      if (target.protocol !== 'wss:' || target.hostname !== 'game-server-demo.egt-ong.com' || !target.pathname.startsWith('/game-websocket/')) return socket.destroy();
      const requestedProtocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
      return egtRelayWebSockets.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(target, requestedProtocols.length ? requestedProtocols : undefined, { headers: { origin: 'https://games.egt-ong.com', 'user-agent': request.headers['user-agent'] || 'Mozilla/5.0' } });
        const queued = [];
        client.on('message', (data, binary) => { captureEgtProtocolFrame(context.bridge, 'client_to_egt', data); if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else queued.push([data, binary]); });
        upstream.on('open', () => { for (const [data,binary] of queued.splice(0)) upstream.send(data, { binary }); });
        upstream.on('message', (data, binary) => { captureEgtProtocolFrame(context.bridge, 'egt_to_client', data); if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
        client.on('close', (code, reason) => { if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason); });
        upstream.on('close', (code, reason) => { if (client.readyState < WebSocket.CLOSING) client.close(code, reason); });
        client.on('error', () => upstream.terminate()); upstream.on('error', error => { structuredLog('warn', 'egt_protocol_upstream_error', { gameKey: context.bridge.gameKey, message: error.message }); client.terminate(); });
      });
    }
    if (url.pathname !== '/public/horizon') return socket.destroy();
    const auth = sessionFor(request), ticket = parseCookies(request).evo_demo, demo = ticket && evolutionDemos.get(ticket);
    if (!auth || !demo || demo.sessionUserId !== auth.user.id || demo.expiresAt < Date.now()) return socket.destroy();
    const target = new URL(url.pathname + url.search, 'wss://showcase.evo-games.com');
    const requestedProtocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    evolutionWebSockets.handleUpgrade(request, socket, head, client => {
      const upstream = new WebSocket(target, requestedProtocols.length ? requestedProtocols : undefined, { headers: { origin: 'https://showcase.evo-games.com', cookie: [...demo.cookies].map(([key,value]) => `${key}=${value}`).join('; '), 'user-agent': request.headers['user-agent'] || 'Mozilla/5.0' } });
      const queued = [];
      client.on('message', (data, binary) => upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary }) : queued.push([data, binary]));
      upstream.on('open', () => { for (const [data,binary] of queued.splice(0)) upstream.send(data, { binary }); });
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      client.on('close', (code, reason) => { if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason); });
      upstream.on('close', (code, reason) => { if (client.readyState < WebSocket.CLOSING) client.close(code, reason); });
      client.on('error', () => upstream.terminate()); upstream.on('error', () => client.terminate());
    });
  } catch { socket.destroy(); }
});

setInterval(() => { const time = Date.now(); for (const [ticket, demo] of evolutionDemos) if (demo.expiresAt < time) evolutionDemos.delete(ticket); }, 60000).unref();
setInterval(()=>pruneOperationalData().catch(error=>structuredLog('error','retention_prune_failed',{message:error.message})),6*60*60*1000).unref();
setInterval(() => { for (const client of eventClients) client.response.write(': heartbeat\n\n'); }, 25000).unref();
setInterval(() => {
  if (!db.settings.automaticUpdates) return; const interval = Math.max(5, Number(db.settings.updateIntervalMinutes) || 60) * 60000; const last = Date.parse(db.settings.lastUpdateCheckAt || 0);
  if (!last || Date.now() - last >= interval) checkForUpdates().catch(error => structuredLog('error', 'scheduled_update_error', { message: error.message }));
}, 60000).unref();
process.on('unhandledRejection', error => { structuredLog('error', 'unhandled_rejection', { message: error?.message || String(error) }); recordError('error', 'process', error?.message || String(error)).catch(() => {}); });
process.on('uncaughtException', error => { structuredLog('fatal', 'uncaught_exception', { message: error.message }); recordError('fatal', 'process', error.message, { stack: error.stack }).finally(() => process.exit(1)); });

async function start() {
  db = await initStorage(loadFallbackDb()); db = { ...blankDb(), ...db, settings: { ...defaultSettings(), ...(db.settings || {}) }, catalog: db.catalog || [], systemAudit: db.systemAudit || [] };
  let providerPassThroughChanged = false;
  if (process.env.EGT_GAME_ENGINE !== 'local' && Number(db.settings.rtpPercent) !== 100) { Object.assign(db.settings, freshRtpAccounting(100, now())); providerPassThroughChanged = true; }
  for (const session of await loadSessions()) sessions.set(session.tokenHash, { userId: session.userId, csrf: session.csrf, activeGameCurrency: session.activeGameCurrency, expiresAt: session.expiresAt,adminAuthorizedUntil:session.adminAuthorizedUntil });
  for (const bridge of await loadGameBridges()) gameBridges.set(bridge.tokenHash, bridge);
  let userCurrenciesChanged = false; for (const user of db.users) if (!['RON','EUR','GBP'].includes(user.currency)) { user.currency = 'RON'; userCurrenciesChanged = true; }
  if (userCurrenciesChanged || providerPassThroughChanged) await persist();
  if (syncCatalogFromIndex()) await persist();
  server.listen(port, '0.0.0.0', () => structuredLog('info', 'server_started', { url: `http://0.0.0.0:${port}`, database: process.env.PGDATABASE || 'egt_arcade', node: process.version }));
  fs.watchFile(iconManifestPath, { interval: 1000 }, async () => {
    if (iconSyncRunning) return; iconSyncRunning = true;
    try { if (syncCatalogFromIndex()) { await persist(); broadcastAll(); structuredLog('info', 'game_icons_synchronized'); } }
    catch (error) { structuredLog('error', 'game_icon_sync_failed', { message: error.message }); }
    finally { iconSyncRunning = false; }
  });
  if (db.settings.automaticUpdates && !db.settings.lastUpdateCheckAt) setTimeout(() => checkForUpdates().catch(() => {}), 2000).unref();
}
start().catch(error => { structuredLog('fatal', 'startup_failed', { message: error.message }); process.exit(1); });
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(shuttingDown)return;shuttingDown=true;structuredLog('info','shutdown_started',{signal});server.close(()=>pool.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref()});
