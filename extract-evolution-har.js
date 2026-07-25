const fs = require('fs');
const path = require('path');

const outputName = process.argv[2] || 'first-person-lightning-roulette';
const packageRoot = path.resolve('/egt', outputName);
const outputRoot = path.join(packageRoot, 'extracted');
const allowedHosts = new Set(['games.evolution.com', 'showcase.evo-games.com', 'static.egcdn.com']);
const har = JSON.parse(fs.readFileSync(path.join(packageRoot, 'network.har'), 'utf8'));
let extracted = 0;

for (const entry of har.log.entries) {
  const requestUrl = new URL(entry.request.url);
  if (!allowedHosts.has(requestUrl.hostname) || entry.response.status !== 200) continue;
  const content = entry.response.content || {};
  if (content.text === undefined) continue;
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const destination = path.join(outputRoot, requestUrl.hostname, pathname.replace(/^\/+/, ''));
  if (!destination.startsWith(outputRoot + path.sep)) continue;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8'));
  extracted++;
}
console.log(`Extracted ${extracted} responses to ${outputRoot}`);
