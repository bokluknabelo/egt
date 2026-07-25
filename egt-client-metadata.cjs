const fs = require('fs');
const path = require('path');

let cache;
function metadataIndex() {
  if (cache) return cache;
  const filename = path.join(__dirname, 'data', 'egt-client-math-metadata.json');
  try { cache = JSON.parse(fs.readFileSync(filename, 'utf8')).titles || {}; }
  catch { cache = {}; }
  return cache;
}

function clientMathMetadata(gameKey) {
  return metadataIndex()[gameKey] || null;
}

module.exports = { clientMathMetadata, metadataIndex };
