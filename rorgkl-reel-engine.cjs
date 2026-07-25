const { symbolRoles } = require('./egt-family-engines.cjs');

const PAYLINES = [
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[0,1,1,1,0],
  [2,1,1,1,2],[1,0,1,2,1],[1,2,1,0,1],[0,1,0,1,0],[2,1,2,1,2],
  [1,1,0,1,1],[1,1,2,1,1],[0,2,0,2,0],[2,0,2,0,2],[0,2,2,2,0],
];

function money(value) { return String(Math.max(0, Math.round(value))); }
function shuffle(random, values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const picked = Math.floor(random() * (index + 1));
    [values[index], values[picked]] = [values[picked], values[index]];
  }
  return values;
}

class RorgklReelReservoir {
  constructor({ profile, random }) {
    this.profile = profile;
    this.random = random;
    this.queue = [];
    this.key = '';
    this.generation = 0;
    this.lastStats = null;
    // 15 spins on RORGKL's alternate strips, including the documented x3.
    // Measured from 200,000 untouched strip stops; this is used only to reserve
    // RTP for a trigger, never to alter the feature's random outcomes.
    this.freeSpinFeatureExpectedMultiple = 22.67981;
    this.baseTriggerProbability = 0.002985;
  }

  candidate(factor, targetRtp, configuredStrips) {
    const strips = configuredStrips || this.profile.settings?.fakeReels;
    if (!Array.isArray(strips) || strips.length !== 5 || strips.some(strip => !Array.isArray(strip) || !strip.length)) throw new Error('RORGKL reel strips unavailable');
    const roles = symbolRoles(this.profile), paytable = this.profile.settings?.paytable || {};
    let reels;
    // Symbol 13 is a Gods & Kings jackpot activator. It requires a separate
    // mutation/feature payload and renders blank when sent as an ordinary stop.
    // Until that protocol is authored, choose another complete strip window;
    // never replace an individual symbol after the reels have stopped.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reels = strips.map(strip => {
        const stop = Math.floor(this.random() * strip.length);
        return [-2, -1, 0, 1, 2].map(offset => strip[(stop + offset + strip.length) % strip.length]);
      });
      if (!reels.some(reel => reel.slice(1, 4).some(symbol => roles.coins.includes(symbol)))) break;
    }
    const entries = [];
    let lineMultiple = 0;
    for (let line = 0; line < PAYLINES.length; line += 1) {
      const rows = PAYLINES[line], values = rows.map((row, reel) => reels[reel][row + 1]);
      const base = values.find(symbol => symbol !== roles.wild);
      if (base === undefined || base === roles.scatter || roles.coins.includes(base) || !paytable[base]) continue;
      let occurs = 0, substitutedWild = false;
      for (const symbol of values) {
        if (symbol !== base && symbol !== roles.wild) break;
        occurs += 1; substitutedWild ||= symbol === roles.wild;
      }
      // Coefficient arrays are right-aligned to a five-reel game: four values
      // mean 2/3/4/5-of-a-kind and three values mean 3/4/5-of-a-kind.
      const coefficients = paytable[base].coef || [], minimum = 6 - coefficients.length;
      const coefficient = Number(coefficients[occurs - minimum] || 0);
      if (!coefficient) continue;
      const multiplier = substitutedWild && values.slice(0, occurs).some(symbol => symbol !== roles.wild) ? 2 : 1;
      const multiple = coefficient / factor * multiplier;
      lineMultiple += multiple;
      entries.push({ mode: 'line', symbol: base, coefficient, multiplier, occurs, multiple, line, cells: Array.from({ length: occurs }, (_, reel) => [reel, rows[reel]]).flat() });
    }
    const scatterCells = [];
    for (let reel = 0; reel < reels.length; reel += 1) for (let row = 0; row < 3; row += 1) if (reels[reel][row + 1] === roles.scatter) scatterCells.push(reel, row);
    // RORGKL's scatter table is explicitly 2/3/4/5 symbols, unlike the
    // right-aligned line tables.
    const scatterCount = scatterCells.length / 2, scatterCoefficients = paytable[roles.scatter]?.coef || [], scatterMinimum = 2;
    const scatterCoefficient = Number(scatterCoefficients[scatterCount - scatterMinimum] || 0);
    const triggersFreeSpins = scatterCount >= 3;
    const scatterMultiple = !triggersFreeSpins && scatterCoefficient > 0 ? scatterCoefficient : 0;
    // The feature consumes no additional wager. Its expected contribution is
    // represented during reservoir selection; the actual feature spins remain random.
    const estimatedFeatureMultiple = triggersFreeSpins ? this.freeSpinFeatureExpectedMultiple : 0;
    return { reels, entries, scatterCells, scatterCount, scatterCoefficient, triggersFreeSpins, lineMultiple, scatterMultiple, estimatedMultiple: lineMultiple + scatterMultiple + estimatedFeatureMultiple, selectionRandom: Math.max(Number.EPSILON, this.random()) };
  }

  selectedByBias(candidates, count, lambda) {
    return candidates.map(candidate => {
      const exponent = Math.max(-50, Math.min(50, -lambda * Math.min(50, candidate.estimatedMultiple)));
      const weight = Math.exp(exponent);
      return { candidate, key: -Math.log(candidate.selectionRandom) / weight };
    }).sort((left, right) => left.key - right.key).slice(0, count).map(item => item.candidate);
  }

  refill({ factor, targetRtp, size = 10000, untouched = 500 }) {
    const controlledCount = size - untouched, poolSize = Math.max(controlledCount * 10, controlledCount + 50000);
    const raw = Array.from({ length: untouched }, () => ({ ...this.candidate(factor, targetRtp), controlled: false }));
    const pool = Array.from({ length: poolSize }, () => this.candidate(factor, targetRtp));
    const targetTotal = size * targetRtp / 100;
    const rawTotal = raw.reduce((sum, item) => sum + item.estimatedMultiple, 0);
    const controlledTarget = Math.max(0, targetTotal - rawTotal);
    // Negative bias promotes naturally high-paying grids when the raw strips
    // return below target; positive bias suppresses them when they return above.
    const triggerCount = Math.round(controlledCount * this.baseTriggerProbability);
    const triggerPool = pool.filter(candidate => candidate.triggersFreeSpins).sort((left, right) => left.selectionRandom - right.selectionRandom);
    const selectedTriggers = triggerPool.slice(0, triggerCount);
    const ordinaryPool = pool.filter(candidate => !candidate.triggersFreeSpins);
    const ordinaryCount = controlledCount - selectedTriggers.length;
    const ordinaryTarget = Math.max(0, controlledTarget - selectedTriggers.reduce((sum, item) => sum + item.estimatedMultiple, 0));
    let low = -20, high = 20, selectedOrdinary = this.selectedByBias(ordinaryPool, ordinaryCount, 0);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const lambda = (low + high) / 2, trial = this.selectedByBias(ordinaryPool, ordinaryCount, lambda);
      const total = trial.reduce((sum, item) => sum + item.estimatedMultiple, 0);
      selectedOrdinary = trial;
      if (total > ordinaryTarget) low = lambda; else high = lambda;
    }
    const selected = [...selectedTriggers, ...selectedOrdinary];
    const controlled = selected.map(candidate => ({ ...candidate, controlled: true }));
    this.queue = shuffle(this.random, [...raw, ...controlled]);
    this.generation += 1;
    const estimatedTotal = this.queue.reduce((sum, item) => sum + item.estimatedMultiple, 0);
    this.lastStats = { generation: this.generation, size, untouched, controlled: controlledCount, targetRtp, estimatedRtp: estimatedTotal / size * 100 };
  }

  next({ factor, targetRtp }) {
    const key = `${factor}:${targetRtp}`;
    if (key !== this.key || !this.queue.length) { this.key = key; this.refill({ factor, targetRtp }); }
    return this.queue.shift();
  }

  outcome({ stake, bet, targetRtp, candidate: suppliedCandidate, strips }) {
    const factor = Math.max(1, Number(bet.factor || 1)), candidate = suppliedCandidate || (strips ? this.candidate(factor, targetRtp, strips) : this.next({ factor, targetRtp }));
    const entries = candidate.entries.map(entry => {
      const win = Math.round(stake * entry.multiple);
      return { mode: entry.mode, symbol: entry.symbol, winAmount: money(win), cells: entry.cells, coef: entry.coefficient, multiplier: entry.multiplier, occurs: entry.occurs, win, line: entry.line };
    });
    if (!candidate.triggersFreeSpins && candidate.scatterMultiple > 0) {
      const win = Math.round(stake * candidate.scatterMultiple);
      entries.push({ mode: 'scatter', symbol: symbolRoles(this.profile).scatter, winAmount: money(win), cells: candidate.scatterCells, coef: candidate.scatterCoefficient, multiplier: 1, occurs: candidate.scatterCount, win });
    }
    const totalWin = entries.reduce((sum, entry) => sum + entry.win, 0);
    return { totalWin, spin: { entries, mutations: [], totalWinAmount: money(totalWin), reels: candidate.reels, type: 'SPIN', bonuses: [], totalWin }, candidate, reservoirStats: this.lastStats };
  }
}

module.exports = { PAYLINES, RorgklReelReservoir };
