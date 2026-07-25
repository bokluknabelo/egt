const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/tmp/egt-browser/node_modules/playwright');
const { patchGameBundle, currencyWebSocketScript } = require('./game-client-patches.cjs');
const { saveImporterJob, loadImporterJobs, pruneOperationalData, pool } = require('./launcher-store.cjs');

const ROOT = __dirname;
const PORT = Number(process.env.IMPORTER_PORT || 8081);
const LAUNCHER_API = process.env.LAUNCHER_API || 'http://127.0.0.1:8080';
const ICON_DIR = path.join(ROOT, 'game-icons');
const ICON_MANIFEST = path.join(ROOT, 'data', 'game-icons.json');
const DISCOVERY_CURSOR_PATH = path.join(ROOT, 'data', 'discovery-cursors.json');
const PROTOCOL_CAPTURE_DIR = path.join(ROOT, 'data', 'egt-captures');
const jobs = [];
const jobSaveTimers = new Map();
const clients = new Set();
const managementSessions = new Map();
let running = false;
let shuttingDown=false;

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function requestCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => { const at = value.indexOf('='); return [value.slice(0, at), decodeURIComponent(value.slice(at + 1))]; }));
}

function managementSession(req) {
  const token = requestCookies(req).importer_admin;
  const session = token && managementSessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) managementSessions.delete(token); throw Object.assign(new Error('Management login required'), { status: 401 }); }
  return session;
}

async function launcherRequest(session, pathname, method = 'GET', payload) {
  const response = await fetch(`${LAUNCHER_API}${pathname}`, { method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Launcher management request failed'), { status: response.status });
  return result;
}

function emit(type, value) {
  const message = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) client.write(message);
}

function storedJob(job) { const { managementSession, ...safe } = job; return safe; }
function persistJobSoon(job) { clearTimeout(jobSaveTimers.get(job.id)); const timer=setTimeout(()=>{jobSaveTimers.delete(job.id);saveImporterJob(storedJob(job)).catch(()=>{})},150);timer.unref();jobSaveTimers.set(job.id,timer); }

function log(job, message) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 600) job.logs.shift();
  persistJobSoon(job);
  emit('job', publicJob(job));
}

function publicJob(job) {
  return { id: job.id, url: job.url, slug: job.slug, title: job.title, key: job.key, assetKey: job.assetKey, icon: job.icon, iconUrl: job.iconUrl, iconOnly: Boolean(job.iconOnly), profileOnly: Boolean(job.profileOnly), reservoirOnly: Boolean(job.reservoirOnly), status: job.status, stage: job.stage, error: job.error, archive: job.archive, files: job.files, protocolCapture: job.protocolCapture || '', profile: job.profile || '', reservoir: job.reservoir || '', logs: job.logs };
}

function readDiscoveryCursors() { try { return JSON.parse(fs.readFileSync(DISCOVERY_CURSOR_PATH, 'utf8')); } catch { return {}; } }
function writeDiscoveryCursors(cursors) {
  fs.mkdirSync(path.dirname(DISCOVERY_CURSOR_PATH), { recursive: true }); const temporary = `${DISCOVERY_CURSOR_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cursors, null, 2)}\n`); fs.renameSync(temporary, DISCOVERY_CURSOR_PATH);
}
function discoveryBatch(result, limit) {
  if (!limit) return { ...result, batchStart: 0, batchEnd: result.links.length, remaining: 0, continued: false };
  const cursors = readDiscoveryCursors(), key = result.target, start = Math.min(Number(cursors[key]) || 0, result.links.length), links = result.links.slice(start, start + limit), end = start + links.length;
  cursors[key] = end; writeDiscoveryCursors(cursors);
  return { ...result, links, total: result.total, processable: links.length, batchStart: start, batchEnd: end, remaining: Math.max(0, result.total - end), continued: start > 0 };
}

function decodeHtml(text) {
  return text.replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&#x2013;/gi, '–').replace(/&#8217;|&#x2019;/gi, '’');
}

