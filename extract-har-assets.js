const fs = require('fs');
const path = require('path');

const outputName = process.argv[2] || '40-super-hot-bell-link';
const packageRoot = path.resolve('/egt', outputName);
const harPath = path.join(packageRoot, 'network.har');
const outputRoot = path.join(packageRoot, 'extracted');
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
let extracted = 0;

for (const entry of har.log.entries) {
  const requestUrl = new URL(entry.request.url);
  if (requestUrl.hostname !== 'games.egt-ong.com' || entry.response.status !== 200) continue;
  const content = entry.response.content || {};
  if (content.text === undefined) continue;

  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';
  const destination = path.join(outputRoot, pathname.replace(/^\/+/, ''));
  if (!destination.startsWith(outputRoot + path.sep)) continue;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const body = content.encoding === 'base64'
    ? Buffer.from(content.text, 'base64')
    : Buffer.from(content.text, 'utf8');
  fs.writeFileSync(destination, body);
  extracted++;
}

console.log(`Extracted ${extracted} responses to ${outputRoot}`);
