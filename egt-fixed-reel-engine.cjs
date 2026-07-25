const crypto = require('crypto');

function secureRandomInt(max) {
  if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError(`invalid random range ${max}`);
  return crypto.randomInt(0, max);
}

function visibleRowCount(profile) {
  const template = profile.eventFamilies?.bet?.find(item => item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels;
  const lengths = (template || profile.settings?.reels || []).map(reel => Array.isArray(reel) ? reel.length : 0).filter(Boolean);
  return lengths.length ? Math.max(1, Math.min(...lengths) - 2) : 3;
}

function validateReelStrips(strips, reelCount = 0) {
  if (!Array.isArray(strips) || !strips.length) throw new Error('fixed reel strips are missing');
  if (reelCount && strips.length !== reelCount) throw new Error(`expected ${reelCount} reel strips, received ${strips.length}`);
  for (const [index, strip] of strips.entries()) {
    if (!Array.isArray(strip) || !strip.length) throw new Error(`reel ${index + 1} has no stops`);
    if (strip.some(symbol => !Number.isSafeInteger(Number(symbol)))) throw new Error(`reel ${index + 1} contains an invalid symbol`);
  }
  return strips.map(strip => strip.map(Number));
}

// As in Slotopol/StakeEngine, one stop is selected per physical/virtual reel.
// All visible symbols are adjacent positions on that same circular strip.
function spinReelStrips(strips, rows, randomInt = secureRandomInt) {
  const normalized = validateReelStrips(strips);
  const stops = normalized.map(strip => randomInt(strip.length));
  const reels = normalized.map((strip, reel) => {
    const stop = stops[reel];
    return Array.from({ length: rows + 2 }, (_, offset) => strip[(stop + offset - 1 + strip.length) % strip.length]);
  });
  return { reels, stops };
}

function coefficientFor(paytable, symbol, occurs, reelCount) {
  const coefficients = paytable?.[symbol]?.coef || paytable?.[String(symbol)]?.coef || [];
  const minimum = reelCount - coefficients.length + 1;
  return Number(coefficients[occurs - minimum] || 0);
}

function bestLineMatch(symbols, paytable, wild = null, scatters = []) {
  const scatterSet = new Set(scatters.map(Number));
  const candidates = Object.keys(paytable || {}).map(Number).filter(symbol => Number.isFinite(symbol) && !scatterSet.has(symbol));
  let best = null;
  for (const symbol of candidates) {
    let occurs = 0;
    while (occurs < symbols.length && (Number(symbols[occurs]) === symbol || (wild !== null && Number(symbols[occurs]) === Number(wild)))) occurs += 1;
    const coefficient = coefficientFor(paytable, symbol, occurs, symbols.length);
    if (!(coefficient > 0)) continue;
    const candidate = { symbol, occurs, coefficient };
    if (!best || coefficient > best.coefficient || (coefficient === best.coefficient && occurs > best.occurs)) best = candidate;
  }
  return best;
}

function evaluatePaylines({ reels, paylines, paytable, wild = null, scatters = [], stake, factor }) {
  const reelCount = reels.length, scatterSet = new Set(scatters.map(Number));
  const entries = [];
  for (let line = 0; line < paylines.length; line += 1) {
    const rows = paylines[line];
    const symbols = rows.map((row, reel) => Number(reels[reel]?.[row + 1]));
    const match = bestLineMatch(symbols, paytable, wild, [...scatterSet]);
    if (!match) continue;
    const { symbol, occurs, coefficient } = match;
    const win = Math.round(Number(stake) * coefficient / Math.max(1, Number(factor)));
    if (!(win > 0)) continue;
    const cells = Array.from({ length: occurs }, (_, reel) => [reel, rows[reel]]).flat();
    entries.push({ mode: 'line', symbol, winAmount: String(win), cells, coef: coefficient, multiplier: 1, occurs, win, line });
  }
  return entries;
}

// "Ways" games are equivalent to evaluating every possible row selection as
// a virtual payline. Enumerating those paths (3^8 is only 6,561 for the largest
// captured title) also gives wild-only paths the same highest-award semantics
// as ordinary paylines, without double-counting them once per paytable symbol.
function evaluateWays({ reels, paytable, wild = null, scatters = [], stake, factor, rows = null }) {
  const reelCount = reels.length;
  const rowCounts = reels.map(reel => Math.max(0, Math.min(Number(rows) || reel.length - 2, reel.length - 2)));
  if (!reelCount || rowCounts.some(count => count <= 0)) return [];
  const path = Array(reelCount).fill(0), groups = new Map();
  function visit(reel) {
    if (reel < reelCount) {
      for (let row = 0; row < rowCounts[reel]; row += 1) { path[reel] = row; visit(reel + 1); }
      return;
    }
    const symbols = path.map((row, index) => Number(reels[index][row + 1]));
    const match = bestLineMatch(symbols, paytable, wild, scatters);
    if (!match) return;
    const key = `${match.symbol}:${match.occurs}:${match.coefficient}`;
    let group = groups.get(key);
    if (!group) {
      group = { mode: 'ways', symbol: match.symbol, coef: match.coefficient, multiplier: 1, occurs: match.occurs, ways: 0, cellSet: new Set() };
      groups.set(key, group);
    }
    group.ways += 1;
    for (let index = 0; index < match.occurs; index += 1) group.cellSet.add(`${index}:${path[index]}`);
  }
  visit(0);
  return [...groups.values()].map(group => {
    const win = Math.round(Number(stake) * group.coef * group.ways / Math.max(1, Number(factor)));
    const cells = [...group.cellSet].map(cell => cell.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]).flat();
    return { mode: group.mode, symbol: group.symbol, winAmount: String(win), cells, coef: group.coef, multiplier: 1, occurs: group.occurs, win, ways: group.ways };
  }).filter(entry => entry.win > 0);
}