function titleCase(slug) {
  return slug.split('-').map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function artworkIdentity(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function findProductIcon(html, slug, pageUrl, gameKey = '', title = '') {
  const identities = [...new Set([slug, gameKey, title].map(artworkIdentity).filter(value => value.length >= 4))];
  const relaxed = identities.map(value => value.replace(/\d+$/g, '')).filter(value => value.length >= 5);
  const candidates = [...html.matchAll(/<img\b[^>]*>/gi)].map((match, index) => {
    const tag = match[0], raw = htmlAttribute(tag, 'src') || htmlAttribute(tag, 'data-src') || htmlAttribute(tag, 'data-lazy-src');
    if (!raw) return null;
    try {
      const url = new URL(raw, pageUrl);
      if (!['egt-digital.com', 'www.egt-digital.com'].includes(url.hostname)) return null;
      const alt = htmlAttribute(tag, 'alt'), text = `${url.pathname} ${alt}`, identity = artworkIdentity(text);
      const exactMatch = identities.find(value => identity.includes(value));
      const relaxedMatch = !exactMatch && relaxed.find(value => identity.includes(value));
      const primaryArtwork = index <= 1 && /496x420|469x420|1920x685/i.test(text);
      if (!exactMatch && !relaxedMatch && !primaryArtwork) return null;
      let score = exactMatch ? 200 : relaxedMatch ? 140 : 100;
      if (/496x420|469x420/i.test(text)) score += 80;
      if (/1920x685/i.test(text)) score += 50;
      if (/symbol|icon|logo|back|prefooter|prog/i.test(text)) score -= 120;
      return { url: url.href, score, index };
    } catch { return null; }
  }).filter(Boolean).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0]?.url || '';
}

function iconExtension(contentType, sourceUrl) {
  if (/webp/i.test(contentType)) return 'webp';
  if (/png/i.test(contentType)) return 'png';
  if (/jpe?g/i.test(contentType)) return 'jpg';
  const match = new URL(sourceUrl).pathname.match(/\.(webp|png|jpe?g)$/i);
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : '';
}

async function downloadIcon(job) {
  if (!job.iconUrl) throw new Error(`No game-specific artwork found for ${job.slug}`);
  job.stage = 'Downloading game icon'; log(job, `Downloading artwork ${job.iconUrl}`);
  const response = await fetch(job.iconUrl, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 EGT Demo Importer' } });
  if (!response.ok) throw new Error(`Game artwork returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '', extension = iconExtension(contentType, response.url);
  if (!extension || !/^image\//i.test(contentType)) throw new Error(`Unsupported game artwork type: ${contentType || 'unknown'}`);
  const payload = Buffer.from(await response.arrayBuffer());
  if (!payload.length || payload.length > 12 * 1024 * 1024) throw new Error('Game artwork is empty or larger than 12 MB');
  if (!['egt-digital.com', 'www.egt-digital.com'].includes(new URL(response.url).hostname)) throw new Error('Game artwork redirected outside egt-digital.com');
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const digest = require('crypto').createHash('sha256').update(payload).digest('hex').slice(0, 12);
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(ICON_MANIFEST, 'utf8')); } catch {}
  const duplicate = Object.entries(manifest).find(([key, metadata]) => {
    if (key === job.key) return false;
    const icon = typeof metadata === 'string' ? metadata : metadata?.icon;
    const existing = icon && path.join(ROOT, icon.replace(/^\//, ''));
    return existing && fs.existsSync(existing) && require('crypto').createHash('sha256').update(fs.readFileSync(existing)).digest('hex').startsWith(digest);
  });
  if (duplicate) throw new Error(`Artwork duplicates catalog game ${duplicate[0]}; refusing to assign one image to multiple games`);
  const filename = `${job.slug}-${digest}.${extension}`, destination = path.join(ICON_DIR, filename), temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload); fs.renameSync(temporary, destination);
  job.icon = `/game-icons/${filename}`;
  log(job, `Saved ${job.icon} (${payload.length.toLocaleString()} bytes)`);
}

function assignIcon(job) {
  fs.mkdirSync(path.dirname(ICON_MANIFEST), { recursive: true });
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(ICON_MANIFEST, 'utf8')); } catch {}
  manifest[job.key] = { icon: job.icon, slug: job.slug, title: job.title, source: job.iconUrl, updatedAt: new Date().toISOString() };
  const temporary = `${ICON_MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`); fs.renameSync(temporary, ICON_MANIFEST);
  log(job, `Assigned artwork to catalog key ${job.key}`);
}

function slugFromUrl(url) {
  const game = url.pathname.match(/\/game\/([a-z0-9-]+)\/?$/i);
  if (game) return game[1].toLowerCase();
  const gameKey = url.searchParams.get('gameKey');
  if (gameKey) return gameKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'egt-demo';
  const segments = url.pathname.split('/').map(value => value.trim()).filter(Boolean);
  const last = segments.at(-1) || url.hostname.replace(/^www\./, '');
  return last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'egt-capture';
}

function validateProductUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS EGT demo URLs are accepted');
  if (!['egt-digital.com', 'www.egt-digital.com', 'games.egt-ong.com'].includes(url.hostname)) throw new Error('Only egt-digital.com and games.egt-ong.com URLs are accepted');
  url.hash = '';
  if (url.hostname === 'games.egt-ong.com' && !url.searchParams.get('gameKey')) throw new Error('Direct games.egt-ong.com URLs must include gameKey');
  return { url: url.href, slug: slugFromUrl(url), expectedKey: url.searchParams.get('gameKey') || '' };
}

function validateDiscoveryUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !['egt-digital.com', 'www.egt-digital.com'].includes(url.hostname)) throw new Error('Discovery only accepts HTTPS egt-digital.com URLs');
  url.hash = '';
  return url;
}

async function discoverLinks(input) {
  const target = validateDiscoveryUrl(input);
  let browser;
  let rawLinks = [];
  let finalUrl = target.href;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const ageGate = page.getByRole('button', { name: /18 years or older/i }).first();
    if (await ageGate.count() && await ageGate.isVisible().catch(() => false)) {
      await ageGate.click();
      await page.waitForTimeout(400);
    }
    for (let pass = 0; pass < 50; pass++) {
      rawLinks = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({ href: anchor.href, text: (anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '').trim() })));
      const more = page.getByRole('button', { name: /load more|show more|view more/i }).last();
      const moreCount = await more.count();
      const moreVisible = moreCount ? await more.isVisible().catch(() => false) : false;
      if (!moreCount || !moreVisible) break;
      const beforeGames = await page.evaluate(() => new Set([...document.querySelectorAll('a[href]')].map(anchor => anchor.href).filter(href => /^https:\/\/(?:www\.)?egt-digital\.com\//i.test(href) || /^https:\/\/games\.egt-ong\.com\/\?gameKey=/i.test(href))).size);
      await more.scrollIntoViewIfNeeded();
      await more.click();
      const grew = await page.waitForFunction(previous => new Set([...document.querySelectorAll('a[href]')].map(anchor => anchor.href).filter(href => /^https:\/\/(?:www\.)?egt-digital\.com\//i.test(href) || /^https:\/\/games\.egt-ong\.com\/\?gameKey=/i.test(href))).size > previous, beforeGames, { timeout: 10000 }).then(() => true).catch(() => false);
      if (!grew) break;
    }
    finalUrl = page.url();
  } catch (browserError) {
    const response = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 EGT URL Discovery' } });
    if (!response.ok) throw new Error(`Target page returned HTTP ${response.status}`);
    const html = await response.text();
    finalUrl = response.url;
    rawLinks.push(...[...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gis)].map(match => ({ href: match[2], text: decodeHtml(match[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() })));
  } finally {
    if (browser) await browser.close();
  }
  if (!rawLinks.some(link => /(?:https?:\/\/(?:www\.)?egt-digital\.com)?\/[a-z0-9_/?=&.-]+/i.test(link.href || '') || /https?:\/\/games\.egt-ong\.com\/\?gameKey=/i.test(link.href || ''))) {
    const response = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 EGT URL Recovery' } });
    if (!response.ok) throw new Error(`Target page returned HTTP ${response.status}`);
    const html = decodeHtml(await response.text()).replace(/\\\//g, '/');
    rawLinks.push(...[...html.matchAll(/https?:\/\/(?:www\.)?egt-digital\.com\/[a-z0-9_/?=&.-]+/gi)].map(match => ({ href: match[0], text: '' })));
    rawLinks.push(...[...html.matchAll(/https?:\/\/games\.egt-ong\.com\/\?gameKey=([A-Za-z0-9_-]+)/g)].map(match => ({ href: match[0], text: match[1] })));
  }
  const base = new URL(finalUrl);
  const found = new Map();
  for (const raw of rawLinks) {
    try {
      const resolved = new URL(decodeHtml(raw.href.trim()), base);
      if (!['http:', 'https:'].includes(resolved.protocol)) continue;
      resolved.hash = '';
      const capturableHost = /^(?:www\.)?egt-digital\.com$/i.test(resolved.hostname) || resolved.hostname === 'games.egt-ong.com';
      if (!capturableHost) continue;
      if (resolved.hostname === 'games.egt-ong.com' && !resolved.searchParams.get('gameKey')) continue;
      const normalized = resolved.href;
      if (found.has(normalized)) continue;
      found.set(normalized, {
        url: normalized,
        text: decodeHtml(raw.text || '').replace(/\s+/g, ' ').trim(),
        sameHost: resolved.hostname === base.hostname,
        processable: true,
        slug: slugFromUrl(resolved),
      });
      if (found.size >= 2000) break;
    } catch {}
  }
  const links = [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
  if (!links.length) throw new Error('No capturable EGT links were found on this page');
  return { target: target.href, finalUrl, total: links.length, processable: links.length, links };
}

async function mine(job) {
  job.stage = 'Mining product page'; log(job, `Fetching ${job.url}`);
  const response = await fetch(job.url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 EGT Demo Importer' } });
  if (!response.ok) throw new Error(`Product page returned HTTP ${response.status}`);
  const html = await response.text();
  const keys = [...html.matchAll(/https:\/\/games\.egt-ong\.com\/\?gameKey=([A-Za-z0-9_-]+)/g)].map(match => match[1]);
  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length) throw new Error('No official demo gameKey found');
  job.key = job.expectedKey || uniqueKeys[0];
  if (job.expectedKey && !uniqueKeys.includes(job.expectedKey)) log(job, `Product page currently advertises ${uniqueKeys.join(', ')}, preserving captured game key ${job.expectedKey}`);
  const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  const rawTitle = titleMatch ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
  job.title = /^(?:Game|Казино игри):\s*/i.test(rawTitle) ? titleCase(job.slug) : rawTitle.replace(/\s*[-–|]\s*EGT Digital.*$/i, '').trim() || titleCase(job.slug);
  job.iconUrl = findProductIcon(html, job.slug, response.url, job.key, job.title);
  if (!job.iconUrl) log(job, `No game-specific artwork found for ${job.slug}; continuing without icon`);
  log(job, `Mined game key ${job.key} (${job.title})`);
}

function run(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(job, `$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd: options.cwd || ROOT, env: { ...process.env, ...options.env } });
    const consume = data => data.toString().split(/\r?\n/).filter(Boolean).forEach(line => log(job, line));
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function captureProtocolProfile(job) {
  job.stage = 'Capturing gameplay protocol';
  const protocolDir = path.join(PROTOCOL_CAPTURE_DIR, job.key), protocolFile = path.join(protocolDir, `${Date.now()}-${job.id}.json`);
  await run(job, process.execPath, [path.join(ROOT, 'capture-egt-protocol.cjs'), job.key, protocolFile, String(job.captureSeconds * 1000)]);
  job.protocolCapture = path.relative(ROOT, protocolFile);
  job.stage = 'Merging local-engine profile';
  const protocolCorpus = fs.readdirSync(protocolDir).filter(name => name.endsWith('.json')).sort().map(name => path.join(protocolDir, name));
  await run(job, process.execPath, [path.join(ROOT, 'merge-egt-profile.cjs'), job.key, ...protocolCorpus]);
  job.profile = path.relative(ROOT, path.join(ROOT, 'data', 'egt-profiles', `${job.key}.json`));
}

async function captureReservoirProfile(job) {
  const spins = Math.max(1, Number(job.captureSpins || 5000));
  const outputDir = path.join(ROOT, 'output', `live-goal-${spins}`);
  const liveFile = path.join(outputDir, `${job.key}-${spins}.json`);
  job.stage = `Capturing ${spins} live bets`;
  await run(job, process.execPath, [path.join(ROOT, 'capture-egt-live-direct.cjs'), job.key, String(spins), liveFile, job.url], { env: { ...process.env, EGT_CAPTURE_DELAY_MS: String(process.env.EGT_CAPTURE_DELAY_MS || '100') } });
  job.protocolCapture = path.relative(ROOT, liveFile);
  job.stage = 'Merging local-engine profile';
  const protocolDir = path.join(PROTOCOL_CAPTURE_DIR, job.key);
  fs.mkdirSync(protocolDir, { recursive: true, mode: 0o700 });
  const importedProtocol = path.join(protocolDir, `${Date.now()}-${job.id}-live-${spins}.json`);
  fs.copyFileSync(liveFile, importedProtocol);
  const protocolCorpus = fs.readdirSync(protocolDir).filter(name => name.endsWith('.json')).sort().map(name => path.join(protocolDir, name));
  await run(job, process.execPath, [path.join(ROOT, 'merge-egt-profile.cjs'), job.key, ...protocolCorpus]);
  job.profile = path.relative(ROOT, path.join(ROOT, 'data', 'egt-profiles', `${job.key}.json`));
  job.stage = 'Building slot reservoir';
  await run(job, process.execPath, [path.join(ROOT, 'build-egt-slot-reservoirs.cjs'), job.key], { env: { ...process.env, EGT_RESERVOIR_SOURCES: liveFile } });
  job.reservoir = path.relative(ROOT, path.join(ROOT, 'data', 'egt-slot-reservoirs', `${job.key}.json`));
}

function copyEntrypoints(packageRoot) {
  for (const file of ['index.html', 'index.bundle.min.js', 'loader.bundle.min.js', 'vendors.bundle.min.js']) {
    const source = path.join(packageRoot, 'extracted', file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, file));
  }
}

function patchCapturedClient(job, packageRoot) {
  const bundlePath = path.join(packageRoot, 'extracted', 'index.bundle.min.js');
  if (!fs.existsSync(bundlePath)) throw new Error('Captured index.bundle.min.js is missing');
  const patched = patchGameBundle(fs.readFileSync(bundlePath, 'utf8'), { hidePlayLabels: true });
  fs.writeFileSync(bundlePath, patched.source);
  const htmlPath = path.join(packageRoot, 'extracted', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('data-egt-currency-patch')) html = html.replace('<head>', `<head>${currencyWebSocketScript()}`);
    fs.writeFileSync(htmlPath, html);
  }
  log(job, `Patched shared client: replaced ${patched.currencyLabels} static EGT labels with RON; added global live-currency patch; removed ${patched.playLabels} PLAY labels; redirected ${patched.homeHandlers} Home handler to lobby`);
}

function countFiles(folder) {
  let count = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) count += countFiles(target); else count++;
  }
  return count;
}

