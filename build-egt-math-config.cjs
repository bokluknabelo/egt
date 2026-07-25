const fs = require('fs');
const path = require('path');
const { paylinesFor } = require('./egt-local-engine.cjs');
const { optimizeReelConfiguration } = require('./egt-reel-optimizer.cjs');
const { deriveFamilyMathSpec } = require('./egt-family-math-specs.cjs');

const gameKey = process.argv[2];
if (!gameKey) throw new Error('usage: node build-egt-math-config.cjs <gameKey> [targets] [iterations] [--base-only]');
const targets = String(process.argv[3] || '48,80,90,96').split(',').map(Number);
const maxIterations = Number(process.argv[4] || 2500);
const baseOnly = process.argv.includes('--base-only');
const profilePath = path.join(__dirname, 'data', 'egt-profiles', `${gameKey}.json`);
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const sample = profile.eventFamilies?.bet?.find(item => item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels || profile.settings?.reels;
if (!Array.isArray(sample) || !sample.length) throw new Error(`${gameKey} has no reel-window shape`);
const lineCount = Number(profile.settings?.lines || 0);
const familySpec = deriveFamilyMathSpec(profile);
const waysTopology = ['ways','ways-coin','ways-cascade','ways-or-cluster','buy-bonus-ways'].includes(familySpec.family);
const paylines = waysTopology ? [] : paylinesFor(profile, sample);
if (!waysTopology && paylines.length !== lineCount) throw new Error(`${gameKey} needs its authoritative ${lineCount}-line table before configuration generation`);
if (!baseOnly && !familySpec.featureMathComplete) throw new Error(`${gameKey} total-game configuration is incomplete: ${familySpec.gaps.join('; ')}. Use --base-only only for offline reel work.`);
const factor = Number(profile.settings?.factor || profile.settings?.factors?.[0] || lineCount || 1);
const configurations = {};
const failures = [];
for (const target of targets) {
  const result = optimizeReelConfiguration({ profile, paylines, targetRtp: target, factor, maxIterations, tolerance: 0.0002 });
  configurations[target] = { config: result.config, math: { ...result.math, totalRtp: null }, iterations: result.iterations, changes: result.changes, converged: result.converged };
  if (!result.converged) failures.push(`${target}% reached ${(result.math.rtp * 100).toFixed(6)}%`);
  process.stderr.write(`${gameKey}-${target}: ${(result.math.rtp * 100).toFixed(6)}% (${result.changes} stops, ${result.iterations} iterations)\n`);
}
if (failures.length) throw new Error(`${gameKey} configuration generation did not converge: ${failures.join('; ')}. No artifact was written.`);
const output = { schemaVersion: 2, generatedAt: new Date().toISOString(), gameKey, factor, artifactType: baseOnly ? 'base-game-lab' : 'complete-game', familySpec, configurations };
const directory = path.join(__dirname, 'data', 'egt-math-configs'); fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, `${gameKey}.json`), `${JSON.stringify(output, null, 2)}\n`);
