const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFamilyEngine, scatterSymbols, symbolRoles } = require('./egt-family-engines.cjs');
const { RorgklReelReservoir } = require('./rorgkl-reel-engine.cjs');
const { fixedCascadeOutcome, fixedReelOutcome, secureRandomInt, visibleRowCount } = require('./egt-fixed-reel-engine.cjs');
const { selectMathConfiguration } = require('./egt-math-registry.cjs');
const { clientMathMetadata } = require('./egt-client-metadata.cjs');

const PAYLINES_20 = [
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[0,1,1,1,0],
  [2,1,1,1,2],[1,0,1,2,1],[1,2,1,0,1],[0,1,0,1,0],[2,1,2,1,2],
  [1,1,0,1,1],[1,1,2,1,1],[0,2,0,2,0],[2,0,2,0,2],[0,2,2,2,0],
];
const PAYLINES_40_4ROW = [
  [1,1,1,1,1],[2,2,2,2,2],[0,0,0,0,0],[3,3,3,3,3],[1,2,3,2,1],
  [2,1,0,1,2],[0,0,1,2,3],[3,3,2,1,0],[2,3,3,3,2],[1,0,0,0,1],
  [0,1,2,3,3],[3,2,1,0,0],[2,3,2,1,2],[1,0,1,2,1],[0,1,0,1,0],
  [3,2,3,2,3],[1,2,1,0,1],[2,1,2,3,2],[0,1,1,1,0],[3,2,2,2,3],
  [1,1,2,3,3],[2,2,1,0,0],[0,1,2,2,3],[3,2,1,1,0],[1,2,2,2,3],
  [2,1,1,1,0],[0,0,1,0,0],[3,3,2,3,3],[2,2,3,2,2],[1,1,0,1,1],
  [0,0,0,1,2],[3,3,3,2,1],[2,3,3,2,1],[1,0,0,1,2],[0,1,1,2,3],
  [3,2,2,1,0],[2,3,2,1,0],[1,0,1,2,3],[0,1,2,3,2],[3,2,1,0,1],
];
const ALLOWED_STAKE_UNITS = Object.freeze([20, 50, 100, 200, 500, 1000]);
const ALLOWED_STAKE_SET = new Set(ALLOWED_STAKE_UNITS);

function globallyLimitedBetSettings(source) {
  const settings = structuredClone(source || {});
  const factor = Math.max(1, Number(settings.factor || settings.factors?.[0] || 1));
  settings.denominations = [1]; settings.denomination = 1;
  settings.factors = [factor]; settings.factor = factor;
  settings.bets = ALLOWED_STAKE_UNITS.map(stake => stake / factor);
  settings.bet = settings.bets[0];
  if (Array.isArray(settings.linesPerDenomination)) settings.linesPerDenomination = [Number(settings.lines || factor)];
  return settings;
}
function paylinesFor(profile, templateReels) {
  const lines = Number(profile.settings?.lines || profile.settings?.linesOptions?.[0] || 0);
  const authored = clientMathMetadata(profile.gameKey || profile.settings?.gameKey || '')?.paylines;
  if (Array.isArray(authored) && authored.length === lines && authored.every(line => line.length === reelCountForPaylines(templateReels))) return structuredClone(authored);
  const visibleRows = Math.max(1, Math.min(...(templateReels || []).map(reel=>Array.isArray(reel)?reel.length:5)) - 2);
  return lines === 40 && visibleRows >= 4 ? PAYLINES_40_4ROW : PAYLINES_20;
}

function reelCountForPaylines(templateReels) {
  return Array.isArray(templateReels) && templateReels.length ? templateReels.length : 5;
}

function sockJsDecode(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  try {
    const envelope = JSON.parse(text[0] === 'a' ? text.slice(1) : text);
    return (Array.isArray(envelope) ? envelope : [envelope]).map(value => typeof value === 'string' ? JSON.parse(value) : value);
  } catch { return []; }
}
function sockJsEncode(value) { return `a${JSON.stringify([JSON.stringify(value)])}`; }
function moneyString(value) { return String(Math.max(0, Math.round(value))); }
function randomId() { return BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString(); }
function secureRandom() { return crypto.randomInt(0, 0x100000000) / 0x100000000; }
function ordinarySymbols(profile) {
  const entries = Object.entries(profile.settings?.paytable || {}).map(([raw, config]) => ({ symbol: Number(raw), config })).filter(item => Number.isFinite(item.symbol) && (item.config?.coef || []).length);
  const paytable = new Set(entries.map(item => item.symbol));
  const observed = new Set((profile.eventFamilies?.bet || []).flatMap(sample => sample.game?.result?.spins || []).flatMap(spin => (spin.reels || []).flat()).map(Number).filter(symbol => Number.isFinite(symbol) && paytable.has(symbol)));
  // Captured base-game reels are authoritative: paytable symbols seen there are
  // ordinary even when they are premium/high-numbered. This excludes coin IDs and
  // unobserved scatter-only symbols without deleting the top quarter of every game.
  let selected = observed.size >= Math.min(5, entries.length) ? entries.filter(item => observed.has(item.symbol)) : entries;
  // Profiles with free-spin reel metadata conventionally place the scatter at the
  // highest paytable symbol ID. Its coefficient array is count-based (often paying
  // from two scatters), not a left-to-right line table. Until the title-specific
  // feature state machine is implemented, never generate that symbol as ordinary
  // filler: showing it without its award/feature is a false outcome.
  const roles = symbolRoles(profile);
  const declaredScatters = new Set(scatterSymbols(profile, profile.gameKey));
  selected = selected.filter(item => item.symbol !== roles.scatter && !declaredScatters.has(item.symbol) && item.symbol !== roles.wild && !roles.coins.includes(item.symbol));
  return selected.sort((left, right) => left.symbol - right.symbol).map(item => item.symbol);
}

function paytableOccurrence(profile, config, index) {
  const reelCount = Array.isArray(profile.settings?.fakeReels) && profile.settings.fakeReels.length
    ? profile.settings.fakeReels.length
    : Array.isArray(profile.settings?.reels) && profile.settings.reels.length ? profile.settings.reels.length : 5;
  // EGT coefficient arrays are right-aligned to the reel count. A three-value
  // array is 3/4/5-of-a-kind; a four-value array is 2/3/4/5-of-a-kind.
  return Math.max(1, reelCount - (config.coef || []).length + index + 1);
}

