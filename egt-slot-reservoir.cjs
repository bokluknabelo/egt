const fs = require('fs');
const path = require('path');

const RESERVOIR_DIR = path.join(__dirname, 'data', 'egt-slot-reservoirs');
const FEATURE_STATES = new Set(['holdspin', 'freespin', 'respin', 'freeRespin', 'highCashFreeRespin', 'bonusChance', 'pick', 'jackpotPick', 'pickFreeGamesConfig']);
const cache = new Map();

function moneyNumber(...values) {
  for (const value of values.flat()) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function loadSlotReservoir(gameKey) {
  if (!gameKey) return null;
  if (cache.has(gameKey)) return cache.get(gameKey);
  const file = path.join(RESERVOIR_DIR, `${gameKey}.json`);
  if (!fs.existsSync(file)) { cache.set(gameKey, null); return null; }
  const reservoir = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(gameKey, reservoir);
  return reservoir;
}

function responseWin(message) {
  return moneyNumber(message?.game?.state?.totalWinAmount, message?.game?.state?.totalWin, message?.game?.result?.totalWinAmount, message?.game?.result?.totalWin);
}

function normalizeReplayMessage(template, { request, sessionKey, balance, bet }) {
  const response = clone(template);
  response.referenceId = request.id;
  response.sessionKey = sessionKey;
  response.event = request.event;
  response.balance = { ...(response.balance || {}), balance, units: Number(response.balance?.units || 100), currency: response.balance?.currency || 'EGT' };
  if (response.game?.state) {
    response.game.state.matchId = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    if (bet) response.game.state.bet = clone(bet);
  }
  return response;
}

function shuffledIndexes(rounds, copies = 5, randomInt = max => Math.floor(Math.random() * max)) {
  const indexes = [];
  for (let copy = 0; copy < copies; copy += 1) for (let index = 0; index < rounds.length; index += 1) indexes.push(index);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [indexes[index], indexes[swap]] = [indexes[swap], indexes[index]];
  }
  return indexes;
}

class SlotReservoirRunner {
  constructor({ reservoir, targetRtp = 100, random = Math.random, randomInt = max => Math.floor(Math.random() * max) }) {
    this.reservoir = reservoir;
    this.targetRtp = Number(targetRtp);
    this.random = random;
    this.randomInt = randomInt;
    this.cursor = 0;
    this.bag = [];
  }

  refill() {
    const source = Array.isArray(this.reservoir?.bags?.[0]?.indexes) && this.reservoir.bags[0].indexes.length
      ? this.reservoir.bags[0].indexes
      : shuffledIndexes(this.reservoir.rounds || [], 5, this.randomInt);
    this.bag = source.slice();
    for (let index = this.bag.length - 1; index > 0; index -= 1) {
      const swap = this.randomInt(index + 1);
      [this.bag[index], this.bag[swap]] = [this.bag[swap], this.bag[index]];
    }
    this.cursor = 0;
  }

  nextRawRound() {
    if (!this.bag.length || this.cursor >= this.bag.length) this.refill();
    const index = this.bag[this.cursor++];
    return this.reservoir.rounds[index] || null;
  }

  nextRound() {
    const baseRtp = Number(this.reservoir?.stats?.rtp || 0);
    const targetRtp = Number(this.targetRtp || 100);
    const winKeepProbability = baseRtp > 0 && targetRtp < baseRtp ? Math.max(0, Math.min(1, targetRtp / baseRtp)) : 1;
    for (let guard = 0; guard < Math.max(50, this.bag.length || 0); guard += 1) {
      const round = this.nextRawRound();
      if (!round) return null;
      if (Number(round.totalWin || 0) <= 0 || this.random() <= winKeepProbability) return round;
      const replacement = this.findLossReplacement();
      if (replacement) return replacement;
    }
    return this.nextRawRound();
  }

  findLossReplacement() {
    for (let guard = 0; guard < Math.min(1000, this.bag.length || 0); guard += 1) {
      const round = this.nextRawRound();
      if (round && Number(round.totalWin || 0) <= 0) return round;
    }
    return null;
  }
}

module.exports = {
  FEATURE_STATES,
  SlotReservoirRunner,
  loadSlotReservoir,
  normalizeReplayMessage,
  responseWin,
  shuffledIndexes,
};
