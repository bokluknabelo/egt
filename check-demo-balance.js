const { chromium } = require('/tmp/egt-browser/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      const text = String(payload);
      if (/balance|loadGame|session/i.test(text)) console.log(text.slice(0, 2000));
    });
  });
  await page.goto('http://23.26.4.217:8080/?gameKey=FSHBLSlot&balance=50000&units=100', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(12000);
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
