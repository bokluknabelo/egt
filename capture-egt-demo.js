const { chromium } = require('/tmp/egt-browser/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const gameKey = process.argv[2] || 'FSHBLSlot';
const outputName = process.argv[3] || '40-super-hot-bell-link';
const captureWaitMs = Math.max(5000, Number(process.env.CAPTURE_WAIT_MS || process.argv[4] || 20000));
const outputDir = path.resolve('/egt', outputName);
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  console.log('launching');
  const browser = await chromium.launch({ headless: true });
  console.log('launched');
  const context = await browser.newContext({
    recordHar: { path: path.join(outputDir, 'network.har'), content: 'embed' },
    viewport: { width: 1365, height: 768 },
  });
  const page = await context.newPage();
  const urls = new Set();
  const saveUrls = () => fs.writeFileSync(path.join(outputDir, 'urls.txt'), [...urls].sort().join('\n') + '\n');
  page.on('response', response => { urls.add(response.url()); saveUrls(); });
  page.on('console', message => console.log('browser:', message.type(), message.text()));
  page.on('pageerror', error => console.error('page:', error.message));
  console.log('navigating');
  await page.goto(`https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  console.log('loaded');
  await page.waitForTimeout(captureWaitMs);
  saveUrls();
  console.log(`captured ${urls.size}`);
  await context.close();
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
