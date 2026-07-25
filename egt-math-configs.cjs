const crypto = require('crypto');
const { classifyFamily, scatterEligibleReels, scatterSymbols, symbolRoles } = require('./egt-family-engines.cjs');
const { validateReelStrips, visibleRowCount } = require('./egt-fixed-reel-engine.cjs');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildMathConfiguration(profile, paylines, targetRtp = 48, options = {}) {
  const gameKey = profile.gameKey;
  if (!gameKey) throw new Error('profile gameKey is required');
  const strips = validateReelStrips(profile.settings?.fakeReels);
  const roles = symbolRoles(profile), scatters = scatterSymbols(profile, gameKey);
  const family = classifyFamily(profile);
  const body = {
    schemaVersion: 1,
    gameKey,
    family,
    evaluation: options.evaluation || (family === 'ways' || family === 'ways-coin' || family === 'ways-cascade' || family === 'buy-bonus-ways' ? 'ways' : 'paylines'),
    targetRtp: Number(targetRtp),
    source: options.source || 'captured-fixed-reels',
    baseGameOnly: options.featureMathComplete !== true,
    featureMathComplete: options.featureMathComplete === true,
    runtimeProtocolReady: options.runtimeProtocolReady === true,
    rows: visibleRowCount(profile),
    strips,
    paylines: structuredClone(paylines),
    paytable: structuredClone(profile.settings?.paytable || {}),
    roles: structuredClone(roles),
    scatters,
    scatterEligibleReels: Object.fromEntries(scatters.map(symbol => [symbol, scatterEligibleReels(profile, symbol)])),
    features: structuredClone(profile.settings?.feature || []),
    featureModels: structuredClone(options.featureModels || []),
    jackpotModel: structuredClone(options.jackpotModel || null),
  };
  const versionHash = crypto.createHash('sha256').update(canonical(body)).digest('hex');
  return deepFreeze({ ...body, versionHash });
}

function configurationOutcomeOptions(config) {
  return {
    strips: config.strips,
    roles: config.roles,
    scatters: config.scatters,
    paylines: config.paylines,
    evaluation: config.evaluation,
    eligibleReels: symbol => config.scatterEligibleReels[symbol] || [],
  };
}

module.exports = { buildMathConfiguration, canonical, configurationOutcomeOptions, deepFreeze };
