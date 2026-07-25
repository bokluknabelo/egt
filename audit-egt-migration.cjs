const fs = require('fs');
const path = require('path');
const root = __dirname, profileDir = path.join(root, 'data', 'egt-profiles');
const profiles = fs.readdirSync(profileDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(profileDir, name), 'utf8')));
const queue = JSON.parse(fs.readFileSync(path.join(root, 'data', 'egt-migration-queue.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(root, 'data', 'egt-validation-report.json'), 'utf8'));
const failures = [];
if (profiles.length !== queue.titles.length) failures.push(`profile count ${profiles.length} != queue count ${queue.titles.length}`);
for (const title of queue.titles) if (title.status !== 'operational') failures.push(`${title.gameKey}: ${title.status}`);
for (const profile of profiles) {
  if (!profile.settings || !profile.loadGameShape?.game) failures.push(`${profile.gameKey}: incomplete load profile`);
  if (!profile.coverage?.events?.bet && profile.coverage?.outcomeSource !== 'synthesized-paytable') failures.push(`${profile.gameKey}: no outcome source`);
  if (!profile.loadGameShape?.jackpotStats?.length && !profile.settings?.feature?.includes('SG_JACKPOT')) failures.push(`${profile.gameKey}: no jackpot stats`);
}
const expectedFeatures = profiles.flatMap(profile => [profile.settings?.feature?.includes('SG_JACKPOT') ? `${profile.gameKey}:holdspin` : null, (profile.settings?.feature?.includes('BUY_BONUS') || profile.settings?.freeSpinFakeReels) ? `${profile.gameKey}:freespin` : null].filter(Boolean));
const validatedFeatures = new Set(report.featureResults.filter(result => !result.errors.length).map(result => `${result.gameKey}:${result.state}`));
for (const feature of expectedFeatures) if (!validatedFeatures.has(feature)) failures.push(`${feature}: feature browser validation missing`);
if (report.reconnectResults.length < 2 || report.reconnectResults.some(result => !result.restored || result.errors.length)) failures.push('base and active-feature reconnect validation required');
console.log(JSON.stringify({ ok: !failures.length, profiles: profiles.length, operational: queue.titles.filter(title => title.status === 'operational').length, featureValidated: validatedFeatures.size, reconnectValidated: report.reconnectResults.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