function detectAssetKey(packageRoot, gameKey) {
  const assets = path.join(packageRoot, 'extracted', 'assets');
  if (!fs.existsSync(assets)) return gameKey;
  const candidates = fs.readdirSync(assets, { withFileTypes: true }).filter(entry => entry.isDirectory() && /Slot$/.test(entry.name)).map(entry => entry.name);
  if (candidates.includes(gameKey)) return gameKey;
  const normalized = gameKey.replace(/HR(?=Slot$)/, '');
  return candidates.find(key => key === normalized) || candidates.find(key => gameKey.startsWith(key.replace(/Slot$/, ''))) || gameKey;
}

function writeReadme(job, packageRoot) {
  const text = `# ${job.title} — extracted HTML5 demo assets\n\nProduct page: \`${job.url}\`\n\nDemo launcher: \`https://games.egt-ong.com/?gameKey=${job.key}\`\n\nThe \`extracted/\` directory contains successful HTTP 200 responses captured from the official public demo with URL paths preserved. Title assets are under \`extracted/assets/${job.assetKey}/\`. The embedded capture is \`network.har\`, and \`urls.txt\` lists observed requests.\n\nLive gameplay depends on EGT's public demo session and WebSocket backend.\n`;
  fs.writeFileSync(path.join(packageRoot, 'README.md'), text);
}

