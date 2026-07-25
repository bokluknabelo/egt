const { buildMathConfiguration } = require('./egt-math-configs.cjs');
const { exactBaseGameMath } = require('./egt-exact-math.cjs');

function seededInteger(seed = 0x53544b45) {
  let state = seed >>> 0;
  return max => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state % max;
  };
}

function tunableSymbols(profile, roles, scatters) {
  const excluded = new Set([roles.wild, ...roles.coins, ...scatters].filter(value => value !== null).map(Number));
  return Object.keys(profile.settings?.paytable || {}).map(Number).filter(Number.isFinite).filter(symbol => !excluded.has(symbol));
}

// Deterministic coordinate descent inspired by StakeEngine's offline optimizer.
// It changes only ordinary-symbol stop assignments: strip lengths, special
// symbols, feature positions and runtime RNG remain untouched.
function optimizeReelConfiguration({ profile, paylines, targetRtp, factor, seed, maxIterations = 2000, tolerance = 0.0002 }) {
  const initial = buildMathConfiguration(profile, paylines, targetRtp);
  const symbols = tunableSymbols(profile, initial.roles, initial.scatters);
  if (symbols.length < 2) throw new Error(`${profile.gameKey} has insufficient ordinary symbols to optimize`);
  const strips = structuredClone(initial.strips), original = structuredClone(initial.strips), randomInt = seededInteger(seed ?? Number.parseInt(initial.versionHash.slice(0, 8), 16));
  const mutablePositions = strips.map(strip => strip.map((symbol, index) => symbols.includes(symbol) ? index : -1).filter(index => index >= 0));
  const evaluate = candidate => {
    const copy = structuredClone(profile); copy.settings.fakeReels = candidate;
    const config = buildMathConfiguration(copy, paylines, targetRtp);
    return { config, math: exactBaseGameMath(config, factor) };
  };
  let current = evaluate(strips), iterations = 0;
  for (; iterations < maxIterations && Math.abs(current.math.rtp - targetRtp / 100) > tolerance; iterations += 1) {
    const reel = randomInt(strips.length), positions = mutablePositions[reel];
    if (!positions.length) continue;
    const position = positions[randomInt(positions.length)], previous = strips[reel][position], replacement = symbols[randomInt(symbols.length)];
    if (replacement === previous) continue;
    strips[reel][position] = replacement;
    const candidate = evaluate(strips);
    if (Math.abs(candidate.math.rtp - targetRtp / 100) < Math.abs(current.math.rtp - targetRtp / 100)) current = candidate;
    else strips[reel][position] = previous;
  }
  const changes = strips.reduce((sum, strip, reel) => sum + strip.reduce((count, symbol, stop) => count + (symbol !== original[reel][stop]), 0), 0);
  return { ...current, iterations, changes, converged: Math.abs(current.math.rtp - targetRtp / 100) <= tolerance };
}

module.exports = { optimizeReelConfiguration, seededInteger, tunableSymbols };
