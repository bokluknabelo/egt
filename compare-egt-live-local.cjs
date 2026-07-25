const fs = require('fs');
const path = require('path');
process.env.EGT_REPLAY_CAPTURED_PROFILE ||= '1';
const { EgtLocalSession, sockJsDecode, sockJsEncode } = require('./egt-local-engine.cjs');
const { classifyFamily } = require('./egt-family-engines.cjs');

const FEATURE_STATES = new Set(['holdspin', 'freespin', 'respin', 'freeRespin', 'highCashFreeRespin', 'bonusChance', 'pick', 'jackpotPick', 'pickFreeGamesConfig']);

function filesFromArgs(args) {
  const files = [];
  const isCapture = file => file.endsWith('.json') && !/(^|\/)(manifest|local-compare)[^/]*\.json$/.test(file);
  for (const arg of args) {
    if (!fs.existsSync(arg)) continue;
    const stat = fs.statSync(arg);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(arg).sort()) {
        const file = path.join(arg, name);
        if (isCapture(file)) files.push(file);
      }
    } else if (isCapture(arg)) files.push(arg);
  }
  return files;
}

function keySet(value, prefix = '', out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.add(next);
    if (child && typeof child === 'object' && !Array.isArray(child)) keySet(child, next, out);
  }
  return out;
}

function random(seed = 0xdecafbad) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomIntFrom(randomFn) {
  return max => Math.floor(randomFn() * max);
}

function send(engine, request) {
  const responses = engine.messages(sockJsEncode(request)).flatMap(sockJsDecode);
  const settlement = engine.consumeSettlement();
  return { responses, settlement };
}

function summarize(messages) {
  const states = {}, eventStates = {}, events = {}, schemas = {};
  for (const message of messages) {
    if (message.event) events[message.event] = (events[message.event] || 0) + 1;
    if (message.state) states[message.state] = (states[message.state] || 0) + 1;
    const eventState = `${message.event || ''}:${message.state || ''}`;
    eventStates[eventState] = (eventStates[eventState] || 0) + 1;
    const bucket = schemas[eventState] ||= new Set();
    for (const key of keySet(message)) bucket.add(key);
  }
  return { states, eventStates, events, schemas: Object.fromEntries(Object.entries(schemas).map(([key, value]) => [key, [...value].sort()])) };
}

function liveSummary(capture) {
  const messages = (capture.messages || []).filter(item => item.direction === 'server').map(item => item.message).filter(Boolean);
  return summarize(messages);
}

function missingKeys(expected, actual) {
  return Object.keys(expected || {}).filter(key => !Object.prototype.hasOwnProperty.call(actual || {}, key)).sort();
}

function localRun({ gameKey, profile, bet, target = 250 }) {
  const rand = random([...gameKey].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 1);
  const engine = new EgtLocalSession({ profile, gameKey, balanceUnits: 5_000_000, targetRtp: 95, random: rand, randomInt: randomIntFrom(rand), enableFixedMath: false, replayCapturedProfile: true });
  const messages = [];
  let id = 1, betResponses = 0, guard = 0;
  messages.push(...send(engine, { event: 'loadGame', context: { clientVersion: 'local-compare', browser: 'Node' }, id: id++ }).responses);
  messages.push(...engine.pushMessages('jpstats').flatMap(sockJsDecode));
  messages.push(...engine.pushMessages('jpwinner').flatMap(sockJsDecode));
  while (betResponses < target && guard++ < target * 5) {
    const { responses } = send(engine, { event: 'bet', bet, context: {}, id: id++ });
    messages.push(...responses);
    for (const response of responses) {
      if (response.event === 'bet') betResponses += 1;
      if (['pick', 'jackpotPick'].includes(response.state)) {
        const pick = send(engine, { event: 'pick', context: { choice: 0 }, id: id++ }).responses;
        messages.push(...pick);
      }
    }
  }
  return { betResponses, messages, summary: summarize(messages), errors: messages.filter(message => message.error) };
}

function compare(file) {
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gameKey = capture.gameKey;
  const profilePath = path.join(__dirname, 'data', 'egt-profiles', `${gameKey}.json`);
  if (!fs.existsSync(profilePath)) return { gameKey, file, status: 'missing-profile' };
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.gameKey = gameKey;
  const live = liveSummary(capture);
  const bet = capture.bet || capture.messages?.find(item => item.direction === 'server' && item.event === 'loadGame')?.message?.game?.state?.bet;
  const local = localRun({ gameKey, profile, bet, target: Number(process.env.EGT_COMPARE_SPINS || 250) });
  const liveFeatureStates = Object.keys(live.states).filter(state => FEATURE_STATES.has(state)).sort();
  const localFeatureStates = Object.keys(local.summary.states).filter(state => FEATURE_STATES.has(state)).sort();
  const missingStates = missingKeys(live.states, local.summary.states);
  const missingEventStates = missingKeys(live.eventStates, local.summary.eventStates);
  const schemaGaps = [];
  for (const [eventState, keys] of Object.entries(live.schemas)) {
    const localKeys = new Set(local.summary.schemas[eventState] || []);
    const missing = keys.filter(key => !localKeys.has(key) && !/^referenceId$|^sessionKey$|^balance/.test(key));
    if (missing.length) schemaGaps.push({ eventState, missing: missing.slice(0, 40), missingCount: missing.length });
  }
  return {
    gameKey,
    file,
    family: classifyFamily(profile),
    status: missingStates.length || missingEventStates.length || schemaGaps.length || local.errors.length ? 'mismatch' : 'match',
    liveSpins: capture.spins,
    localBetResponses: local.betResponses,
    bet,
    liveStates: live.states,
    localStates: local.summary.states,
    liveFeatureStates,
    localFeatureStates,
    missingStates,
    missingEventStates,
    schemaGaps: schemaGaps.slice(0, 12),
    localErrors: local.errors.slice(0, 5).map(error => ({ event: error.event, state: error.state, error: error.error })),
  };
}

const files = filesFromArgs(process.argv.slice(2));
if (!files.length) throw new Error('usage: node compare-egt-live-local.cjs <capture.json|directory> [...]');
const comparisons = files.map(compare);
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), count: comparisons.length, mismatches: comparisons.filter(item => item.status !== 'match').length, comparisons }, null, 2)}\n`);
