const fs = require('fs');
const path = require('path');
const { chromium } = require('/tmp/egt-browser/node_modules/playwright');

const gameKey = process.argv[2];
const output = process.argv[3];
const captureMs = Math.max(15000, Math.min(300000, Number(process.argv[4]) || 60000));
const huntFeatures = process.env.EGT_CAPTURE_FEATURES === '1';
if (!gameKey || !/^[A-Za-z0-9_-]+$/.test(gameKey) || !output) throw new Error('Usage: capture-egt-protocol.cjs GAME_KEY OUTPUT [MILLISECONDS]');

function decode(payload) {
  if (typeof payload !== 'string' || ['o', 'h', 'c'].includes(payload[0])) return [];
  try {
    const outer = JSON.parse(payload[0] === 'a' ? payload.slice(1) : payload);
    return (Array.isArray(outer) ? outer : [outer]).map(value => typeof value === 'string' ? JSON.parse(value) : value);
  } catch { return []; }
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  const startedAt = new Date().toISOString(), messages = [], connections = [];
  let connection = 0;
  page.on('websocket', socket => {
    const connectionId = ++connection;
    connections.push({ connectionId, url: socket.url(), openedAtMs: Date.now() });
    const record = direction => frame => {
      for (const message of decode(frame.payload)) messages.push({ sequence: messages.length + 1, atMs: Date.now(), connectionId, direction, event: message?.event || null, message });
    };
    socket.on('framesent', record('client'));
    socket.on('framereceived', record('server'));
    socket.on('close', () => { const item = connections.find(value => value.connectionId === connectionId); if (item) item.closedAtMs = Date.now(); });
  });
  const launch = async () => {
    await page.goto(`https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(7000);
  };
  await launch();
  if (huntFeatures) {
    await page.mouse.click(80, 280); await page.waitForTimeout(1800);
    await page.screenshot({ path: output.replace(/\.json$/i, '-feature-menu.png') });
    await page.mouse.click(680, 500); await page.waitForTimeout(2500);
    await page.mouse.click(680, 590); await page.waitForTimeout(5000);
  }
  const deadline = Date.now() + captureMs;
  let spins = 0;
  await page.mouse.click(680, 380);
  while (Date.now() < deadline) {
    await page.keyboard.press('Space'); spins += 1;
    await page.waitForTimeout(3200);
    if (spins % 3 === 0 && !messages.some(value => value.direction === 'client' && value.event === 'bet')) { await page.mouse.click(1200, 260); await page.waitForTimeout(1600); await page.mouse.click(1275, 340); await page.waitForTimeout(3200); }
    // A reload creates a second connection and records the server's restore/reconnect state.
    if (spins === 8 && Date.now() + 10000 < deadline) await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => page.waitForTimeout(7000));
  }
  const document = { schemaVersion: 2, gameKey, startedAt, completedAt: new Date().toISOString(), requestedCaptureMs: captureMs, spinsAttempted: spins, connections, messages };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, output);
  await browser.close();
  const serverEvents = [...new Set(messages.filter(value => value.direction === 'server').map(value => value.event).filter(Boolean))];
  console.log(JSON.stringify({ output, messages: messages.length, connections: connections.length, serverEvents }));
})().catch(error => { console.error(error); process.exitCode = 1; });
