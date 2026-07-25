const { chromium } = require('/tmp/egt-browser/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', message => {
    if (message.text().includes('BALANCE_PATCH')) console.log('CONSOLE', message.text());
  });
  page.on('request', request => {
    if (request.isNavigationRequest()) console.log('NAV', request.url());
  });
  page.on('pageerror', error => console.log('ERROR', error.message));
  await page.goto('http://23.26.4.217:8080/', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/egt/40-super-hot-bell-link/live-balance.png', fullPage: true });
  console.log('FINAL', page.url());
  for (const frame of page.frames()) console.log('FRAME', frame.url());
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
