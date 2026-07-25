const { classifyFamily, freeSpinRules, reelCount, scatterEligibleReels, scatterSymbols, symbolRoles, titleRules } = require('./egt-family-engines.cjs');
const { screenCountDistribution } = require('./egt-exact-math.cjs');
const { visibleRowCount } = require('./egt-fixed-reel-engine.cjs');
const { clientMathMetadata } = require('./egt-client-metadata.cjs');

function objectDistribution(distribution) {
  return Object.fromEntries([...distribution].map(([count, probability]) => [count, probability]));
}

function tailDistribution(distribution, minimum) {
  return Object.fromEntries([...distribution].filter(([count]) => count >= minimum).map(([count, probability]) => [count, probability]));
}

function hasFixedStrips(strips, reels) {
  return Array.isArray(strips) && strips.length === reels && strips.every(strip => Array.isArray(strip) && strip.length > 0);
}

function deriveFamilyMathSpec(profile) {
  const gameKey = profile.gameKey, family = classifyFamily(profile), reels = reelCount(profile), rows = visibleRowCount(profile);
  const roles = symbolRoles(profile), scatters = scatterSymbols(profile, gameKey), metadata = clientMathMetadata(gameKey);
  const baseStrips = profile.settings?.fakeReels, freeStrips = profile.settings?.freeSpinFakeReels;
  const gaps = [], featureModels = [];
  const allRuleText=Object.values(titleRules(gameKey)).join(' ');
  if (!hasFixedStrips(baseStrips, reels)) gaps.push('fixed base reel strips');
  const requiresPaylines=!['ways','ways-coin','ways-cascade','ways-or-cluster','buy-bonus-ways'].includes(family);
  if (requiresPaylines && !(metadata?.paylines?.length === Number(profile.settings?.lines || 0)) && Number(profile.settings?.lines || 0) > 0) gaps.push('authoritative payline paths');

  if (family === 'bell-link') {
    const coins = roles.coins.filter(symbol => symbol >= 100);
    if (!coins.length) gaps.push('Bell Link coin symbol identifiers');
    if (hasFixedStrips(baseStrips, reels) && coins.length) {
      const distribution = screenCountDistribution(baseStrips, coins, rows);
      featureModels.push({
        type: 'hold-and-spin', source: 'published-bell-link-family-rule', cells: reels * rows,
        triggerCount: 5, triggerDistribution: tailDistribution(distribution, 5),
        allCoinCountDistribution: objectDistribution(distribution), coinSymbols: coins, lives: 3,
      });
    }
    gaps.push('hold-and-spin landing probability', 'coin-value distribution', 'full-grid/jackpot awards', 'jackpot contribution');
  } else if (family === 'gods-kings-link') {
    const rules = freeSpinRules(gameKey), scatter = roles.scatter;
    if (scatter === null) gaps.push('free-spin scatter symbol');
    if (hasFixedStrips(baseStrips, reels) && scatter !== null) {
      const eligible = scatterEligibleReels(profile, scatter);
      const baseDistribution = screenCountDistribution(baseStrips, [scatter], rows, eligible);
      const model = {
        type: 'free-spins', source: 'client-rules-and-captured-strips', triggerCount: rules.triggerCount,
        initialSpins: rules.count, multiplier: rules.multiplier,
        triggerDistribution: tailDistribution(baseDistribution, rules.triggerCount),
        baseScatterCountDistribution: objectDistribution(baseDistribution),
      };
      if (hasFixedStrips(freeStrips, reels)) {
        const retriggerDistribution = screenCountDistribution(freeStrips, [scatter], rows, eligible);
        model.retriggerDistribution = tailDistribution(retriggerDistribution, rules.triggerCount);
        model.freeScatterCountDistribution = objectDistribution(retriggerDistribution);
      } else gaps.push('fixed free-spin reel strips');
      featureModels.push(model);
    }
    gaps.push('free-spin per-spin exact RTP', 'Feature Chance mathematics', 'Gods & Kings jackpot contribution');
  } else if (family === 'ways-cascade') {
    featureModels.push({ type: 'cascade', source: 'client-rules-pending-transition-math' });
    gaps.push('cascade refill strips/probabilities', 'cascade termination and multiplier rules');
    const ruleText=Object.values(titleRules(gameKey)).join(' ');
    if (/FREE SPINS/i.test(ruleText))gaps.push('free-spin trigger, retrigger, alternate reels and multiplier-symbol distributions');
    if ((profile.settings?.feature||[]).includes('MYSTERY_JACKPOT'))gaps.push('jackpot contribution');
  } else if (family === 'ways') {
    if (gameKey === 'SUCSlot') {
      featureModels.push({ type: 'all-reels-symbol-multiplier', source: 'client-rule' });
      gaps.push('all-reels x2 multiplier exact contribution');
    }
  } else if (family === 'ways-coin') {
    featureModels.push({ type: 'coin-feature', source: 'captured-settings-pending' });
    gaps.push('coin-feature activation and award distribution');
    if ((profile.settings?.feature||[]).includes('MYSTERY_JACKPOT'))gaps.push('jackpot contribution');
    if (gameKey === 'SUCSlot') gaps.push('all-reels x2 multiplier exact contribution');
  } else if (family === 'ways-or-cluster') {
    featureModels.push({ type: 'ways-or-cluster', source: 'title-client-rules-pending' });
    gaps.push('authoritative win topology', 'feature transition mathematics');
  } else if (family.startsWith('buy-bonus')) {
    featureModels.push({ type: 'buy-bonus', source: 'title-client-rules-pending' });
    gaps.push('base-to-feature trigger distribution', 'purchased feature distribution');
  } else if (family === 'classic-lines-coin') {
    featureModels.push({ type: 'coin-feature', source: 'captured-settings-pending' });
    gaps.push('coin-feature activation and award distribution', 'jackpot contribution');
  } else if ((profile.settings?.feature || []).some(feature => /JACKPOT/i.test(feature))) {
    gaps.push('jackpot contribution');
  }
  if (/FREE SPINS/i.test(allRuleText) && !featureModels.some(model => model.type === 'free-spins')) gaps.push('free-spin trigger, reel, retrigger and award mathematics');

  return Object.freeze({
    gameKey, family, reels, rows, lines: Number(profile.settings?.lines || profile.settings?.linesOptions?.[0] || 0),
    clientConfiguredRtp: Number(profile.settings?.clientSettings?.configuredRtp || 0) / 100,
    roles, scatters, baseStripsReady: hasFixedStrips(baseStrips, reels),
    clientMetadataReady: Boolean(metadata?.symbolsAuthoritative), paylinesReady: !requiresPaylines || Number(profile.settings?.lines || 0) === 0 || metadata?.paylines?.length === Number(profile.settings?.lines || 0),
    featureModels: Object.freeze(featureModels), gaps: Object.freeze([...new Set(gaps)]), featureMathComplete: gaps.length === 0,
  });
}

module.exports = { deriveFamilyMathSpec, hasFixedStrips, objectDistribution, tailDistribution };
