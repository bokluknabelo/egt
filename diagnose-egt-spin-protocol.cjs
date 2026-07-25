const { chromium } = require('/tmp/egt-browser/node_modules/playwright');

const gameKey = process.argv[2] || 'TSHSASlot';
const spins = Math.max(1, Math.min(50, Number(process.argv[3] || 12)));

function shape(value, depth = 0) {
  if (depth > 4) return typeof value;
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key, shape(child, depth + 1)]));
}

function decoded(payload) {
  if (typeof payload !== 'string') return null;
  try {
    const outer = JSON.parse(payload[0] === 'a' ? payload.slice(1) : payload);
    return Array.isArray(outer) ? outer.map(item => {
      if (typeof item !== 'string') return item;
      try { return JSON.parse(item); } catch { return item; }
    }) : outer;
  } catch { return null; }
}

(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  const frames = [];
  page.on('websocket', socket => {
    socket.on('framesent', event => frames.push({ direction: 'sent', payload: event.payload }));
    socket.on('framereceived', event => frames.push({ direction: 'received', payload: event.payload }));
  });
  await page.goto(`https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  for (let spin = 0; spin < spins; spin += 1) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(3500);
  }
  const applicationFrames = frames.map(frame => ({ ...frame, value: decoded(frame.payload) })).filter(frame => frame.value);
  const signatures = new Map();
  for (const frame of applicationFrames) {
    const signature = JSON.stringify(shape(frame.value));
    const record = signatures.get(signature) || { direction: frame.direction, count: 0, shape: shape(frame.value), sample: frame.value };
    record.count += 1; signatures.set(signature, record);
  }
  process.stdout.write(`${JSON.stringify({ gameKey, requestedSpins: spins, webSocketFrames: frames.length, applicationFrames: applicationFrames.length, signatures: [...signatures.values()] }, null, 2)}\n`);
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
