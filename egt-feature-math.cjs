function assertProbability(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
}

function distributionEntries(distribution, name) {
  const entries = Object.entries(distribution || {}).map(([count, probability]) => [Number(count), Number(probability)]);
  let total = 0;
  for (const [count, probability] of entries) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError(`${name} count must be a non-negative integer`);
    assertProbability(probability, `${name}[${count}]`); total += probability;
  }
  if (total > 1 + 1e-12) throw new RangeError(`${name} probabilities exceed one`);
  return entries;
}

function awardForCount(awards, count) {
  if (typeof awards === 'number') return awards;
  return Number(awards?.[count] || 0);
}

// Slotopol's free-game parsheet calculations compose the regular trigger rate
// with the expected retriggered free-game length. This is the closed-form
// equivalent for stationary free-spin reels.
function exactFreeSpinMath({ triggerDistribution, initialSpins, freeSpinRtpPerSpin, retriggerDistribution = {}, retriggerSpins = initialSpins, multiplier = 1 }) {
  const triggers = distributionEntries(triggerDistribution, 'triggerDistribution');
  const retriggers = distributionEntries(retriggerDistribution, 'retriggerDistribution');
  const triggerProbability = triggers.reduce((sum, [, probability]) => sum + probability, 0);
  const initialSpinExpectation = triggers.reduce((sum, [count, probability]) => sum + probability * awardForCount(initialSpins, count), 0);
  const retriggerSpinExpectation = retriggers.reduce((sum, [count, probability]) => sum + probability * awardForCount(retriggerSpins, count), 0);
  if (retriggerSpinExpectation >= 1) throw new RangeError('free-spin retrigger process does not terminate');
  const expectedFreeSpinsPerPaidSpin = initialSpinExpectation / (1 - retriggerSpinExpectation);
  const rtp = expectedFreeSpinsPerPaidSpin * Number(freeSpinRtpPerSpin) * Number(multiplier);
  return Object.freeze({
    type: 'free-spins',
    triggerProbability,
    triggerHitFrequency: triggerProbability ? 1 / triggerProbability : Infinity,
    retriggerSpinExpectation,
    expectedFreeSpinsPerTrigger: triggerProbability ? expectedFreeSpinsPerPaidSpin / triggerProbability : 0,
    expectedFreeSpinsPerPaidSpin,
    rtp,
  });
}

function binomialProbability(trials, hits, probability) {
  let combinations = 1;
  for (let index = 1; index <= hits; index += 1) combinations *= (trials - hits + index) / index;
  return combinations * probability ** hits * (1 - probability) ** (trials - hits);
}

// Exact finite-state hold-and-spin model. State is (occupied cells, lives).
// A landing resets lives; an empty respin consumes one. No simulated outcomes
// or preselected win buckets are involved.
function exactHoldSpinFromState({ cells, occupied, lives = 3, resetLives = 3, landingProbability, meanCoinValue, fullGridAward = 0 }) {
  if (!Number.isInteger(cells) || cells < 1) throw new TypeError('cells must be a positive integer');
  if (!Number.isInteger(occupied) || occupied < 0 || occupied > cells) throw new TypeError('occupied must be within the grid');
  assertProbability(landingProbability, 'landingProbability');
  const memo = new Map();
  function visit(filled, remainingLives) {
    if (filled >= cells || remainingLives <= 0) return { payout: filled >= cells ? Number(fullGridAward) : 0, respins: 0 };
    const key = `${filled}:${remainingLives}`;
    if (memo.has(key)) return memo.get(key);
    const empty = cells - filled;
    let payout = 0, respins = 1;
    for (let hits = 0; hits <= empty; hits += 1) {
      const probability = binomialProbability(empty, hits, landingProbability);
      const next = visit(filled + hits, hits ? resetLives : remainingLives - 1);
      payout += probability * (hits * Number(meanCoinValue) + next.payout);
      respins += probability * next.respins;
    }
    const result = Object.freeze({ payout, respins }); memo.set(key, result); return result;
  }
  return visit(occupied, lives);
}

function exactHoldSpinMath({ triggerDistribution, cells, initialOccupied, initialCoinValue = null, lives = 3, resetLives = 3, landingProbability, meanCoinValue, fullGridAward = 0 }) {
  const triggers = distributionEntries(triggerDistribution, 'triggerDistribution');
  let rtp = 0, expectedRespinsPerPaidSpin = 0;
  const triggerProbability = triggers.reduce((sum, [, probability]) => sum + probability, 0);
  for (const [count, probability] of triggers) {
    const occupied = typeof initialOccupied === 'number' ? initialOccupied : Number(initialOccupied?.[count] ?? count);
    const result = exactHoldSpinFromState({ cells, occupied, lives, resetLives, landingProbability, meanCoinValue, fullGridAward });
    // Trigger coins are visible awards in the runtime and must be included in
    // feature RTP; the continuation solver returns only newly landed coins.
    const triggerCoinValue=initialCoinValue===null
      ? occupied*Number(meanCoinValue)
      : (typeof initialCoinValue==='number'?initialCoinValue:Number(initialCoinValue?.[count]??0));
    rtp += probability * (triggerCoinValue + result.payout);
    expectedRespinsPerPaidSpin += probability * result.respins;
  }
  return Object.freeze({
    type: 'hold-and-spin',
    triggerProbability,
    triggerHitFrequency: triggerProbability ? 1 / triggerProbability : Infinity,
    expectedRespinsPerTrigger: triggerProbability ? expectedRespinsPerPaidSpin / triggerProbability : 0,
    expectedRespinsPerPaidSpin,
    rtp,
  });
}

function composeGameMath({ base, features = [], jackpotRtp = 0 }) {
  const baseRtp = Number(base?.rtp ?? base ?? 0);
  const featureRtp = features.reduce((sum, feature) => sum + Number(feature.rtp || 0), 0);
  const totalRtp = baseRtp + featureRtp + Number(jackpotRtp || 0);
  return Object.freeze({ baseRtp, featureRtp, jackpotRtp: Number(jackpotRtp || 0), totalRtp, features: Object.freeze([...features]) });
}

module.exports = { binomialProbability, composeGameMath, exactFreeSpinMath, exactHoldSpinFromState, exactHoldSpinMath };