function outcomeOccurrenceLikelihood(profile, symbol, occurs) {
  const configured = profile.settings?.fakeReels;
  const strips = Array.isArray(configured) && configured.length && configured.every(strip => Array.isArray(strip) && strip.length)
    ? configured : null;
  if (!strips || occurs > strips.length) return Math.max(Number.EPSILON, 0.08 ** occurs);
  const probabilities = strips.map(strip => strip.reduce((count, value) => count + (Number(value) === Number(symbol) ? 1 : 0), 0) / strip.length);
  let likelihood = probabilities.slice(0, occurs).reduce((product, probability) => product * probability, 1);
  if (occurs < probabilities.length) likelihood *= 1 - probabilities[occurs];
  return Math.max(Number.EPSILON, likelihood);
}

function weightedPaytable(profile, factor) {
  const allowed = new Set(ordinarySymbols(profile)), choices = [];
  for (const [rawSymbol, config] of Object.entries(profile.settings?.paytable || {})) for (let index = 0; index < (config.coef || []).length; index += 1) {
    const symbol = Number(rawSymbol), coefficient = Number(config.coef[index]), multiple = coefficient / factor;
    const occurs = paytableOccurrence(profile, config, index);
    if (allowed.has(symbol) && Number.isFinite(multiple) && multiple > 0) choices.push({ symbol, coefficient, occurs, multiple, likelihood: outcomeOccurrenceLikelihood(profile, symbol, occurs) });
  }
  // A line award may legitimately be smaller than the total multi-line wager.
  // Filtering those awards out turns almost every accepted result into a rare
  // long combination, especially when factor equals 20/25/50 lines.
  let eligible = choices.filter(choice => choice.multiple > 0 && choice.multiple <= 40);
  if (new Set(eligible.map(choice => choice.multiple)).size < 2) eligible = choices;
  const lineCount = Number(profile.settings?.lines || profile.settings?.linesOptions?.[0] || 0);
  const configuredReels = profile.settings?.reels;
  const visibleRows = Number(profile.settings?.visibleSymbolsPerReel ||
    (Array.isArray(configuredReels?.[0]) ? configuredReels[0].length - 2 : 0));
  // The 5x4 Bell Link client animates the authored line entries as a single
  // result.  Painting several independently selected lines into one grid can
  // create dense, contradictory animation paths and leave the reels spinning.
  const requiresAtomicLineResult = lineCount === 40 && visibleRows === 4;
  const supportsLinePackages = lineCount > 0 && lineCount !== 3 ** (Array.isArray(profile.settings?.reels) ? profile.settings.reels.length : 5);
  const sampleReels = profile.eventFamilies?.bet?.find(sample=>sample.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels;
  const paylines = paylinesFor(profile, sampleReels);
  const packageWildShare = packageLines => paylines.reduce((sum, _, primary) => {
    const indexes = [primary, ...paylines.map((__, index) => index).filter(index => index !== primary)].slice(0, packageLines);
    const row = paylines[primary][1];
    return sum + indexes.filter(index => paylines[index][1] === row).length / indexes.length;
  }, 0) / paylines.length;
  const groups = [...Map.groupBy(eligible, choice => `${choice.multiple}:${choice.occurs}`)].map(([, values]) => {
    const frequency = values.reduce((sum, value) => sum + value.likelihood, 0);
    const multiple = values[0].multiple, occurs = values[0].occurs;
    // Never manufacture a large win by painting the same symbol across most of
    // the grid. Four authored lines is the visual/mechanical ceiling; larger
    // awards must come from a more valuable paytable entry instead.
    const packageLines = supportsLinePackages && !requiresAtomicLineResult && occurs < 5 ? Math.min(4, Math.max(1, Math.round(3 / multiple))) : 1;
    const minimumPackageLines = Math.max(1, packageLines - 1), packageVariants = packageLines - minimumPackageLines + 1;
    const meanPackageLines = (minimumPackageLines + packageLines) / 2;
    const weightedWildShare = Array.from({ length: packageVariants }, (_, index) => {
      const lines = minimumPackageLines + index; return lines * packageWildShare(lines);
    }).reduce((sum, value) => sum + value, 0) / packageVariants / meanPackageLines;
    return { multiple, occurs, packageLines, minimumPackageLines, meanPackageLines, wildShare: weightedWildShare, effectiveMultiple: multiple * meanPackageLines, values, frequency, valueWeights: values.map(value => value.likelihood / frequency) };
  });
  if (!groups.length) return { groups: [{ multiple: 5, packageLines: 1, wildShare: 1, values: [{ symbol: 0, coefficient: factor * 5, occurs: 3, multiple: 5 }], valueWeights: [1] }], weights: [1], mean: 5, wildAdjustedMean: 6.25 };
  // Prefer useful three-reel awards over dozens of tiny two-reel awards. Longer
  // combinations retain a steep occurrence penalty, so RTP is carried by payout
  // value rather than visually repetitive four/five-reel patterns.
  const waysGame = lineCount === 3 ** (Array.isArray(profile.settings?.reels) ? profile.settings.reels.length : 5);
  const raw = groups.map(group => {
    // Ways/cascade titles need occurrence-led selection. Applying the line-game
    // payout bias here made EITH choose almost nothing except symbols 6 and 7.
    if (waysGame) return group.frequency * Math.sqrt(group.multiple);
    const occurrencePenalty = group.occurs <= 2 ? 0.05 : group.occurs === 4 ? 0.01 : 1;
    return group.frequency * group.multiple ** 2 * occurrencePenalty;
  }), total = raw.reduce((sum, weight) => sum + weight, 0);
  const weights = raw.map(weight => weight / total);
  // RTP changes whether a valid award is accepted; it must not make long reel
  // patterns commonplace. Limit their conditional share, then redistribute the
  // removed mass across short awards. Five-of-kind stays below one in ten
  // million accepted wins. Four-symbol outcomes remain available to carry RTP
  // on low-paying titles without promoting the exceptional five-reel pattern.
  for (const [occurs, cap] of [[5, 0.0000001]]) {
    const indexes = groups.map((group, index) => group.values.every(value => value.occurs === occurs) ? index : -1).filter(index => index >= 0);
    const current = indexes.reduce((sum, index) => sum + weights[index], 0);
    if (current <= cap) continue;
    const removed = current - cap;
    for (const index of indexes) weights[index] *= cap / current;
    const recipients = groups.map((group, index) => group.values.every(value => value.occurs < occurs) ? index : -1).filter(index => index >= 0);
    const recipientTotal = recipients.reduce((sum, index) => sum + weights[index], 0);
    for (const index of recipients) weights[index] += removed * weights[index] / recipientTotal;
  }
  const adjustedMean = weights.reduce((sum, weight, index) => sum + weight * groups[index].effectiveMultiple, 0);
  const wildAdjustedMean = weights.reduce((sum, weight, index) => sum + weight * groups[index].effectiveMultiple * (1 + 0.25 * groups[index].wildShare), 0);
  return { groups, weights, mean: adjustedMean, wildAdjustedMean };
}

function weightedIndex(random, weights) {
  let cursor = random(), index = 0;
  for (; index < weights.length - 1; index += 1) { cursor -= weights[index]; if (cursor < 0) break; }
  return index;
}
function randomLineIndexes(random, primary, count, paylines=PAYLINES_20) {
  const remaining = paylines.map((_, index) => index).filter(index => index !== primary);
  // Fisher-Yates with the session RNG: a package must not have the old fixed
  // [primary, 0, 1, 2] geometry that players could recognize across spins.
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const picked = Math.floor(random() * (index + 1));
    [remaining[index], remaining[picked]] = [remaining[picked], remaining[index]];
  }
  return [primary, ...remaining].slice(0, Math.max(1, count));
}
function defaultJackpotStats(profile) {
  if (!profile.settings?.feature?.includes('SG_JACKPOT')) return [];
  return [{ jackpotName: 'Bell Link', miniGameKey: '', baseDenomination: 1, levelStats: [1,2,3,4].map(levelId => ({ levelId, currentValue: 0, totalWins: 0, lastWinValue: 0, lastWinPlayerName: '', lastWinDate: '', maxWinValue: 0, maxWinPlayerName: '', maxWinDate: '', limit: 0 })) }];
}
function scaledOutcomeGame(game, ratio) {
  const copy = structuredClone(game), monetary = new Set(['totalWin','totalWinAmount','winAmount','win','prizeAmount','amount']);
  const walk = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (monetary.has(key) && (typeof child === 'number' || /^-?\d+(?:\.\d+)?$/.test(String(child)))) value[key] = typeof child === 'string' ? moneyString(Number(child) * ratio) : Math.round(Number(child) * ratio); else walk(child); } };
  walk(copy); return copy;
}
let bellLinkArchetype, freeSpinArchetype;
const cascadeFamilyCache = new Map();
function isCascadeFamily(profile, gameKey) {
  const family = String(gameKey).replace(/HR(?=Slot$)/, '');
  if (cascadeFamilyCache.has(family)) return cascadeFamilyCache.get(family);
  const hasCascade = candidate => (candidate.outcomes || []).some(outcome => (outcome.game?.result?.spins?.length || 0) > 1);
  let result = hasCascade(profile);
  if (!result) {
    try {
      const directory = path.join(__dirname, 'data', 'egt-profiles');
      for (const filename of fs.readdirSync(directory)) {
        const candidateKey = filename.replace(/\.json$/, '');
        if (candidateKey.replace(/HR(?=Slot$)/, '') !== family) continue;
        if (hasCascade(JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')))) { result = true; break; }
      }
    } catch {}
  }
  cascadeFamilyCache.set(family, result); return result;
}
function adaptedBellLinkOutcome(profile, archetype) {
  const base = profile.eventFamilies?.bet?.find(sample => sample.game?.result?.spins?.[0]?.reels);
  const baseSpin = base?.game.result.spins[0] || (Array.isArray(profile.settings?.reels) ? { entries: [], mutations: [], totalWinAmount: '0', reels: structuredClone(profile.settings.reels), type: 'SPIN', bonuses: [], totalWin: 0 } : null);
  if (!baseSpin) return null;
  const outcome = structuredClone(archetype), game = outcome.game, spin = structuredClone(baseSpin);
  const observed = (profile.eventFamilies?.bet || []).flatMap(sample => sample.game?.result?.spins || []).flatMap(item => (item.reels || []).flat());
  const configured = Object.entries(profile.settings || {}).filter(([key]) => /reel/i.test(key)).flatMap(([, value]) => Array.isArray(value) ? value.flat(Infinity) : []);
  const paytable = new Set(Object.keys(profile.settings?.paytable || {}).map(Number));
  let coins = [...new Set([...observed, ...configured].map(Number).filter(symbol => Number.isFinite(symbol) && symbol >= 100))];
  if (!coins.length) coins = [...new Set(configured.map(Number).filter(symbol => Number.isFinite(symbol) && !paytable.has(symbol)))];
  if (!coins.length) coins = [101];
  spin.entries = []; spin.mutations = []; delete spin.mutatedReels; spin.totalWin = 0; spin.totalWinAmount = '0'; spin.bonuses = [{ count: 3, type: 'HOLDSPIN' }];
  const positions = [];
  for (let reel = 0; reel < spin.reels.length; reel += 1) { const row = Math.min(2, spin.reels[reel].length - 1); spin.reels[reel][row] = coins[reel % coins.length]; positions.push(reel * 3 + Math.max(0, row - 1)); }
  game.result = { spins: [spin], bellLink: { pos: positions, multiplier: 1, boost: false }, lastWinAmount: '0', lastWin: '0' };
  game.state.rounds = [{ type: 'HOLDSPIN', remain: 3, count: 3, totalWin: 0, totalWinAmount: 0 }];
  return outcome;
}
function adaptedFreeSpinOutcome(profile, archetype) {
  const base = profile.eventFamilies?.bet?.find(sample => sample.game?.result?.spins?.[0]?.reels);
  const baseSpin = base?.game.result.spins[0] || (Array.isArray(profile.settings?.reels) ? { entries: [], mutations: [], totalWinAmount: '0', reels: structuredClone(profile.settings.reels), type: 'SPIN', bonuses: [], totalWin: 0 } : null);
  if (!baseSpin) return null;
  const outcome = structuredClone(archetype), game = outcome.game, spin = structuredClone(baseSpin);
  spin.entries = []; spin.mutations = []; delete spin.mutatedReels; spin.totalWin = 0; spin.totalWinAmount = '0'; spin.bonuses = [{ count: 10, type: 'FREESPIN' }];
  game.result = { spins: [spin], lastWinAmount: '0', lastWin: '0' };
  game.state.rounds = [{ type: 'FREESPIN', remain: 10, count: 10, totalWin: 0, totalWinAmount: 0 }];
  return outcome;
}
function capturedFeatureOutcomes(profile) {
  // Captured feature snapshots do not define a complete title-specific state
  // machine. Cross-title FREESPIN/HOLDSPIN adaptation can render incompatible reel
  // shapes, omit trigger symbols, and leave controls locked after completion.
  // Keep bonus-state synthesis disabled until each title has an authored trigger,
  // continuation sequence and completion handshake.
  return [];
}

class EgtLocalSession {
  constructor({ profile, gameKey, balanceUnits, targetRtp = 100, random = secureRandom, randomInt = secureRandomInt, featurePreference = '', enableFixedMath = true }) {
    this.profile = profile; this.gameKey = gameKey; this.balance = Math.round(balanceUnits); this.targetRtp = Number(targetRtp); this.random = random; this.randomInt = randomInt;
    this.sessionKey = crypto.randomUUID(); this.pendingWin = 0; this.lastWin = 0; this.lastGame = null; this.lastState = 'idle'; this.activeFeature = null; this.featurePreference = featurePreference; this.lastReelsKey = ''; this.lastSettlement = null; this.familyEngine = createFamilyEngine(profile, gameKey);
    // The registry itself is the safety gate: only content-addressed configs
    // with complete feature math and verified total RTP are selectable. All
    // base-only artifacts are rejected before a session reaches this point.
    this.mathConfig = enableFixedMath ? selectMathConfiguration(gameKey, this.targetRtp) : null;
    this.betSettings = globallyLimitedBetSettings(profile.settings);
    this.reelReservoir = gameKey === 'RORGKLSlot' ? new RorgklReelReservoir({ profile, random }) : null;
  }
  messages(data) { this.lastSettlement = null; return sockJsDecode(data).map(request => this.handle(request)).filter(Boolean).map(sockJsEncode); }
  consumeSettlement() { const settlement = this.lastSettlement; this.lastSettlement = null; return settlement; }
  pushMessages(event) { return (this.profile.eventFamilies?.[event] || []).slice(0, 1).map(template => sockJsEncode(this.fromTemplate({ event }, template))); }
  handle(request) { return this.familyEngine.handle(this, request); }
  handleShared(request) {
    if (request.event === 'loadGame') return this.loadGame(request);
    if (request.event === 'bet') return this.bet(request);
    if (request.event === 'collect') return this.collect(request);
    const templates = this.profile.eventFamilies?.[request.event];
    if (templates?.length) return this.fromTemplate(request, templates[0]);
    return { referenceId: request.id, sessionKey: this.sessionKey, event: request.event, error: { code: 'UNSUPPORTED_EVENT', message: `Unsupported local event ${request.event}` }, context: {} };
  }
  fromTemplate(request, template) {
    const response = structuredClone(template);
    response.referenceId = request.id;
    response.sessionKey = this.sessionKey;
    response.event = request.event;
    if (response.balance) response.balance = { ...response.balance, balance: this.balance };
    if (response.game?.state?.matchId) response.game.state.matchId = randomId();
    return response;
  }
  loadGame(request) {
    const jackpotStats = this.profile.loadGameShape.jackpotStats?.length ? this.profile.loadGameShape.jackpotStats : defaultJackpotStats(this.profile);
    const game = structuredClone(this.lastGame || this.profile.loadGameShape.game);
    game.state ||= {}; game.state.bet = { ...(game.state.bet || {}), level: this.betSettings.bet, denomination: 1, factor: this.betSettings.factor, lines: this.betSettings.lines };
    return { referenceId: request.id, sessionKey: this.sessionKey, gameKey: this.gameKey, event: 'loadGame', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game, state: this.lastState, settings: structuredClone(this.betSettings), context: {}, jackpotStats: structuredClone(jackpotStats) };
  }
  collect(request) {
    const idle = this.profile.eventFamilies?.bet?.find(sample => sample.state === 'idle' && sample.game?.result?.spins?.[0]);
    const response = idle ? this.fromTemplate(request, idle) : { referenceId: request.id, sessionKey: this.sessionKey, event: 'collect', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game: structuredClone(this.lastGame), state: 'idle', context: {} };
    response.event = 'collect'; response.referenceId = request.id; response.sessionKey = this.sessionKey;
    response.balance = { ...(response.balance || {}), balance: this.balance, units: Number(response.balance?.units || 100), currency: response.balance?.currency || 'EGT' };
    response.state = 'idle'; response.game ||= {}; response.game.state ||= {};
    response.game.state.bet = structuredClone(request.bet || response.game.state.bet || {}); response.game.state.totalWin = '0'; response.game.state.totalWinAmount = '0'; response.game.state.rounds = [];
    response.game.result ||= {}; response.game.result.lastWin = moneyString(this.lastWin); response.game.result.lastWinAmount = moneyString(this.lastWin);
    this.lastState = 'idle'; this.lastGame = structuredClone(response.game); this.lastWin = 0;
    return response;
  }
  bet(request) {
    if (this.activeFeature) return this.continueFeature(request);
    const bet = request.bet || {}, rawStake = Number(bet.level) * Number(bet.factor || 1) * Number(bet.denomination || 1), stake = Math.round(rawStake);
    const validShape = Number(bet.factor) === this.betSettings.factor && Number(bet.denomination || 1) === 1
      && this.betSettings.bets.some(level => Math.abs(Number(bet.level) - level) < 0.000001)
      && Number(bet.lines || this.betSettings.lines) === Number(this.betSettings.lines);
    if (!validShape || !Number.isFinite(rawStake) || Math.abs(rawStake - stake) > 0.000001 || !ALLOWED_STAKE_SET.has(stake)) return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, state: 'idle', error: { code: 'INVALID_BET', message: 'Allowed total bets: 0.20, 0.50, 1, 2, 5, 10' }, context: {} };
    this.balance += this.pendingWin; this.lastWin = this.pendingWin; this.pendingWin = 0;
    if (this.balance < stake) return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, state: 'idle', error: { code: 'INSUFFICIENT_FUNDS' }, context: {} };
    this.balance -= stake;
    const outcome = this.outcome(stake, bet);
    this.pendingWin = outcome.totalWin;
    this.lastSettlement = { reference: String(request.id || randomId()), wagerUnits: stake, winUnits: 0 };
    const game = outcome.game || { state: { matchId: randomId(), bet: structuredClone(bet), totalWin: moneyString(outcome.totalWin), totalWinAmount: moneyString(outcome.totalWin), limitOverflow: false, gambles: 0, gambleHistory: [], prizes: [] }, result: { spins: outcome.spins || [outcome.spin], totalWinAmount: moneyString(outcome.totalWin), totalWin: outcome.totalWin, lastWinAmount: '0', lastWin: '0' } };
    game.state ||= {}; game.state.matchId = randomId(); game.state.bet = structuredClone(bet); game.state.totalWin = moneyString(outcome.totalWin); game.state.totalWinAmount = moneyString(outcome.totalWin);
    // These fields describe a win still being presented, not the amount that was
    // collected before this spin. Carrying the previous value keeps its win layer alive.
    game.result ||= {}; game.result.lastWinAmount = '0'; game.result.lastWin = '0';
    this.lastGame = structuredClone(game); this.lastState = outcome.state || (outcome.totalWin > 0 ? 'win' : 'idle');
    const round = game.state.rounds?.find(value => ['FREESPIN','HOLDSPIN'].includes(value.type));
    if (round) { this.activeFeature = outcome.familyFeature ? { ...structuredClone(outcome.familyFeature), type: round.type, game: structuredClone(game), context: structuredClone(outcome.context || {}) } : { type: round.type, remain: Math.max(1, Number(round.remain || round.count || 1)), totalWin: outcome.totalWin, game: structuredClone(game), context: structuredClone(outcome.context || {}) }; this.pendingWin = 0; }
    else { this.balance += this.pendingWin; this.lastWin = this.pendingWin; this.lastSettlement.winUnits = this.pendingWin; this.pendingWin = 0; }
    // The local wallet settles a complete ordinary round atomically. This lets the
    // launcher persist the wager and gross payout as two ledger entries instead of
    // inferring one net delta from the balance shown to the client.
    if (!round) this.lastGame = structuredClone(game);
    return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game, state: this.lastState, context: outcome.context || {} };
  }
  continueFeature(request) {
    const feature = this.activeFeature;
    if (feature.kind === 'hold-and-spin-v1') return this.continueHoldSpin(request, feature);
    const game = structuredClone(feature.game); feature.remain = Math.max(0, feature.remain - 1);
    if (feature.kind === 'free-spins-v1') return this.continueFreeSpins(request, feature);
    game.state ||= {}; game.state.matchId = randomId(); if (request.bet) game.state.bet = structuredClone(request.bet);
    const round = game.state.rounds?.find(value => value.type === feature.type); if (round) round.remain = feature.remain;
    const final = feature.remain === 0, state = final ? (feature.totalWin > 0 ? 'win' : 'idle') : feature.type.toLowerCase();
    for (const spin of game.result?.spins || []) spin.bonuses = final ? [] : [{ count: feature.remain, type: feature.type }];
    game.result ||= {}; game.result.lastWinAmount = '0'; game.result.lastWin = '0';
    this.lastGame = structuredClone(game); this.lastState = state;
    if (final) { this.balance += feature.totalWin; this.lastWin = feature.totalWin; this.lastSettlement = { reference: String(request.id || randomId()), wagerUnits: 0, winUnits: feature.totalWin }; this.activeFeature = null; }
    return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game, state, context: structuredClone(feature.context) };
  }
  freeSpinTrigger(stake, bet, config) {
    const roles = symbolRoles(this.profile), base = config.baseOutcome ? structuredClone(config.baseOutcome) : null;
    const generated = base?.spin?.reels ? { reels: base.spin.reels } : this.reels(false, roles.scatter, config.triggerCount, this.profile.eventFamilies?.bet?.[0]?.game?.result?.spins?.[0]?.reels, config.evaluation);
    if (!base) for (let reel = 0; reel < Math.min(config.triggerCount, generated.reels.length); reel += 1) generated.reels[reel][2] = roles.scatter;
    const initialWin = Number(base?.totalWin || 0);
    const spin = base?.spin || { entries: [], mutations: [], totalWinAmount: moneyString(initialWin), reels: generated.reels, type: 'SPIN', bonuses: [], totalWin: initialWin };
    spin.bonuses = [{ count: config.count, type: 'FREESPIN' }];
    const game = { state: { matchId: randomId(), bet: structuredClone(bet), totalWin: moneyString(initialWin), totalWinAmount: moneyString(initialWin), limitOverflow: false, gambles: 0, gambleHistory: [], prizes: [], rounds: [{ type: 'FREESPIN', remain: config.count, count: config.count, totalWin: initialWin, totalWinAmount: initialWin }] }, result: { spins: [spin], totalWinAmount: moneyString(initialWin), totalWin: initialWin, lastWinAmount: '0', lastWin: '0' } };
    return { totalWin: initialWin, game, state: 'freespin', context: {}, familyFeature: { kind: 'free-spins-v1', remain: config.count, count: config.count, multiplier: config.multiplier, stake, bet: structuredClone(bet), evaluation: config.evaluation, totalWin: initialWin, mathFeatureModel: structuredClone(config.mathFeatureModel || null) } };
  }
  holdSpinTrigger(stake, bet, { baseOutcome, model }) {
    const outcome = structuredClone(baseOutcome), spin = outcome.spin || outcome.spins?.[0];
    if (!spin?.reels) throw new Error('hold-and-spin trigger requires a base reel window');
    const rows = visibleRowCount(this.profile), coinSymbols = new Set((model.coinSymbols || symbolRoles(this.profile).coins).map(Number));
    const occupied = [];
    for (let reel = 0; reel < spin.reels.length; reel += 1) for (let row = 0; row < rows; row += 1) {
      const symbol = Number(spin.reels[reel][row + 1]);
      if (coinSymbols.has(symbol)) occupied.push({ position: reel * rows + row, symbol, value: this.holdCoinValue(model, symbol) });
    }
    if (occupied.length < Number(model.triggerCount || 5)) throw new Error('hold-and-spin trigger does not contain enough visible coin symbols');
    const baseWin = Number(outcome.totalWin || 0), coinWin = occupied.reduce((sum, coin) => sum + Math.round(stake * coin.value), 0), totalWin = baseWin + coinWin;
    spin.bonuses = [{ count: Number(model.lives || 3), type: 'HOLDSPIN' }];
    const game = {
      // An authentic trigger reports only the base-spin award here. Bell values
      // are accumulated by the feature and exposed when the hold-spin ends.
      state: { matchId: randomId(), bet: structuredClone(bet), totalWin: moneyString(baseWin), totalWinAmount: moneyString(baseWin), limitOverflow: false, gambles: 0, gambleHistory: [], prizes: [], rounds: [{ type: 'HOLDSPIN', remain: Number(model.lives || 3), count: Number(model.lives || 3), totalWin: 0, totalWinAmount: 0 }] },
      result: { spins: [spin], bellLink: { pos: occupied.map(coin => coin.position), multiplier: 1, boost: false }, totalWinAmount: moneyString(baseWin), totalWin: baseWin, lastWinAmount: '0', lastWin: '0' },
    };
    return { totalWin: baseWin, game, state: 'holdspin', context: {}, familyFeature: { kind: 'hold-and-spin-v1', remain: Number(model.lives || 3), count: Number(model.lives || 3), spinsPlayed: 0, stake, bet: structuredClone(bet), baseWin, totalWin, occupied, model: structuredClone(model), restoreResponse: structuredClone(spin) } };
  }
  holdCoinValue(model, symbol) {
    const configured = Number(model.coinValueBySymbol?.[symbol] ?? model.coinValueBySymbol?.[String(symbol)]);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    const values = Array.isArray(model.coinValues) && model.coinValues.length ? model.coinValues : [1];
    const weighted = values.map(value => typeof value === 'number' ? { value, weight: 1 } : { value: Number(value.value), weight: Number(value.weight || 1) }).filter(value => Number.isFinite(value.value) && value.value >= 0 && value.weight > 0);
    const scaled = weighted.map(value => ({ ...value, scaledWeight: Math.max(1, Math.round(value.weight * 1000000)) }));
    const total = scaled.reduce((sum, value) => sum + value.scaledWeight, 0);
    let cursor = this.randomInt(total);
    for (const value of scaled) { cursor -= value.scaledWeight; if (cursor < 0) return value.value; }
    return weighted.at(-1)?.value || 0;
  }
  continueHoldSpin(request, feature) {
    const model = feature.model, rows = visibleRowCount(this.profile), cells = Number(model.cells || (feature.game?.result?.spins?.[0]?.reels?.length || 5) * rows);
    feature.spinsPlayed = Number(feature.spinsPlayed || 0) + 1;
    feature.remain = Math.max(0, feature.remain - 1);
    const occupiedPositions = new Set(feature.occupied.map(coin => coin.position)), landed = [];
    for (let position = 0; position < cells; position += 1) {
      if (occupiedPositions.has(position)) continue;
      const draw = this.randomInt(0x100000000) / 0x100000000;
      if (draw >= Number(model.landingProbability || 0)) continue;
      const symbols = model.coinSymbols || symbolRoles(this.profile).coins;
      if (!symbols.length) throw new Error('hold-and-spin model has no coin symbols');
      const symbol = Number(symbols[this.randomInt(symbols.length)]);
      landed.push({ position, symbol, value: this.holdCoinValue(model, symbol) });
    }
    if (landed.length) { feature.occupied.push(...landed); feature.remain = Number(model.resetLives || model.lives || 3); }
    const full = feature.occupied.length >= cells;
    if (full && !feature.fullGridAwarded) { feature.totalWin += Math.round(feature.stake * Number(model.fullGridAward || 0)); feature.fullGridAwarded = true; }
    const landedWin = landed.reduce((sum, coin) => sum + Math.round(feature.stake * coin.value), 0); feature.totalWin += landedWin;
    const final = full || feature.remain === 0;
    if (final) feature.remain = 0;
    const reels = structuredClone(feature.game.result.spins[0].reels);
    const blank = Number(model.blankSymbol ?? 0);
    for (let reel = 0; reel < reels.length; reel += 1) for (let row = 0; row < rows; row += 1) reels[reel][row + 1] = blank;
    for (const coin of feature.occupied) { const reel = Math.floor(coin.position / rows), row = coin.position % rows; if (reels[reel]) reels[reel][row + 1] = coin.symbol; }
    const spin = { entries: [], mutations: [], totalWinAmount: moneyString(landedWin), reels, type: 'HOLDSPIN', bonuses: [], totalWin: landedWin };
    // The client uses count === remain as the *initial feature* guard. Keeping
    // count fixed at three caused every life reset to replay the intro and call
    // hideCoinsContainers twice. Count therefore advances on every respin while
    // remain continues to represent the resettable lives counter.
    const roundCount = Number(feature.count || model.lives || 3) + feature.spinsPlayed;
    // The zero-remain round is the completion handshake. Removing it makes the
    // client lose the feature context before its outro state machine can run.
    const rounds = [{ type: 'HOLDSPIN', remain: feature.remain, count: roundCount, totalWin: feature.totalWin, totalWinAmount: feature.totalWin }];
    const positions = feature.occupied.map(coin => coin.position);
    const values = feature.occupied.map(coin => Math.round(feature.stake * coin.value));
    const bellLink = { pos: positions, val: values, totalWin: feature.totalWin, multiplier: full ? Number(model.fullGridMultiplier || 1) : 1, boost: false };
    const game = { state: { matchId: randomId(), bet: structuredClone(feature.bet), totalWin: moneyString(feature.totalWin), totalWinAmount: moneyString(feature.totalWin), limitOverflow: false, gambles: 0, gambleHistory: [], prizes: [], rounds }, result: { spins: [spin], bellLink, totalWinAmount: moneyString(landedWin), totalWin: landedWin, lastWinAmount: '0', lastWin: '0' } };
    // The Bell Link client reads betResponse.restoreResponse while dismantling
    // the feature. Supplying the pre-feature spin through the native restore
    // envelope lets it restore the base reels and finish its outro state machine.
    if (final) {
      const restorePoint = 'base';
      const restoreResponse = structuredClone(feature.restoreResponse || feature.game.result.spins[0]);
      restoreResponse.bonuses = [];
      game.restore = { [restorePoint]: { restorePoint, spins: [restoreResponse], scatters: [] } };
      game.result.restorePoints = [restorePoint];
    }
    const state = final ? (feature.totalWin > 0 ? 'win' : 'idle') : 'holdspin';
    if (final) { this.balance += feature.totalWin; this.lastWin = feature.totalWin; this.lastSettlement = { reference: String(request.id || randomId()), wagerUnits: 0, winUnits: feature.totalWin }; this.activeFeature = null; }
    else { feature.game = structuredClone(game); }
    this.lastGame = structuredClone(game); this.lastState = state;
    return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game, state, context: {} };
  }
  continueFreeSpins(request, feature) {
    const targetRtp = this.targetRtp / Math.max(1, feature.multiplier);
    const model = feature.mathFeatureModel;
    const outcome = model
      ? this.fixedMathOutcome(feature.stake, feature.bet, model.freeSpinStrips)
      : this.reelReservoir
      ? this.reelReservoir.outcome({ stake: feature.stake, bet: feature.bet, targetRtp, strips: this.profile.settings?.freeSpinFakeReels })
      : this.syntheticOutcome(feature.stake, feature.bet, undefined, { evaluation: feature.evaluation, targetRtp });
    if (!outcome) throw new Error('verified free-spin configuration has no fixed free-spin outcome');
    if (model) {
      const scatter = Number(model.scatterSymbol ?? this.mathConfig?.roles?.scatter), rows = Number(this.mathConfig?.rows || visibleRowCount(this.profile));
      const scatterCount = outcome.spin.reels.reduce((sum, reel) => sum + reel.slice(1, rows + 1).filter(symbol => Number(symbol) === scatter).length, 0);
      if (scatterCount >= Number(model.triggerCount || 3)) feature.remain += Number(typeof model.retriggerSpins === 'object' ? model.retriggerSpins[scatterCount] || 0 : model.retriggerSpins || model.initialSpins || 0);
    }
    const rawWin = outcome.totalWin, win = Math.round(rawWin * feature.multiplier); feature.totalWin += win; feature.remain = Math.max(0, feature.remain);
    const spins = structuredClone(outcome.spins || [outcome.spin]);
    for (const spin of spins) {
      spin.totalWin = Math.round(Number(spin.totalWin || 0) * feature.multiplier); spin.totalWinAmount = moneyString(spin.totalWin);
      for (const entry of spin.entries || []) { entry.win = Math.round(Number(entry.win || 0) * feature.multiplier); entry.winAmount = moneyString(entry.win); entry.multiplier = Number(entry.multiplier || 1) * feature.multiplier; }
      spin.bonuses = feature.remain > 0 ? [{ count: feature.remain, type: 'FREESPIN' }] : [];
    }
    const final = feature.remain === 0, state = final ? 'win' : 'freespin';
    const rounds = [{ type: 'FREESPIN', remain: feature.remain, count: feature.count, totalWin: feature.totalWin, totalWinAmount: feature.totalWin }];
    const game = { state: { matchId: randomId(), bet: structuredClone(feature.bet), totalWin: moneyString(feature.totalWin), totalWinAmount: moneyString(feature.totalWin), limitOverflow: false, gambles: 0, gambleHistory: [], prizes: [], rounds }, result: { spins, totalWinAmount: moneyString(win), totalWin: win, lastWinAmount: '0', lastWin: '0' } };
    if (final) { this.balance += feature.totalWin; this.lastWin = feature.totalWin; this.lastSettlement = { reference: String(request.id || randomId()), wagerUnits: 0, winUnits: feature.totalWin }; this.activeFeature = null; }
    this.lastGame = structuredClone(game); this.lastState = state;
    return { referenceId: request.id, sessionKey: this.sessionKey, event: 'bet', balance: { balance: this.balance, units: 100, currency: 'EGT' }, game, state, context: {} };
  }
  outcome(stake, bet) {
    return this.familyEngine.outcome(this, stake, bet);
  }
  fixedMathOutcome(stake, bet, strips = null) {
    const config = this.mathConfig;
    if (!config) return null;
    return fixedReelOutcome({
      profile: this.profile,
      strips: strips || config.strips,
      paylines: config.paylines,
      roles: config.roles,
      scatters: config.scatters,
      eligibleReels: symbol => config.scatterEligibleReels[symbol] || [],
      stake,
      factor: Number(bet.factor || this.betSettings.factor),
      randomInt: this.randomInt,
      evaluation: config.evaluation,
    });
  }
  fixedCascadeMathOutcome(stake, bet) {
    const config=this.mathConfig;if(!config)return null;
    const model=config.featureModels?.find(feature=>feature.type==='cascade');
    if(!model||!Number.isInteger(model.maxCascades))return null;
    return fixedCascadeOutcome({profile:this.profile,strips:config.strips,roles:config.roles,scatters:config.scatters,eligibleReels:symbol=>config.scatterEligibleReels[symbol]||[],stake,factor:Number(bet.factor||this.betSettings.factor),randomInt:this.randomInt,maxCascades:model.maxCascades});
  }
  reelReservoirOutcome(stake, bet) {
    if (!this.reelReservoir) return this.syntheticOutcome(stake, bet, undefined, { evaluation: 'paylines' });
    return this.reelReservoir.outcome({ stake, bet, targetRtp: this.targetRtp });
  }
  addVisibleScatters(outcome, count, scatter, stake = 0, coefficient = 0) {
    const spins = outcome.spins || [outcome.spin], spin = spins[0];
    if (!spin?.reels || scatter === null) return outcome;
    const occupied = new Set((spin.entries || []).flatMap(entry => {
      const cells = entry.cells || [], values = [];
      for (let index = 0; index < cells.length; index += 2) values.push(`${cells[index]}:${cells[index + 1]}`);
      return values;
    }));
    const strips = this.profile.settings?.fakeReels || [];
    const eligible = spin.reels.map((reel, index) => ({ reel, index })).filter(({ index }) => !Array.isArray(strips[index]) || strips[index].includes(scatter));
    const cells = [];
    for (let placed = 0; placed < count && eligible.length; placed += 1) {
      const picked = Math.floor(this.random() * eligible.length), { reel, index } = eligible.splice(picked, 1)[0];
      const visibleRows = Math.max(1, reel.length - 2);
      const availableRows = Array.from({length:visibleRows},(_,row)=>row).filter(row => !occupied.has(`${index}:${row}`));
      const row = availableRows[Math.floor(this.random() * availableRows.length)] ?? 1;
      reel[Math.min(row + 1, reel.length - 1)] = scatter;
      cells.push(index, row);
    }
    const scatterWin = Math.round(Number(stake) * Number(coefficient));
    if (scatterWin > 0 && cells.length === count * 2) {
      spin.entries ||= [];
      spin.entries.push({ mode: 'scatter', symbol: scatter, winAmount: moneyString(scatterWin), cells, coef: coefficient, multiplier: 1, occurs: count, win: scatterWin });
      spin.totalWin = Number(spin.totalWin || 0) + scatterWin; spin.totalWinAmount = moneyString(spin.totalWin);
      outcome.totalWin = Number(outcome.totalWin || 0) + scatterWin;
    }
    return outcome;
  }
  syntheticOutcome(stake, bet, forcedWon, family = {}) {
    const factor = Number(bet.factor || 1), distribution = weightedPaytable(this.profile, factor);
    const group = distribution.groups[weightedIndex(this.random, distribution.weights)], choice = group.values[weightedIndex(this.random, group.valueWeights)];
    const { symbol: winSymbol, coefficient, multiple: winMultiple } = choice;
    const templateReels = this.profile.eventFamilies?.bet?.find(sample => sample.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels;
    const reelCount = Array.isArray(templateReels) && templateReels.length ? templateReels.length : 5;
    const occurs = Math.min(choice.occurs, reelCount);
    const roles = symbolRoles(this.profile), lineCount = Number(this.profile.settings?.lines || this.profile.settings?.linesOptions?.[0] || 0), paylineGame = lineCount > 0 && lineCount !== 3 ** reelCount;
    // Bell Link expanding wilds require a title-specific mutation payload.
    // A bare wild symbol can start an expansion animation which never receives
    // its completion data, so keep it out of synthesized outcomes for now.
    const supportsSyntheticWild = this.familyEngine.familyId !== 'bell-link';
    const wildChance = paylineGame && roles.wild !== null && supportsSyntheticWild ? 0.25 : 0;
    const targetRtp = Number(family.targetRtp ?? this.targetRtp);
    const maximumPackageLines = paylineGame ? Number(group.packageLines || 1) : 1;
    const minimumPackageLines = paylineGame ? Number(group.minimumPackageLines || maximumPackageLines) : 1;
    const packageLines = minimumPackageLines + Math.floor(this.random() * (maximumPackageLines - minimumPackageLines + 1));
    const expectedMean = wildChance > 0 ? distribution.wildAdjustedMean : distribution.mean;
    const rawWinProbability = targetRtp / 100 / expectedMean;
    // RTP is not hit frequency. Bell Link's many small line awards can otherwise
    // make rawRtp/mean approach one (BLBL at 80% was 97.2%), producing a win on
    // practically every spin. Keep base-game hit rate within a plausible ceiling;
    // feature/jackpot mathematics must carry the remainder once implemented.
    const hitFrequencyCeiling = this.familyEngine.familyId === 'bell-link' ? 0.30 : 1;
    const winProbability = Math.min(hitFrequencyCeiling, Math.max(0, rawWinProbability));
    const won = forcedWon === undefined ? this.random() < winProbability : forcedWon, generated = this.reels(won, winSymbol, occurs, templateReels, family.evaluation), reels = generated.reels;
    const substitutedWild = won && wildChance > 0 && this.random() < wildChance;
    if (substitutedWild) {
      const reel = Math.min(1, occurs - 1), row = generated.cells[reel * 2 + 1];
      reels[reel][Math.min(row + 1, reels[reel].length - 1)] = roles.wild;
    }
    let totalWin = 0, entries = [];
    if (won && generated.mode === 'line') {
      const paylines = paylinesFor(this.profile, templateReels);
      const lineIndexes = randomLineIndexes(this.random, generated.line, packageLines, paylines);
      entries = lineIndexes.map(line => {
        const rows = paylines[line], cells = Array.from({ length: occurs }, (_, reel) => [reel, rows[reel]]).flat();
        for (let reel = 0; reel < occurs; reel += 1) reels[reel][Math.min(rows[reel] + 1, reels[reel].length - 1)] = winSymbol;
        const includesWild = substitutedWild && cells.some((value, index) => index % 2 === 0 && value === Math.min(1, occurs - 1) && cells[index + 1] === generated.cells[Math.min(1, occurs - 1) * 2 + 1]);
        const win = Math.round(stake * winMultiple * (includesWild ? 2 : 1)); totalWin += win;
        return { mode: 'line', symbol: winSymbol, winAmount: moneyString(win), cells, coef: coefficient, multiplier: includesWild ? 2 : 1, occurs, win, line };
      });
      if (occurs < reelCount) {
        const blocker = ordinarySymbols(this.profile).find(symbol => symbol !== winSymbol) ?? 0;
        for (const line of lineIndexes) { const row = paylines[line][occurs]; reels[occurs][Math.min(row + 1, reels[occurs].length - 1)] = blocker; }
      }
      if (substitutedWild) {
        const reel = Math.min(1, occurs - 1), row = generated.cells[reel * 2 + 1];
        reels[reel][Math.min(row + 1, reels[reel].length - 1)] = roles.wild;
      }
    } else if (won) {
      totalWin = Math.round(stake * winMultiple * (substitutedWild ? 2 : 1));
      entries = [{ mode: generated.mode, symbol: winSymbol, winAmount: moneyString(totalWin), cells: generated.cells, coef: coefficient, multiplier: substitutedWild ? 2 : 1, occurs, win: totalWin, ways: 1 }];
    }
    const spin = { entries, mutations: [], totalWinAmount: moneyString(totalWin), reels, type: 'SPIN', bonuses: [], totalWin };
    if (won && generated.cascade) {
      const terminal = this.reels(false, winSymbol, occurs, templateReels);
      return { totalWin, spin, spins: [spin, { entries: [], mutations: [], totalWinAmount: '0', reels: terminal.reels, type: 'SPIN', bonuses: [], totalWin: 0 }] };
    }
    return { totalWin, spin };
  }
  reels(won, symbol, occurs = 3, templateReels, evaluation = '') {
    const pool = ordinarySymbols(this.profile);
    const safe = pool.length >= 5 ? pool : [0,1,2,3,4,5,6,7];
    const shape = Array.isArray(templateReels) && templateReels.length ? templateReels : Array.from({ length: 5 }, () => Array(5));
    const lineCount = Number(this.profile.settings?.lines || this.profile.settings?.linesOptions?.[0] || 0);
    const usesWays = evaluation === 'ways' || (!evaluation && lineCount === 3 ** shape.length);
    const usesPaylines = evaluation === 'paylines' || (!evaluation && lineCount > 0 && !usesWays);
    const paylines = paylinesFor(this.profile, shape);
    const line = usesPaylines ? Math.floor(this.random() * paylines.length) : 0;
    const rowsForLine = paylines[line] || paylines[0];
    const waysRows = Array.from({ length: occurs }, () => Math.floor(this.random() * 3));
    const cells = Array.from({ length: occurs }, (_, reel) => [reel, usesPaylines ? rowsForLine[reel] : usesWays ? waysRows[reel] : 1]).flat();
    const wild = symbolRoles(this.profile).wild;
    const paylineMatches = candidate => paylines.map((rows, index) => {
      const values = candidate.slice(0, 3).map((reel, reelIndex) => reel[rows[reelIndex] + 1]);
      const base = values.find(value => value !== wild);
      return values.length === 3 && base !== undefined && values.every(value => value === base || value === wild) ? index : -1;
    }).filter(index => index >= 0);
    const waysMatches = candidate => {
      let common = new Set(candidate[0]?.slice(1, 4) || []);
      for (let reel = 1; reel < Math.min(3, candidate.length); reel += 1) common = new Set((candidate[reel]?.slice(1, 4) || []).filter(symbol => common.has(symbol)));
      return common;
    };
    let reels, key;
    // A fresh independently sampled grid prevents the tiny captured sample set from
    // becoming a visible three-result loop. Avoid even an immediate full-grid repeat.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      reels = shape.map(rows => Array.from({ length: Math.max(1, Array.isArray(rows) ? rows.length : 5) }, () => safe[Math.floor(this.random() * safe.length)]));
      if (won) for (let reel = 0; reel < Math.min(occurs, reels.length); reel += 1) {
        const visibleRow = usesPaylines ? rowsForLine[reel] : usesWays ? waysRows[reel] : 1;
        reels[reel][Math.min(visibleRow + 1, reels[reel].length - 1)] = symbol;
      }
      key = JSON.stringify(reels);
      const matches = usesPaylines ? paylineMatches(reels) : [];
      const validPaylines = !usesPaylines || (won ? matches.length === 1 && matches[0] === line : matches.length === 0);
      const matchingWays = usesWays ? waysMatches(reels) : new Set();
      const validWays = !usesWays || (won ? matchingWays.size === 1 && matchingWays.has(symbol) : matchingWays.size === 0);
      if (key !== this.lastReelsKey && validPaylines && validWays) break;
    }
    this.lastReelsKey = key;
    return { reels, line, cells, mode: usesWays ? 'ways' : 'line', cascade: usesWays && isCascadeFamily(this.profile, this.gameKey) };
  }
}

module.exports = { ALLOWED_STAKE_UNITS, EgtLocalSession, PAYLINES_20, PAYLINES_40_4ROW, globallyLimitedBetSettings, ordinarySymbols, outcomeOccurrenceLikelihood, paylinesFor, weightedPaytable, sockJsDecode, sockJsEncode };
