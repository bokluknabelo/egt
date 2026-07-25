const fs = require('fs');
const path = require('path');
const { inventoryProfiles } = require('./egt-family-engines.cjs');

const titles = inventoryProfiles();
const families = Object.fromEntries([...Map.groupBy(titles, title => title.family)].map(([family, members]) => [family, {
  titleCount: members.length,
  bonusProtocolReady: members.every(member => member.bonusProtocolReady),
  titles: members.map(member => member.gameKey),
}]));
const manifest = { generatedAt: new Date().toISOString(), titleCount: titles.length, familyCount: Object.keys(families).length, families, titles };
const target = path.join(__dirname, 'data', 'egt-family-manifest.json');
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ target, titleCount: titles.length, familyCount: Object.keys(families).length })}\n`);
