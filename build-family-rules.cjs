const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { inventoryProfiles } = require('./egt-family-engines.cjs');

const files = execFileSync('rg', ['--files', '-g', 'en.json', '-g', '!node_modules/**'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
const byGameKey = new Map();
const bySlug = new Map();
for (const file of files) {
  const match = file.match(/\/extracted\/assets\/([^/]+)\/translations\/en\.json$/);
  if (match && !byGameKey.has(match[1])) byGameKey.set(match[1], file);
  const slugMatch = file.match(/^([^/]+)\/extracted\/assets\/([^/]+)\/translations\/en\.json$/);
  if (slugMatch && !['commons','gamble','jackpot','jackpot-stats','freespin'].includes(slugMatch[2]) && !bySlug.has(slugMatch[1])) bySlug.set(slugMatch[1], file);
}
const migration = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'egt-migration-queue.json'), 'utf8'));
const slugByGameKey = new Map((Array.isArray(migration) ? migration : migration.titles || migration.games || migration.queue || []).map(item => [item.gameKey, item.slug]));

function plain(value) { return String(value).replace(/<[^>]*>/g, ' ').replace(/##[^#]+##/g, '…').replace(/\s+/g, ' ').trim(); }
function relevantRules(file) {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => /PAYTABLE\.(?:WILD|SCATTER|RULES|FREE|WAYS|TOPPLING|CASCADE|BONUS)|FREE.?SPIN|HOLD.?SPIN/i.test(`${key} ${value}`)).map(([key, value]) => [key, plain(value)]));
}
function siblingKey(gameKey) {
  const candidates = [gameKey.replace(/HR(?=Slot$)/, 'Slot'), gameKey.replace(/HRSlot$/, 'Slot')];
  return candidates.find(candidate => byGameKey.has(candidate)) || null;
}

const titles = inventoryProfiles().map(title => {
  const direct = byGameKey.get(title.gameKey), slugSource = bySlug.get(slugByGameKey.get(title.gameKey)), inheritedFrom = direct || slugSource ? null : siblingKey(title.gameKey), file = direct || slugSource || (inheritedFrom && byGameKey.get(inheritedFrom));
  return { gameKey: title.gameKey, family: title.family, source: file || null, inheritedFrom, sourceAlias: !direct && slugSource ? path.basename(path.dirname(path.dirname(slugSource))) : null, rules: file ? relevantRules(file) : {} };
});
const output = {
  generatedAt: new Date().toISOString(), titleCount: titles.length,
  directRuleSources: titles.filter(title => title.source && !title.inheritedFrom).length,
  inheritedRuleSources: titles.filter(title => title.inheritedFrom).length,
  missingRuleSources: titles.filter(title => !title.source).map(title => title.gameKey), titles,
};
const target = path.join(__dirname, 'data', 'egt-family-rules.json');
fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ target, titleCount: output.titleCount, directRuleSources: output.directRuleSources, inheritedRuleSources: output.inheritedRuleSources, missingRuleSources: output.missingRuleSources })}\n`);
