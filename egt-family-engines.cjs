const fs = require('fs');
const path = require('path');
const { clientMathMetadata } = require('./egt-client-metadata.cjs');
let ruleIndex;
function titleRules(gameKey) {
  if (!ruleIndex) {
    try { const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'egt-family-rules.json'), 'utf8')); ruleIndex = new Map(data.titles.map(title => [title.gameKey, title.rules || {}])); }
    catch { ruleIndex = new Map(); }
  }
  return ruleIndex.get(gameKey) || {};
}
function freeSpinRules(gameKey) {
  const text = Object.values(titleRules(gameKey)).join(' ');
  const triggerCount = Number(text.match(/(\d+)\s+or more[^.]*trigger/i)?.[1] || 3);
  const count = Number(text.match(/trigger\s+(\d+)\s+FREE SPINS/i)?.[1] || text.match(/(\d+)\s+FREE SPINS/i)?.[1] || 0);
  const simpleMultiplier = text.match(/FREE SPINS wins are multiplied\s*x\s*(\d+)/i);
  const multiplier = Number(simpleMultiplier?.[1] || 1);
  return { triggerCount, count, multiplier, mode: simpleMultiplier ? 'simple-multiplier' : 'special' };
}

function reelCount(profile) {
  return profile.eventFamilies?.bet?.find(sample => sample.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels.length || (Array.isArray(profile.settings?.reels) ? profile.settings.reels.length : 0);
}

function scatterCountProbabilities(profile, scatter) {
  const strips = profile.settings?.fakeReels;
  if (!Array.isArray(strips) || !strips.length || scatter === null) return [1];
  let distribution = [1];
  for (const strip of strips) {
    const frequency = Array.isArray(strip) && strip.length ? strip.filter(value => Number(value) === Number(scatter)).length / strip.length : 0;
    const sample = profile.eventFamilies?.bet?.find(item=>item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels;
    const visibleRows = Math.max(1,Number(sample?.[distribution.length-1]?.length || 5)-2);
    const visibleProbability = 1 - (1 - frequency) ** visibleRows;
    const next = Array(distribution.length + 1).fill(0);
    distribution.forEach((probability, count) => { next[count] += probability * (1 - visibleProbability); next[count + 1] += probability * visibleProbability; });
    distribution = next;
  }
  return distribution;
}

function scatterCoefficient(profile, scatter, count) {
  const coefficients = profile.settings?.paytable?.[scatter]?.coef || [];
  const maximumCount = Math.max(1, scatterEligibleReels(profile, scatter).length);
  const minimumCount = Math.max(1, maximumCount - coefficients.length + 1);
  return Number(coefficients[count - minimumCount] || 0);
}

function classifyFamily(profile) {
  const settings = profile.settings || {};
  const gameKey=profile.gameKey||settings.gameKey||'';
  const features = new Set(settings.feature || []);
  const reels = reelCount(profile);
  const lines = Number(settings.lines || settings.linesOptions?.[0] || 0);
  const rules = titleRules(profile.gameKey || settings.gameKey || '');
  const hasToppling = Object.entries(rules).some(([key,value]) => /TOPPLING_(?:DESC|REELS)$/i.test(key) && /winning symbols disappear|toppling reels/i.test(String(value)));
  const hasWaysRules = Object.entries(rules).some(([key,value]) => /(?:WAYS_?RULES|RULES_DESC)$/i.test(key) && /consecutive reel|ways? (?:to )?pay/i.test(String(value)));
  if (settings.godsKingsLink) return 'gods-kings-link';
  // SG_JACKPOT is also present on ordinary Super Hot titles. Bell Link game
  // keys use the BLSlot suffix; treating the service flag as the mechanic
  // incorrectly routed FSHSlot/TSHSlot into hold-and-spin.
  if (features.has('SG_JACKPOT') && /BLSlot$/i.test(gameKey)) return 'bell-link';
  if (features.has('BUY_BONUS') || features.has('SUPER_BUY_BONUS')) return lines === 0 ? 'buy-bonus-ways' : 'buy-bonus-lines';
  if (hasToppling) return 'ways-cascade';
  if ((lines > 0 && reels > 0 && lines === 3 ** reels) || (lines === 0 && hasWaysRules)) return settings.coinFeature ? 'ways-coin' : 'ways';
  if (lines === 0) return 'ways-or-cluster';
  if (settings.coinFeature) return 'classic-lines-coin';
  return 'classic-lines';
}

const symbolRoleCache = new WeakMap();
function symbolRoles(profile) {
  if (symbolRoleCache.has(profile)) return symbolRoleCache.get(profile);
  const paytable = Object.keys(profile.settings?.paytable || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const capturedScatters = (profile.eventFamilies?.bet || []).flatMap(sample => sample.game?.result?.spins || []).flatMap(spin => spin.entries || []).filter(entry => String(entry.mode).toLowerCase() === 'scatter').map(entry => Number(entry.symbol)).filter(Number.isFinite);
  const rules = titleRules(profile.gameKey || profile.settings?.gameKey || '');
  const metadataRecord = clientMathMetadata(profile.gameKey || profile.settings?.gameKey || '');
  const metadata = metadataRecord?.symbolsAuthoritative === false ? null : metadataRecord;
  const hasScatterRules = capturedScatters.length > 0 || Object.keys(rules).some(key => /SCATTER/i.test(key)) || Array.isArray(profile.settings?.scatterCoefs) || (Array.isArray(profile.settings?.freeSpinFakeReels) && profile.settings.freeSpinFakeReels.length > 0);
  const declaredScatters = scatterSymbols(profile, profile.gameKey || profile.settings?.gameKey || '');
  const scatter = metadata ? (metadata.scatters.at(-1) ?? null) : capturedScatters[0] ?? declaredScatters.at(-1) ?? (hasScatterRules ? paytable.at(-1) : null);
  const scatterSet = new Set(declaredScatters.length ? declaredScatters : scatter === null ? [] : [scatter]);
  const ordinaryPaytable = paytable.filter(symbol => !scatterSet.has(symbol));
  const hasWildRule = Object.keys(rules).some(key=>/WILD/i.test(key));
  const inferredWild = scatterSet.size ? Math.min(...scatterSet) - 1 : null;
  const wild = metadata ? (metadata.wilds[0] ?? null) : hasWildRule && Number.isFinite(inferredWild) ? inferredWild : null;
  const coins = new Set();
  const paytableSet = new Set(paytable);
  for (const value of [profile.settings?.fakeReels, profile.settings?.reels].flat(Infinity)) {
    const symbol = Number(value); if (Number.isFinite(symbol) && !paytableSet.has(symbol)) coins.add(symbol);
  }
  if (wild !== null) coins.delete(wild);
  for (const symbol of scatterSet) coins.delete(symbol);
  const roles = Object.freeze({ scatter, wild, coins: Object.freeze([...coins].sort((a, b) => a - b)) });
  symbolRoleCache.set(profile, roles); return roles;
}

function scatterSymbols(profile, gameKey) {
  const metadata = clientMathMetadata(gameKey || profile.gameKey || profile.settings?.gameKey || '');
  if (metadata && metadata.symbolsAuthoritative !== false) return [...metadata.scatters];
  const paytable = Object.keys(profile.settings?.paytable || {}).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const captured = (profile.eventFamilies?.bet || []).flatMap(sample => sample.game?.result?.spins || []).flatMap(spin => spin.entries || []).filter(entry => String(entry.mode).toLowerCase() === 'scatter').map(entry => Number(entry.symbol)).filter(Number.isFinite);
  const rules = titleRules(gameKey), keys = Object.keys(rules), variants = keys.filter(key => /^PAYTABLE\.SCATTER_(?!DESC$)/i.test(key));
  if (captured.length) return [...new Set(captured)];
  if (!keys.some(key => /SCATTER/i.test(key))) return [];
  // Bell Link client configurations consistently reserve symbol 8 for WILD;
  // only paytable symbols above it are scatters. Assuming every Bell Link has
  // two scatters incorrectly classified premium symbol 7 in titles such as
  // Black Diamond and inflated its exact RTP above 170%.
  const bellLink = !profile.settings?.godsKingsLink && (profile.settings?.feature || []).includes('SG_JACKPOT');
  if (bellLink) {
    const modern = paytable.filter(symbol => symbol > 8);
    if (modern.length) return modern;
    const paytableSet = new Set(paytable);
    const special = [...new Set([profile.settings?.fakeReels, profile.settings?.reels].flat(Infinity).map(Number).filter(symbol => Number.isFinite(symbol) && symbol >= 0 && symbol < 100 && !paytableSet.has(symbol)))].sort((a,b)=>a-b);
    return special.length ? [special[0]] : [];
  }
  const count = Math.max(1, variants.length);
  return paytable.slice(-Math.min(count, paytable.length));
}

function scatterEligibleReels(profile, symbol) {
  const strips = profile.settings?.fakeReels;
  const count = reelCount(profile), all = Array.from({length:count},(_,index)=>index);
  const configured = Array.isArray(strips) ? strips.map((strip,index)=>Array.isArray(strip)&&strip.some(value=>Number(value)===Number(symbol))?index:-1).filter(index=>index>=0) : all;
  const descriptions = Object.entries(titleRules(profile.gameKey || profile.settings?.gameKey || '')).filter(([key])=>/^PAYTABLE\.SCATTER_(?!DESC$)/i.test(key)).map(([,value])=>String(value));
  const candidates = descriptions.map(text=>{
    if (/all reels/i.test(text)) return all;
    const ordinals=[...text.matchAll(/(\d+)(?:st|nd|rd|th)/gi)].map(match=>Number(match[1])-1).filter(index=>index>=0&&index<count);
    return [...new Set(ordinals)];
  }).filter(indexes=>indexes.length);
  if (!candidates.length) return configured;
  const declared = scatterSymbols(profile, profile.gameKey || profile.settings?.gameKey || ''), symbolIndex = declared.indexOf(Number(symbol));
  if (!Array.isArray(strips) && symbolIndex >= candidates.length) return all;
  if (!Array.isArray(strips) && symbolIndex >= 0) return candidates[symbolIndex];
  return candidates.sort((left,right)=>{
    const distance=indexes=>new Set([...indexes,...configured]).size-new Set(indexes.filter(index=>configured.includes(index))).size;
    return distance(left)-distance(right);
  })[0];
}

const DEFINITIONS = Object.freeze({
  'classic-lines': { evaluation: 'paylines', bonus: 'none' },
  'classic-lines-coin': { evaluation: 'paylines', bonus: 'mystery-coin' },
  'ways': { evaluation: 'ways', bonus: 'none' },
  'ways-coin': { evaluation: 'ways', bonus: 'mystery-coin' },
  'ways-cascade': { evaluation: 'ways', bonus: 'cascade' },
  'ways-or-cluster': { evaluation: 'profile-required', bonus: 'profile-required' },
  'buy-bonus-lines': { evaluation: 'paylines', bonus: 'buy-bonus' },
  'buy-bonus-ways': { evaluation: 'ways', bonus: 'buy-bonus' },
  'bell-link': { evaluation: 'paylines', bonus: 'hold-and-spin' },
  'gods-kings-link': { evaluation: 'paylines', bonus: 'gods-kings-link' },
});

class FamilyEngine {
  constructor(profile, gameKey) {
    this.profile = profile;
    this.gameKey = gameKey;
    this.familyId = classifyFamily(profile);
    this.definition = DEFINITIONS[this.familyId];
    if (!this.definition) throw new Error(`No local engine family for ${gameKey}`);
  }
  outcome(session, stake, bet) {
    // Family routing is authoritative even while individual bonus state machines
    // are implemented incrementally. Base outcomes are delegated to the shared
    // evaluator; a family must opt in before emitting any bonus protocol state.
    return session.syntheticOutcome(stake, bet, undefined, { evaluation: this.definition.evaluation });
  }
  handle(session, request) { return session.handleShared(request); }
  featureProtocolReady() { return this.definition.bonus === 'none' || this.definition.bonus === 'cascade'; }
  manifest() {
    const settings = this.profile.settings || {};
    return {
      gameKey: this.gameKey,
      family: this.familyId,
      evaluation: this.definition.evaluation,
      bonus: this.definition.bonus,
      reels: reelCount(this.profile),
      lines: Number(settings.lines || settings.linesOptions?.[0] || 0),
      features: settings.feature || [],
      symbolRoles: symbolRoles(this.profile),
      bonusProtocolReady: this.featureProtocolReady(),
    };
  }
}

class ClassicLinesEngine extends FamilyEngine {
  outcome(session, stake, bet) { return session.fixedMathOutcome(stake, bet) || session.syntheticOutcome(stake, bet, undefined, { evaluation: 'paylines' }); }
}
class ClassicLinesCoinEngine extends ClassicLinesEngine {}
class WaysEngine extends FamilyEngine {
  outcome(session, stake, bet) { return session.fixedMathOutcome(stake, bet) || session.syntheticOutcome(stake, bet, undefined, { evaluation: 'ways' }); }
}
class WaysCoinEngine extends WaysEngine {}
class WaysCascadeEngine extends FamilyEngine {
  outcome(session, stake, bet) { return session.fixedCascadeMathOutcome(stake, bet) || session.syntheticOutcome(stake, bet, undefined, { evaluation: 'ways' }); }
}
class WaysOrClusterEngine extends FamilyEngine {
  outcome(session, stake, bet) { return session.syntheticOutcome(stake, bet, undefined, { evaluation: 'ways' }); }
}
class BuyBonusLinesEngine extends ClassicLinesEngine {}
class BuyBonusWaysEngine extends WaysOrClusterEngine {}
class BellLinkEngine extends ClassicLinesEngine {
  outcome(session, stake, bet) {
    let outcome = super.outcome(session, stake, bet);
    if (session.mathConfig) {
      const model = session.mathConfig.featureModels?.find(feature => feature.type === 'hold-and-spin');
      if (!model) return outcome;
      const rows = session.mathConfig.rows, coins = new Set((model.coinSymbols || session.mathConfig.roles.coins).map(Number));
      const count = outcome.spin.reels.reduce((sum, reel) => sum + reel.slice(1, rows + 1).filter(symbol => coins.has(Number(symbol))).length, 0);
      return count >= Number(model.triggerCount || 5) ? session.holdSpinTrigger(stake, bet, { baseOutcome: outcome, model }) : outcome;
    }
    for (const scatter of scatterSymbols(this.profile, this.gameKey)) {
      const distribution = scatterCountProbabilities(this.profile, scatter);
      let cursor = session.random(), count = 0;
      for (; count < distribution.length - 1; count += 1) { cursor -= distribution[count]; if (cursor < 0) break; }
      if (count > 0) outcome = session.addVisibleScatters(outcome, count, scatter, stake, scatterCoefficient(this.profile, scatter, count));
    }
    return outcome;
  }
}
class GodsKingsLinkEngine extends ClassicLinesEngine {
  featureProtocolReady() {
    const rules = freeSpinRules(this.gameKey);
    return rules.mode === 'simple-multiplier' && Array.isArray(this.profile.settings?.freeSpinFakeReels) && rules.count > 0;
  }
  outcome(session, stake, bet) {
    const rules = freeSpinRules(this.gameKey), supportsFreeSpins = rules.mode === 'simple-multiplier' && Array.isArray(this.profile.settings?.freeSpinFakeReels) && rules.count > 0;
    if (session.mathConfig) {
      const outcome = session.fixedMathOutcome(stake, bet), model = session.mathConfig.featureModels?.find(feature => feature.type === 'free-spins');
      if (!model) return outcome;
      const scatter = Number(model.scatterSymbol ?? session.mathConfig.roles.scatter), rows = session.mathConfig.rows;
      const count = outcome.spin.reels.reduce((sum, reel) => sum + reel.slice(1, rows + 1).filter(symbol => Number(symbol) === scatter).length, 0);
      if (count < Number(model.triggerCount || 3)) return outcome;
      const spins = Number(typeof model.initialSpins === 'object' ? model.initialSpins[count] || 0 : model.initialSpins || 0);
      return session.freeSpinTrigger(stake, bet, { count: spins, multiplier: Number(model.multiplier || 1), triggerCount: Number(model.triggerCount || 3), evaluation: 'paylines', baseOutcome: outcome, mathFeatureModel: model });
    }
    if (this.gameKey === 'RORGKLSlot' && session.reelReservoir) {
      const outcome = session.reelReservoirOutcome(stake, bet);
      if (supportsFreeSpins && outcome.candidate?.triggersFreeSpins) return session.freeSpinTrigger(stake, bet, { ...rules, evaluation: 'paylines', baseOutcome: outcome });
      return outcome;
    }
    const roles = symbolRoles(this.profile), scatterDistribution = scatterCountProbabilities(this.profile, roles.scatter);
    const triggerProbability = supportsFreeSpins ? scatterDistribution.slice(rules.triggerCount).reduce((sum, probability) => sum + probability, 0) : 0;
    const roll = session.random();
    if (triggerProbability && roll < triggerProbability) return session.freeSpinTrigger(stake, bet, { ...rules, evaluation: 'paylines' });
    const ordinaryScatterRtp = scatterDistribution.slice(1, rules.triggerCount).reduce((sum, probability, index) => sum + probability * scatterCoefficient(this.profile, roles.scatter, index + 1) * 100, 0);
    const baseTargetRtp = Math.max(0, session.targetRtp * Math.max(0, 1 - rules.count * triggerProbability) - ordinaryScatterRtp);
    const outcome = session.syntheticOutcome(stake, bet, undefined, { evaluation: 'paylines', targetRtp: baseTargetRtp });
    let cursor = triggerProbability;
    for (let count = Math.min(rules.triggerCount - 1, scatterDistribution.length - 1); count >= 1; count -= 1) {
      cursor += scatterDistribution[count];
      if (roll < cursor) return session.addVisibleScatters(outcome, count, roles.scatter, stake, scatterCoefficient(this.profile, roles.scatter, count));
    }
    return outcome;
  }
}

const ENGINE_CLASSES = Object.freeze({
  'classic-lines': ClassicLinesEngine,
  'classic-lines-coin': ClassicLinesCoinEngine,
  'ways': WaysEngine,
  'ways-coin': WaysCoinEngine,
  'ways-cascade': WaysCascadeEngine,
  'ways-or-cluster': WaysOrClusterEngine,
  'buy-bonus-lines': BuyBonusLinesEngine,
  'buy-bonus-ways': BuyBonusWaysEngine,
  'bell-link': BellLinkEngine,
  'gods-kings-link': GodsKingsLinkEngine,
});

function createFamilyEngine(profile, gameKey) {
  const familyId = classifyFamily(profile), Engine = ENGINE_CLASSES[familyId];
  if (!Engine) throw new Error(`No local engine class for ${gameKey} (${familyId})`);
  return new Engine(profile, gameKey);
}

function inventoryProfiles(directory = path.join(__dirname, 'data', 'egt-profiles')) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
    const gameKey = name.slice(0, -5), profile = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    return createFamilyEngine(profile, gameKey).manifest();
  });
}

module.exports = { DEFINITIONS, ENGINE_CLASSES, FamilyEngine, classifyFamily, createFamilyEngine, freeSpinRules, inventoryProfiles, reelCount, scatterCoefficient, scatterCountProbabilities, scatterEligibleReels, scatterSymbols, symbolRoles, titleRules };
