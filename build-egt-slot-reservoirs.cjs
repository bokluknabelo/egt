const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FEATURE_STATES, responseWin, shuffledIndexes } = require('./egt-slot-reservoir.cjs');

const outputDir = path.join(__dirname, 'data', 'egt-slot-reservoirs');
const sourceDirs = ['output/live-goal-1000', 'output/live-goal-5000'];
const requested = new Set(process.argv.slice(2));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stakeFromBet(bet) {
  return Math.round(Number(bet?.level || 0) * Number(bet?.factor || 1) * Number(bet?.denomination || 1));
}

function marker(prefix, index) {
  return `${prefix}${String(index + 1).padStart(6, '0')}`;
}

function requestMap(messages) {
  const map = new Map();
  for (const item of messages || []) {
    if (item.direction !== 'client' || item.message?.id == null) continue;
    map.set(`${item.connectionId || ''}:${item.message.id}`, item.message);
    map.set(String(item.message.id), item.message);
  }
  return map;
}

function requestFor(requests, item) {
  const id = item.message?.referenceId;
  return requests.get(`${item.connectionId || ''}:${id}`) || requests.get(String(id)) || null;
}

function hasFeatureState(message) {
  return FEATURE_STATES.has(message?.state);
}

function hasJackpot(message) {
  return /jackpot|winner/i.test(String(message?.event || ''))
    || Boolean(message?.jackpotWinner)
    || Boolean(message?.game?.result?.jpw?.length);
}

function closeRound(round) {
  const messages = round.messages;
  const states = [...new Set(messages.map(message => message.state).filter(Boolean))];
  const eventStates = [...new Set(messages.map(message => `${message.event || ''}:${message.state || ''}`))];
  const feature = messages.some(hasFeatureState);
  const jackpot = messages.some(hasJackpot);
  const final = messages.at(-1) || {};
  const totalWin = Math.max(0, ...messages.map(responseWin), responseWin(final));
  round.totalWin = totalWin;
  round.states = states;
  round.eventStates = eventStates;
  round.tags = [...new Set([
    totalWin > 0 ? 'WIN' : 'LOSS',
    feature ? 'FEATURE' : null,
    jackpot ? 'JACKPOT' : null,
    ...states,
    ...messages.flatMap(message => (message.game?.result?.spins || []).flatMap(spin => [spin.type, ...(spin.bonuses || []).map(bonus => bonus.type || bonus.feature || 'bonus')]))
  ].filter(Boolean))];
  round.kind = jackpot ? 'jackpot_episode' : feature ? 'feature_episode' : totalWin > 0 ? 'ordinary_win' : 'loss';
  return round;
}

function parseCapture(file) {
  const capture = readJson(file);
  if ((capture.errors || []).length || Number(capture.spins) < Number(capture.spinsTarget || capture.spins || 0)) {
    return { capture, file, skipped: true, reason: `partial-or-error spins=${capture.spins} target=${capture.spinsTarget} errors=${(capture.errors || []).length}` };
  }
  const requests = requestMap(capture.messages || []);
  const rounds = [];
  let current = null;
  for (const item of capture.messages || []) {
    const message = item.message;
    if (item.direction !== 'server' || !message || message.error || !['bet', 'pick'].includes(message.event)) continue;
    const request = requestFor(requests, item);
    if (!current) {
      const bet = request?.bet || message.game?.state?.bet || capture.bet || null;
      current = {
        sourceFile: file,
        sourceStartSequence: item.sequence,
        bet,
        stake: stakeFromBet(bet),
        messages: [],
      };
    }
    current.messages.push(message);
    const state = message.state || '';
    const terminal = !FEATURE_STATES.has(state) && ['idle', 'win'].includes(state);
    if (terminal || (!current.messages.some(hasFeatureState) && message.event === 'bet')) {
      rounds.push(closeRound(current));
      current = null;
    }
  }
  if (current?.messages?.length) rounds.push(closeRound(current));
  return { capture, file, rounds };
}

function sourceFilesFor(gameKey) {
  const files = [];
  for (const dir of sourceDirs) {
    const suffix = dir.includes('5000') ? '5000' : '1000';
    const file = path.join(__dirname, dir, `${gameKey}-${suffix}.json`);
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function discoverGameKeys() {
  const keys = new Set();
  for (const dir of sourceDirs) {
    const absolute = path.join(__dirname, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute)) {
      const match = name.match(/^(.+)-(?:1000|5000)\.json$/);
      if (match) keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function build(gameKey) {
  const sourceFiles = sourceFilesFor(gameKey);
  const parsed = sourceFiles.map(parseCapture);
  const skipped = parsed.filter(item => item.skipped).map(item => ({ file: item.file, reason: item.reason }));
  const included = parsed.filter(item => !item.skipped);
  const rounds = included.flatMap(item => item.rounds);
  for (let index = 0; index < rounds.length; index += 1) {
    rounds[index].id = `${gameKey}-R${String(index + 1).padStart(6, '0')}`;
    rounds[index].winMarker = Number(rounds[index].totalWin || 0) > 0 ? marker('W', index) : null;
    rounds[index].eventMarker = rounds[index].kind !== 'loss' && rounds[index].kind !== 'ordinary_win' ? marker('E', index) : null;
    rounds[index].messages = rounds[index].messages.map((message, responseIndex) => ({ ...message, reservoirMarker: `${rounds[index].id}-M${responseIndex + 1}` }));
  }
  const totalBet = rounds.reduce((sum, round) => sum + Number(round.stake || 0), 0);
  const totalWin = rounds.reduce((sum, round) => sum + Number(round.totalWin || 0), 0);
  const bagIndexes = shuffledIndexes(rounds, Number(process.env.EGT_RESERVOIR_SHUFFLES || 5), max => crypto.randomInt(max));
  const reservoir = {
    schemaVersion: 1,
    gameKey,
    generatedAt: new Date().toISOString(),
    sourceFiles: included.map(item => ({ file: path.relative(__dirname, item.file), spins: item.capture.spins, states: item.capture.states, errors: (item.capture.errors || []).length })),
    skipped,
    stats: {
      rounds: rounds.length,
      responses: rounds.reduce((sum, round) => sum + round.messages.length, 0),
      totalBet,
      totalWin,
      rtp: totalBet ? (totalWin / totalBet) * 100 : 0,
      wins: rounds.filter(round => round.totalWin > 0).length,
      events: rounds.filter(round => round.eventMarker).length,
      kinds: rounds.reduce((acc, round) => (acc[round.kind] = (acc[round.kind] || 0) + 1, acc), {}),
    },
    rounds,
    bags: [{ id: 'shuffle-5x', copies: Number(process.env.EGT_RESERVOIR_SHUFFLES || 5), indexes: bagIndexes }],
  };
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const output = path.join(outputDir, `${gameKey}.json`);
  fs.writeFileSync(output, `${JSON.stringify(reservoir, null, 2)}\n`, { mode: 0o600 });
  return { output, gameKey, skipped, stats: reservoir.stats };
}

const keys = requested.size ? [...requested] : discoverGameKeys();
const results = keys.map(build);
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, results }, null, 2)}\n`);