function evaluateScatters({ reels, paytable, scatters, stake, factor, eligibleReels }) {
  const entries = [], reelCount = reels.length;
  for (const rawSymbol of scatters) {
    const symbol = Number(rawSymbol), eligible = new Set(eligibleReels(symbol));
    const cells = [];
    for (let reel = 0; reel < reelCount; reel += 1) {
      if (!eligible.has(reel)) continue;
      for (let row = 0; row < reels[reel].length - 2; row += 1) if (Number(reels[reel][row + 1]) === symbol) cells.push(reel, row);
    }
    const count = cells.length / 2, coefficient = coefficientFor(paytable, symbol, count, Math.max(1, eligible.size));
    if (!(coefficient > 0)) continue;
    const win = Math.round(Number(stake) * coefficient / Math.max(1, Number(factor)));
    if (!(win > 0)) continue;
    entries.push({ mode: 'scatter', symbol, winAmount: String(win), cells, coef: coefficient, multiplier: 1, occurs: count, win });
  }
  return entries;
}

function fixedReelOutcome({ profile, paylines, roles, scatters, eligibleReels, stake, factor, randomInt = secureRandomInt, strips, evaluation = 'paylines' }) {
  const reelStrips = validateReelStrips(strips || profile.settings?.fakeReels);
  const rows = visibleRowCount(profile), { reels, stops } = spinReelStrips(reelStrips, rows, randomInt);
  const lineEntries = evaluation === 'ways'
    ? evaluateWays({ reels, paytable: profile.settings?.paytable, wild: roles.wild, scatters, stake, factor, rows })
    : evaluatePaylines({ reels, paylines, paytable: profile.settings?.paytable, wild: roles.wild, scatters, stake, factor });
  const scatterEntries = evaluateScatters({ reels, paytable: profile.settings?.paytable, scatters, stake, factor, eligibleReels });
  const entries = [...lineEntries, ...scatterEntries], totalWin = entries.reduce((sum, entry) => sum + entry.win, 0);
  return {
    totalWin,
    stops,
    spin: { entries, mutations: [], totalWinAmount: String(totalWin), reels, type: 'SPIN', bonuses: [], totalWin },
  };
}

function toppleReels({ reels, winningCells, strips, nextAbove }) {
  const removedByReel=reels.map(()=>new Set());
  for(let index=0;index<winningCells.length;index+=2)removedByReel[winningCells[index]]?.add(winningCells[index+1]);
  const result=reels.map((reel,reelIndex)=>{
    const rows=reel.length-2, survivors=reel.slice(1,-1).filter((_,row)=>!removedByReel[reelIndex].has(row));
    const additions=[];
    while(additions.length<rows-survivors.length){
      const strip=strips[reelIndex],cursor=(nextAbove[reelIndex]%strip.length+strip.length)%strip.length;
      additions.unshift(Number(strip[cursor]));nextAbove[reelIndex]=cursor-1;
    }
    const visible=[...additions,...survivors];
    return [visible[0],...visible,visible.at(-1)];
  });
  return result;
}

function fixedCascadeOutcome({ profile, roles, scatters, eligibleReels, stake, factor, randomInt = secureRandomInt, strips, maxCascades }) {
  if(!Number.isInteger(maxCascades)||maxCascades<1)throw new RangeError('a positive maxCascades is required');
  const reelStrips=validateReelStrips(strips||profile.settings?.fakeReels),rows=visibleRowCount(profile);
  const initial=spinReelStrips(reelStrips,rows,randomInt),nextAbove=initial.stops.map((stop,reel)=>((stop-2)%reelStrips[reel].length+reelStrips[reel].length)%reelStrips[reel].length);
  let reels=initial.reels,totalWin=0;const spins=[];
  for(let cascade=0;cascade<=maxCascades;cascade+=1){
    const ways=evaluateWays({reels,paytable:profile.settings?.paytable,wild:roles.wild,scatters,stake,factor,rows});
    const scatter=cascade===0?evaluateScatters({reels,paytable:profile.settings?.paytable,scatters,stake,factor,eligibleReels}):[];
    const entries=[...ways,...scatter],win=entries.reduce((sum,entry)=>sum+entry.win,0);
    spins.push({entries,mutations:[],totalWinAmount:String(win),reels:structuredClone(reels),type:'SPIN',bonuses:[],totalWin:win});
    totalWin+=win;
    if(!ways.length)break;
    if(cascade===maxCascades)throw new Error(`cascade exceeded configured maximum ${maxCascades}`);
    const winningCells=[...new Set(ways.flatMap(entry=>{
      const cells=[];for(let index=0;index<entry.cells.length;index+=2)cells.push(`${entry.cells[index]}:${entry.cells[index+1]}`);return cells;
    }))].flatMap(cell=>cell.split(':').map(Number));
    reels=toppleReels({reels,winningCells,strips:reelStrips,nextAbove});
  }
  return {totalWin,stops:initial.stops,spin:spins[0],spins};
}

module.exports = {
  bestLineMatch,
  coefficientFor,
  evaluatePaylines,
  evaluateWays,
  fixedCascadeOutcome,
  evaluateScatters,
  fixedReelOutcome,
  secureRandomInt,
  spinReelStrips,
  toppleReels,
  validateReelStrips,
  visibleRowCount,
};