function palette(key) {
  let hash = 0; for (const char of key) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return [`hsl(${hue} 82% 62%)`, `hsl(${hue} 48% 15%)`];
}

function quoteJs(value) { return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

function updateLauncher(job) {
  const indexPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  if (new RegExp(`['"]${job.key}['"]`).test(html)) { log(job, 'Launcher already contains this game key'); return; }
  const marker = '      // GAME_CATALOG_END';
  if (!html.includes(marker)) throw new Error('Launcher catalog marker is missing');
  const [accent, tone] = palette(job.key);
  const entry = `      [${quoteJs(job.title)},${quoteJs(job.key)},${quoteJs(accent)},${quoteJs(tone)}],\n`;
  html = html.replace(marker, entry + marker);
  fs.writeFileSync(indexPath, html);
  log(job, 'Added game to index.html catalog');
}

async function processJob(job) {
  job.status = 'running'; await saveImporterJob(storedJob(job)); emit('job', publicJob(job));
  let stageJob='',backupPackage='',backupArchive='',promotedPackage=false,promotedArchive=false,indexBefore=null,manifestBefore=null;
  try {
    await mine(job);
    if (job.iconOnly) {
      await downloadIcon(job); assignIcon(job);
      job.status = 'complete'; job.stage = 'Icon complete'; log(job, `Icon-only complete: ${job.icon}`); await saveImporterJob(storedJob(job)); emit('job', publicJob(job)); return;
    }
    if (job.profileOnly) {
      await captureProtocolProfile(job);
      job.status = 'complete'; job.stage = 'Local profile complete'; log(job, `Local-engine profile complete: ${job.profile}`); await saveImporterJob(storedJob(job)); emit('job', publicJob(job)); return;
    }
    if (job.reservoirOnly) {
      await captureReservoirProfile(job);
      job.status = 'complete'; job.stage = 'Reservoir complete'; log(job, `Reservoir complete: ${job.reservoir}`); await saveImporterJob(storedJob(job)); emit('job', publicJob(job)); return;
    }
    const livePackage = path.join(ROOT,job.slug),archivePath=path.join(ROOT,`${job.slug}-assets.zip`);
    if (fs.existsSync(livePackage) && !job.overwrite) throw new Error(`Directory ${job.slug} already exists; enable overwrite to recapture it`);
    stageJob=path.join(ROOT,'.import-staging',job.id); const packageRoot=path.join(stageJob,'egt',job.slug),captureName=path.relative(ROOT,packageRoot),stagedArchive=path.join(stageJob,`${job.slug}-assets.zip`);
    fs.rmSync(stageJob,{recursive:true,force:true});
    fs.mkdirSync(packageRoot, { recursive: true });
    job.stage = 'Capturing Playwright HAR';
    await run(job, process.execPath, [path.join(ROOT, 'capture-egt-demo.js'), job.key, captureName, String(job.captureSeconds * 1000)]);
    job.stage = 'Parsing embedded HAR';
    await run(job, process.execPath, [path.join(ROOT, 'extract-har-assets.js'), captureName]);
    await captureProtocolProfile(job);
    job.stage = 'Patching captured client';
    patchCapturedClient(job, packageRoot);
    copyEntrypoints(packageRoot);
    job.assetKey = detectAssetKey(packageRoot, job.key);
    if (job.assetKey !== job.key) log(job, `Mined asset-key suffix mapping: ${job.key} → ${job.assetKey}`);
    writeReadme(job, packageRoot);
    job.files = countFiles(path.join(packageRoot, 'extracted'));
    job.stage = 'Packaging ZIP';
    await run(job, 'zip', ['-qr', stagedArchive, `egt/${job.slug}/extracted`], { env: process.env, cwd: stageJob });
    await run(job, 'unzip', ['-tq', stagedArchive]);
    job.archive = `${job.slug}-assets.zip`;
    job.stage='Promoting verified capture'; backupPackage=path.join(stageJob,'previous-package');backupArchive=path.join(stageJob,'previous-archive.zip');
    if(fs.existsSync(livePackage))fs.renameSync(livePackage,backupPackage); if(fs.existsSync(archivePath))fs.renameSync(archivePath,backupArchive);
    fs.renameSync(packageRoot,livePackage);promotedPackage=true;fs.renameSync(stagedArchive,archivePath);promotedArchive=true;
    indexBefore=fs.readFileSync(path.join(ROOT,'index.html'));manifestBefore=fs.existsSync(ICON_MANIFEST)?fs.readFileSync(ICON_MANIFEST):null;
    await downloadIcon(job); job.stage = 'Updating launcher'; updateLauncher(job); assignIcon(job);
    fs.rmSync(stageJob,{recursive:true,force:true});stageJob='';
    job.status = 'complete'; job.stage = 'Complete'; log(job, `Complete: ${job.files} files, ${job.archive}`);
  } catch (error) {
    if(indexBefore)fs.writeFileSync(path.join(ROOT,'index.html'),indexBefore);if(manifestBefore)fs.writeFileSync(ICON_MANIFEST,manifestBefore);
    const livePackage=path.join(ROOT,job.slug),archivePath=path.join(ROOT,`${job.slug}-assets.zip`);
    if(promotedPackage&&fs.existsSync(livePackage))fs.rmSync(livePackage,{recursive:true,force:true});if(backupPackage&&fs.existsSync(backupPackage))fs.renameSync(backupPackage,livePackage);
    if(promotedArchive&&fs.existsSync(archivePath))fs.unlinkSync(archivePath);if(backupArchive&&fs.existsSync(backupArchive))fs.renameSync(backupArchive,archivePath);
    if(stageJob&&fs.existsSync(stageJob))fs.rmSync(stageJob,{recursive:true,force:true});
    const failureStage = job.stage;
    job.status = 'failed'; job.stage = 'Failed'; job.error = error.message; log(job, `ERROR: ${error.message}`);
    if (job.managementSession) await launcherRequest(job.managementSession, '/api/admin/report', 'POST', { level: 'error', source: 'game-importer', message: error.message, details: { jobId: job.id, url: job.url, slug: job.slug, gameKey: job.key || null, stage: failureStage } }).catch(reportError => log(job, `Problem report delivery failed: ${reportError.message}`));
  }
  await saveImporterJob(storedJob(job));
  emit('job', publicJob(job));
}

function createJob(parsed, options = {}) {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ...parsed, status: 'queued', stage: options.iconOnly ? 'Queued · icon only' : options.profileOnly ? 'Queued · local profile' : options.reservoirOnly ? 'Queued · reservoir' : 'Queued', logs: [], error: '', key: '', title: '', assetKey: '', icon: '', iconUrl: '', iconOnly: Boolean(options.iconOnly), profileOnly: Boolean(options.profileOnly), reservoirOnly: Boolean(options.reservoirOnly), archive: '', files: 0, protocolCapture: '', profile: '', reservoir: '', overwrite: Boolean(options.overwrite), captureSeconds: Math.min(300, Math.max(15, Number(options.captureSeconds) || 60)), captureSpins: Math.min(50000, Math.max(1, Number(options.captureSpins) || 5000)), managementSession: options.managementSession || null };
}

