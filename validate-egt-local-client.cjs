const fs = require('fs');
const path = require('path');
const { chromium, firefox } = require('/tmp/egt-browser/node_modules/playwright');
const { EgtLocalSession, sockJsDecode } = require('./egt-local-engine.cjs');

const gameKey = process.argv[2] || 'TSHSASlot';
const validateReconnect = process.env.VALIDATE_RECONNECT === '1';
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'egt-profiles', `${gameKey}.json`), 'utf8'));

(async () => {
  const browserType = process.env.PLAYWRIGHT_BROWSER === 'firefox' ? firefox : chromium;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE || (browserType === firefox ? process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) || undefined;
  const browser = await browserType.launch({ executablePath, headless: true, chromiumSandbox: false, args: ['--no-sandbox'] });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 768 },
    userAgent: process.env.PLAYWRIGHT_USER_AGENT || undefined,
  });
  const events = [], errors = [], ignoredErrors = [];
  page.on('pageerror', error => { const value = error.stack || error.message; (/generateLineBtnLable/.test(value) ? ignoredErrors : errors).push(value); });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const value = message.text();
    if (/NO GAME MODE FOUND: DOUBLE_CHANCE/.test(value)) return;
    errors.push(`${value}${message.location()?.url ? ` @ ${message.location().url}:${message.location().lineNumber}` : ''}`);
  });
  if (process.env.PLAYWRIGHT_SPOOF_CHROME === '1') await page.addInitScript(() => {
    const define = (target, key, value) => {
      try { Object.defineProperty(target, key, { get: () => value, configurable: true }); } catch {}
    };
    define(navigator, 'vendor', 'Google Inc.');
    define(navigator, 'platform', 'Linux x86_64');
    define(navigator, 'userAgentData', {
      brands: [{ brand: 'Chromium', version: '149' }, { brand: 'Google Chrome', version: '149' }, { brand: 'Not A(Brand', version: '24' }],
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues: async () => ({ brands: [{ brand: 'Chromium', version: '149' }, { brand: 'Google Chrome', version: '149' }], fullVersionList: [{ brand: 'Chromium', version: '149.0.0.0' }, { brand: 'Google Chrome', version: '149.0.0.0' }], platform: 'Linux', platformVersion: '6.0.0', architecture: 'x86', model: '', mobile: false }),
    });
    window.chrome ||= { runtime: {} };
  });
  await page.route(/game-server-demo\.egt-ong\.com\/game-websocket\/info(?:\?|$)/, route => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=UTF-8',
    headers: { 'access-control-allow-origin': 'https://games.egt-ong.com', 'access-control-allow-credentials': 'true' },
    body: JSON.stringify({ websocket: true, cookie_needed: false, origins: ['*:*'], entropy: 123456789 }),
  }));
  let engine, connections = 0;
  await page.routeWebSocket(/game-server-demo\.egt-ong\.com\/game-websocket\//, socket => {
    connections += 1;
    engine ||= new EgtLocalSession({ profile, gameKey, balanceUnits: 5000000, targetRtp: 95, random: () => 0, featurePreference: process.env.VALIDATE_FEATURE_TYPE || '' });
    socket.send('o');
    socket.onMessage(message => {
      for (const request of sockJsDecode(message)) events.push({ direction: 'client', event: request.event, id: request.id });
      for (const response of engine.messages(message)) { for (const value of sockJsDecode(response)) events.push({ direction: 'local', event: value.event, state: value.state, matchId: value.game?.state?.matchId, referenceId: value.referenceId }); socket.send(response); }
    });
  });
  await page.goto(`https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  await page.mouse.click(680, 380);
  for (let spin = 0; spin < 4; spin += 1) {
    await page.keyboard.press('Space'); await page.waitForTimeout(3500);
    if (!events.some(item => item.direction === 'client' && item.event === 'bet')) {
      await page.keyboard.press('Enter'); await page.waitForTimeout(800);
      for (const [x, y] of [[1200,270],[1275,340]]) { await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(180); await page.mouse.up(); await page.waitForTimeout(1800); }
    }
  }
  if (validateReconnect) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForTimeout(8000); }
  fs.mkdirSync(path.join(__dirname, 'output', 'playwright'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, 'output', 'playwright', `${gameKey}-local-engine.png`) });
  const loads = events.filter(item => item.direction === 'local' && item.event === 'loadGame'), bets = events.filter(item => item.direction === 'local' && item.event === 'bet');
  const result = { gameKey, connections, reconnectRestored: validateReconnect ? Boolean(loads[1]?.matchId && loads[1].matchId === bets.at(-1)?.matchId && loads[1].state === bets.at(-1)?.state) : undefined, loadRequests: events.filter(item => item.direction === 'client' && item.event === 'loadGame').length, betRequests: events.filter(item => item.direction === 'client' && item.event === 'bet').length, localResponses: events.filter(item => item.direction === 'local').length, events, errors: errors.slice(0, 20), ignoredErrors: ignoredErrors.slice(0, 20) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setTimeout(() => process.exit(process.exitCode || 0), 4000).unref();
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  if ((!validateReconnect && result.loadRequests !== 1) || (validateReconnect && (result.loadRequests < 2 || connections < 2 || !result.reconnectRestored)) || result.betRequests < 1) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
