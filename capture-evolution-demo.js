const { chromium } = require('/tmp/egt-browser/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const productUrl = process.argv[2] || 'https://games.evolution.com/first-person/first-person-lightning-roulette/';
const outputName = process.argv[3] || 'first-person-lightning-roulette';
const waitMs = Math.max(10000, Number(process.argv[4] || 30000));
const outputDir = path.resolve('/egt', outputName);
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    recordHar: { path: path.join(outputDir, 'network.har'), content: 'embed' },
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  const urls = new Set();
  page.on('response', response => urls.add(response.url()));
  page.on('console', message => console.log('browser:', message.type(), message.text()));
  page.on('pageerror', error => console.error('page:', error.message));
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const age = page.getByRole('button', { name: 'Yes, I am 21+' });
  if (await age.isVisible().catch(() => false)) await age.click();
  await page.getByRole('button', { name: 'Launch game' }).click();
  await page.waitForResponse(response => response.url().includes('/config?table_id=rng-rt-lightning') && response.status() === 200, { timeout: 90000 });
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: path.join(outputDir, 'capture.png'), fullPage: false });
  fs.writeFileSync(path.join(outputDir, 'urls.txt'), `${[...urls].sort().join('\n')}\n`);
  await context.close();
  await browser.close();
  console.log(`Captured ${urls.size} requests to ${outputDir}`);
})().catch(error => { console.error(error); process.exit(1); });