function existingCaptureUrls() {
  const found = new Map();
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const readme = path.join(ROOT, entry.name, 'README.md'); if (!fs.existsSync(readme)) continue;
    const contents = fs.readFileSync(readme, 'utf8'), match = contents.match(/Product page:\s*`(https:\/\/egt-digital\.com\/game\/[a-z0-9-]+\/?)`/i);
    if (!match) continue;
    try { const parsed = validateProductUrl(match[1]), keyMatch = contents.match(/gameKey=([A-Za-z0-9_-]+)/); found.set(parsed.url, { ...parsed, expectedKey: keyMatch?.[1] || '' }); } catch {}
  }
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

async function drain() {
  if (running) return; running = true;
  while (true) {
    const job = jobs.find(item => item.status === 'queued');
    if (!job) break;
    await processJob(job);
  }
  running = false;
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(ROOT, 'game-importer.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    try { managementSession(req); } catch(error) { return sendJson(res,error.status||401,{error:error.message}); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/management/login') {
    try {
      const input = await readBody(req); const response = await fetch(`${LAUNCHER_API}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || 'Login failed'), { status: response.status });
      if (!result.user?.root) throw Object.assign(new Error('Root administrator account required'), { status: 403 });
      const launcherCookie=response.headers.get('set-cookie').split(';')[0]; const elevation=await fetch(`${LAUNCHER_API}/api/admin/authorize`,{method:'POST',headers:{cookie:launcherCookie,'x-csrf-token':result.csrf,'content-type':'application/json'},body:JSON.stringify({adminPassword:input.password})});
      if(!elevation.ok) throw Object.assign(new Error('Play Config authorization failed'),{status:elevation.status});
      const token = require('crypto').randomBytes(32).toString('base64url'); managementSessions.set(token, { cookie: launcherCookie, csrf: result.csrf, expiresAt: Date.now() + 15 * 60 * 1000 });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': `importer_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`, 'cache-control': 'no-store' }); return res.end(JSON.stringify({ user: result.user }));
    } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/management/logout') {
    const token = requestCookies(req).importer_admin; if (token) managementSessions.delete(token); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'importer_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); return res.end('{"ok":true}');
  }
  if (url.pathname === '/api/management/state' && req.method === 'GET') {
    try { return sendJson(res, 200, await launcherRequest(managementSession(req), '/api/catalog-admin')); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  }
  if (url.pathname === '/api/management/catalog' && req.method === 'POST') {
    try { return sendJson(res, 200, await launcherRequest(managementSession(req), '/api/catalog', 'POST', await readBody(req))); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  }
  const catalogMatch = url.pathname.match(/^\/api\/management\/catalog\/([A-Za-z0-9_-]+)$/);
  if (catalogMatch && ['POST', 'DELETE'].includes(req.method)) {
    try { return sendJson(res, 200, await launcherRequest(managementSession(req), `/api/catalog/${catalogMatch[1]}`, req.method, req.method === 'POST' ? await readBody(req) : undefined)); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') { try{managementSession(req);return sendJson(res,200,jobs.map(publicJob))}catch(error){return sendJson(res,error.status||401,{error:error.message})} }
  if (req.method === 'GET' && url.pathname === '/health') { const health={ok:true,running,queued:jobs.filter(job=>job.status==='queued').length,shuttingDown};if(url.searchParams.get('deep')==='1'){const disk=fs.statfsSync(ROOT),started=Date.now();try{await pool.query('SELECT 1');const launcher=await fetch(`${LAUNCHER_API}/health?deep=1`,{signal:AbortSignal.timeout(5000)});health.database={ok:true,latencyMs:Date.now()-started};health.launcher={ok:launcher.ok,status:launcher.status};health.playwright={ok:fs.existsSync('/tmp/egt-browser/node_modules/playwright')};health.disk={availableBytes:disk.bavail*disk.bsize,totalBytes:disk.blocks*disk.bsize};health.ok=health.launcher.ok&&health.playwright.ok}catch(error){health.ok=false;health.error=error.message}}return sendJson(res,health.ok?200:503,health); }
  if (req.method === 'POST' && url.pathname === '/api/discover') {
    try {
      managementSession(req);
      const body = await readBody(req);
      const result = await discoverLinks(String(body.url || '')), limit = body.limit === 50 ? 50 : 0;
      return sendJson(res, 200, discoveryBatch(result, limit));
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/icons/backfill') {
    try {
      const session = managementSession(req);
      const existing = existingCaptureUrls(), active = new Set(jobs.filter(job => ['queued','running'].includes(job.status) && job.iconOnly).map(job => job.url));
      const created = existing.filter(parsed => !active.has(parsed.url)).map(parsed => createJob(parsed, { iconOnly: true, managementSession: session }));
      jobs.push(...created); emit('queue', jobs.map(publicJob)); drain(); return sendJson(res, 202, { queued: created.length, totalExisting: existing.length, jobs: created.map(publicJob) });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/profiles/backfill') {
    try {
      const session = managementSession(req), body = await readBody(req);
      const existing = existingCaptureUrls(), active = new Set(jobs.filter(job => ['queued','running'].includes(job.status) && job.profileOnly).map(job => job.url));
      const created = existing.filter(parsed => !active.has(parsed.url)).map(parsed => createJob(parsed, { profileOnly: true, captureSeconds: body.captureSeconds, managementSession: session }));
      jobs.push(...created); emit('queue', jobs.map(publicJob)); drain(); return sendJson(res, 202, { queued: created.length, totalExisting: existing.length, jobs: created.map(publicJob) });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
    try { managementSession(req); } catch(error) { return sendJson(res,error.status||401,{error:error.message}); }
    const name = path.basename(decodeURIComponent(url.pathname.slice('/download/'.length)));
    if (!/^[a-z0-9-]+-assets\.zip$/.test(name)) return sendJson(res, 400, { error: 'Invalid archive name' });
    const archive = path.join(ROOT, name);
    if (!fs.existsSync(archive)) return sendJson(res, 404, { error: 'Archive not found' });
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'content-length': fs.statSync(archive).size });
    return fs.createReadStream(archive).pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/import') {
    try {
      const session = managementSession(req);
      const body = await readBody(req);
      const inputs = String(body.urls || '').split(/\s+/).filter(Boolean);
      if (!inputs.length || inputs.length > 50) throw new Error('Provide between 1 and 50 URLs');
      const created = inputs.map(input => { const job = createJob(validateProductUrl(input), { overwrite: body.overwrite, captureSeconds: body.captureSeconds, captureSpins: body.captureSpins, iconOnly: body.iconOnly, reservoirOnly: body.reservoirOnly, managementSession: session }); jobs.push(job); return publicJob(job); });
      emit('queue', jobs.map(publicJob)); drain(); return sendJson(res, 202, created);
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  sendJson(res, 404, { error: 'Not found' });
});

async function start(){for(const saved of await loadImporterJobs()){if(['running','queued'].includes(saved.status)){saved.status='queued';saved.stage='Recovered after restart'}jobs.push(saved)}server.listen(PORT,'0.0.0.0',()=>console.log(`EGT importer GUI: http://0.0.0.0:${PORT}`));drain();setInterval(()=>pruneOperationalData().catch(()=>{}),6*60*60*1000).unref()}
if (require.main === module) start().catch(error=>{console.error(error);process.exit(1)});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(shuttingDown)return;shuttingDown=true;server.close(async()=>{for(const timer of jobSaveTimers.values())clearTimeout(timer);await Promise.all(jobs.map(job=>saveImporterJob(storedJob(job)).catch(()=>{})));await pool.end();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()});

module.exports = { findProductIcon, mine, downloadIcon, assignIcon, discoveryBatch, existingCaptureUrls };
