const { bestLineMatch, coefficientFor, validateReelStrips } = require('./egt-fixed-reel-engine.cjs');

function symbolDistribution(strip) {
  const counts = new Map();
  for (const raw of strip) counts.set(Number(raw), (counts.get(Number(raw)) || 0) + 1);
  return [...counts].map(([symbol, count]) => ({ symbol, probability: count / strip.length }));
}

function sequenceAward(sequence, { paytable, wild, scatters, factor }) {
  const match = bestLineMatch(sequence, paytable, wild, scatters);
  return match ? match.coefficient / Math.max(1, Number(factor)) : 0;
}

function exactLineRtp({ strips, paytable, paylines, wild = null, scatters = [], factor }) {
  const distributions = validateReelStrips(strips).map(symbolDistribution);
  const scatterSet=new Set(scatters.map(Number));
  const candidates=Object.keys(paytable||{}).map(Number).filter(symbol=>Number.isFinite(symbol)&&!scatterSet.has(symbol));
  const divisor=Math.max(1,Number(factor));
  const prefixBest=occurs=>candidates.reduce((best,symbol)=>Math.max(best,coefficientFor(paytable,symbol,occurs,distributions.length)),0);
  let expectedPerLine=0,prefixProbability=1,prefixLength=0,states=new Map();
  const settle=(probability,symbol,occurs,wildPrefix)=>{
    const coefficient=Math.max(coefficientFor(paytable,symbol,occurs,distributions.length),prefixBest(wildPrefix));
    expectedPerLine+=probability*coefficient/divisor;
  };
  for(const distribution of distributions){
    const nextStates=new Map();let nextPrefix=0;
    const addState=(symbol,occurs,wildPrefix,probability)=>{
      const key=`${symbol}:${occurs}:${wildPrefix}`,existing=nextStates.get(key);
      nextStates.set(key,existing?{...existing,probability:existing.probability+probability}:{symbol,occurs,wildPrefix,probability});
    };
    for(const item of distribution){
      const value=Number(item.symbol),p=item.probability;
      if(prefixProbability){
        if(wild!==null&&value===Number(wild))nextPrefix+=prefixProbability*p;
        else if(candidates.includes(value))addState(value,prefixLength+1,prefixLength,prefixProbability*p);
        else expectedPerLine+=prefixProbability*p*prefixBest(prefixLength)/divisor;
      }
      for(const state of states.values()){
        const probability=state.probability*p;
        if(value===state.symbol||(wild!==null&&value===Number(wild)))addState(state.symbol,state.occurs+1,state.wildPrefix,probability);
        else settle(probability,state.symbol,state.occurs,state.wildPrefix);
      }
    }
    prefixProbability=nextPrefix;prefixLength+=1;states=nextStates;
  }
  if(prefixProbability)expectedPerLine+=prefixProbability*prefixBest(prefixLength)/divisor;
  for(const state of states.values())settle(state.probability,state.symbol,state.occurs,state.wildPrefix);
  return { expectedPerLine, rtp: expectedPerLine * paylines.length };
}

function exactWaysRtp({ strips, paytable, wild = null, scatters = [], factor, rows }) {
  const virtualWays = Number(rows) ** strips.length;
  const onePath = exactLineRtp({ strips, paytable, paylines: [[]], wild, scatters, factor });
  return { expectedPerWay: onePath.expectedPerLine, virtualWays, rtp: onePath.expectedPerLine * virtualWays };
}

function visibleCountDistribution(strip, symbol, rows) {
  const counts = new Map();
  for (let stop = 0; stop < strip.length; stop += 1) {
    let count = 0;
    for (let row = 0; row < rows; row += 1) count += Number(strip[(stop + row) % strip.length]) === Number(symbol);
    counts.set(count, (counts.get(count) || 0) + 1 / strip.length);
  }
  return counts;
}

function visibleSetCountDistribution(strip, symbols, rows) {
  const accepted = new Set(symbols.map(Number)), counts = new Map();
  for (let stop = 0; stop < strip.length; stop += 1) {
    let count = 0;
    for (let row = 0; row < rows; row += 1) count += accepted.has(Number(strip[(stop + row) % strip.length]));
    counts.set(count, (counts.get(count) || 0) + 1 / strip.length);
  }
  return counts;
}

function convolveCounts(left, right) {
  const result = new Map();
  for (const [a, pa] of left) for (const [b, pb] of right) result.set(a + b, (result.get(a + b) || 0) + pa * pb);
  return result;
}

function screenCountDistribution(strips, symbols, rows, eligibleReels = null) {
  const normalized = validateReelStrips(strips), reels = eligibleReels || normalized.map((_, index) => index);
  let distribution = new Map([[0, 1]]);
  for (const reel of reels) distribution = convolveCounts(distribution, visibleSetCountDistribution(normalized[reel], symbols, rows));
  return new Map([...distribution].sort((left, right) => left[0] - right[0]));
}

function exactScatterRtp({ strips, paytable, scatters, factor, rows, eligibleReels }) {
  const normalized = validateReelStrips(strips);
  const details = [], divisor = Math.max(1, Number(factor));
  for (const rawSymbol of scatters) {
    const symbol = Number(rawSymbol), eligible = eligibleReels(symbol);
    let distribution = new Map([[0, 1]]);
    for (const reel of eligible) distribution = convolveCounts(distribution, visibleCountDistribution(normalized[reel], symbol, rows));
    let rtp = 0, hitFrequency = 0;
    for (const [count, probability] of distribution) {
      const coefficient = coefficientFor(paytable, symbol, count, Math.max(1, eligible.length));
      if (coefficient > 0) { rtp += probability * coefficient / divisor; hitFrequency += probability; }
    }
    details.push({ symbol, rtp, hitFrequency, countDistribution: Object.fromEntries([...distribution].sort((a,b)=>a[0]-b[0])) });
  }
  return { rtp: details.reduce((sum, item) => sum + item.rtp, 0), details };
}

function exactBaseGameMath(config, factor) {
  const line = config.evaluation === 'ways'
    ? exactWaysRtp({ strips: config.strips, paytable: config.paytable, wild: config.roles.wild, scatters: config.scatters, factor, rows: config.rows })
    : exactLineRtp({ strips: config.strips, paytable: config.paytable, paylines: config.paylines, wild: config.roles.wild, scatters: config.scatters, factor });
  const scatter = exactScatterRtp({ strips: config.strips, paytable: config.paytable, scatters: config.scatters, factor, rows: config.rows, eligibleReels: symbol => config.scatterEligibleReels[symbol] || [] });
  return { rtp: line.rtp + scatter.rtp, lineRtp: line.rtp, scatterRtp: scatter.rtp, expectedPerLine: line.expectedPerLine, expectedPerWay: line.expectedPerWay, virtualWays: line.virtualWays, scatterDetails: scatter.details };
}

module.exports = { convolveCounts, exactBaseGameMath, exactLineRtp, exactScatterRtp, exactWaysRtp, screenCountDistribution, sequenceAward, symbolDistribution, visibleCountDistribution, visibleSetCountDistribution };
