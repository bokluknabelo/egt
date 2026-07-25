const fs = require('fs');
const path = require('path');
const { EgtLocalSession, ordinarySymbols, weightedPaytable } = require('./egt-local-engine.cjs');

const directory = path.join(__dirname, 'data', 'egt-profiles');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
const results = [];

for (const filename of files) {
  const gameKey = filename.slice(0, -5), profile = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
  const factor = Number(profile.settings?.factor || profile.settings?.factors?.[0] || 1);
  const symbols = ordinarySymbols(profile), distribution = weightedPaytable(profile, factor);
  let seed = [...gameKey].reduce((value, character) => ((value * 33) ^ character.charCodeAt(0)) >>> 0, 5381);
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const engine = new EgtLocalSession({ profile, gameKey, balanceUnits: 1e12, targetRtp: 96, random });
  const spins = 10000, payouts = new Set(), winningSymbols = new Set(), grids = new Set();
  let returned = 0, hits = 0, repeats = 0, previous = '';
  for (let spin = 0; spin < spins; spin += 1) {
    const outcome = engine.syntheticOutcome(100, { factor });
    returned += outcome.totalWin;
    const frame = outcome.spins?.at(-1) || outcome.spin, grid = JSON.stringify(frame?.reels || []);
    grids.add(grid); if (grid === previous) repeats += 1; previous = grid;
    if (outcome.totalWin > 0) { hits += 1; payouts.add(outcome.totalWin / 100); winningSymbols.add((outcome.spin || outcome.spins?.[0])?.entries?.[0]?.symbol); }
  }
  const expectedHitRate = Math.min(1, 0.96 / distribution.mean), measuredRtp = returned / spins;
  const problems = [];
  if (symbols.length < 5) problems.push(`only ${symbols.length} ordinary symbols`);
  if (distribution.groups.length < 2) problems.push('only one payout group');
  if (distribution.groups.length >= 3 && payouts.size < 2) problems.push('simulated payouts did not vary');
  if (repeats) problems.push(`${repeats} consecutive repeated grids`);
  if (grids.size < 9500) problems.push(`only ${grids.size}/${spins} unique grids`);
  if (Math.abs(measuredRtp - 96) > 10) problems.push(`measured RTP ${measuredRtp.toFixed(2)}%`);
  results.push({ gameKey, symbols: symbols.length, payoutGroups: distribution.groups.length, payoutRange: [Math.min(...distribution.groups.map(group => group.multiple)), Math.max(...distribution.groups.map(group => group.multiple))], theoreticalRtp: +(expectedHitRate * distribution.mean * 100).toFixed(6), expectedHitRate: +(expectedHitRate * 100).toFixed(2), measuredRtp: +measuredRtp.toFixed(2), measuredHitRate: +(hits / spins * 100).toFixed(2), observedPayouts: [...payouts].sort((a,b) => a-b), winningSymbols: [...winningSymbols].sort((a,b) => a-b), uniqueGrids: grids.size, problems });
}

const failures = results.filter(result => result.problems.length);
process.stdout.write(`${JSON.stringify({ profiles: results.length, passed: results.length - failures.length, failed: failures.length, failures, eith: results.find(result => result.gameKey === 'EITHSlot') }, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
