const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2] || '/tmp/egt-spin-protocol.json';
const capture = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const received = capture.signatures.filter(item => item.direction === 'received');
const load = received.find(item => item.sample?.[0]?.event === 'loadGame')?.sample?.[0];
const bet = received.find(item => item.sample?.[0]?.event === 'bet')?.sample?.[0];
if (!load || !bet) throw new Error('Capture must contain loadGame and bet responses');
const profile = {
  gameKey: capture.gameKey,
  capturedClientVersion: load.settings?.clientSettings?.configuredRtp || null,
  settings: load.settings,
  loadGameShape: { game: load.game, state: load.state, context: load.context || {}, jackpotStats: load.jackpotStats || [] },
  betShape: { game: bet.game, state: bet.state, context: bet.context || {} },
};
const outputDir = path.join(__dirname, 'data', 'egt-profiles');
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const output = path.join(outputDir, `${profile.gameKey}.json`);
fs.writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
console.log(output);
