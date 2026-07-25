const { exactBaseGameMath } = require('./egt-exact-math.cjs');
const { fixedReelOutcome, secureRandomInt } = require('./egt-fixed-reel-engine.cjs');
const { coefficientFor } = require('./egt-fixed-reel-engine.cjs');
const {exactHoldSpinMath}=require('./egt-feature-math.cjs');

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function sampleVariance(values, average = mean(values)) { return values.length > 1 ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) : 0; }

function serialCorrelation(values) {
  if (values.length < 3) return 0;
  const left = values.slice(0, -1), right = values.slice(1), leftMean = mean(left), rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return denominator ? numerator / denominator : 0;
}

function runsAboveMedian(values) {
  if (values.length < 2) return { runs: values.length, expected: values.length, z: 0 };
  const sorted = [...values].sort((a,b)=>a-b), median = sorted[Math.floor(sorted.length / 2)];
  const binary = values.map(value => value >= median ? 1 : 0), n1 = binary.reduce((sum,value)=>sum+value,0), n0 = binary.length - n1;
  let runs = 1; for (let index=1; index<binary.length; index+=1) runs += Number(binary[index] !== binary[index-1]);
  if (!n0 || !n1) return { runs, expected: 1, z: 0 };
  const expected = 1 + 2*n0*n1/(n0+n1);
  const variance = 2*n0*n1*(2*n0*n1-n0-n1)/((n0+n1)**2*(n0+n1-1));
  return { runs, expected, z: variance > 0 ? (runs-expected)/Math.sqrt(variance) : 0 };
}

function chiSquareUniform(counts) {
  const total = counts.reduce((sum,value)=>sum+value,0), expected = total / Math.max(1,counts.length);
  const statistic = expected ? counts.reduce((sum,value)=>sum+(value-expected)**2/expected,0) : 0;
  return { statistic, degreesOfFreedom: Math.max(0,counts.length-1), expectedPerStop: expected };
}

function theoreticalBaseMaximumWinMultiple(config, factor) {
  const divisor=Math.max(1,Number(factor));
  const reelCount=config.strips.length, paytable=config.paytable||{}, scatterSet=new Set((config.scatters||[]).map(Number));
  let maximumLineCoefficient=0;
  for(const [rawSymbol,record] of Object.entries(paytable)){
    if(scatterSet.has(Number(rawSymbol)))continue;
    for(const coefficient of record?.coef||[])maximumLineCoefficient=Math.max(maximumLineCoefficient,Number(coefficient)||0);
  }
  const topologyCount=config.evaluation==='ways'
    ? Number(config.rows)**reelCount
    : (config.paylines||[]).length;
  const lineOrWaysUpperBound=topologyCount*maximumLineCoefficient/divisor;
  let scatterUpperBound=0;
  for(const symbol of config.scatters||[]){
    const eligible=(config.scatterEligibleReels?.[symbol]||[]).length||reelCount;
    const maximumVisible=eligible*Number(config.rows);
    let best=0;
    for(let count=1;count<=maximumVisible;count+=1)best=Math.max(best,coefficientFor(paytable,Number(symbol),count,eligible));
    scatterUpperBound+=best/divisor;
  }
  return Object.freeze({
    lineOrWaysUpperBound,
    scatterUpperBound,
    totalUpperBound:lineOrWaysUpperBound+scatterUpperBound,
    topology:config.evaluation==='ways'?'ways':'paylines',
    topologyCount,
    note:'Conservative base-game bound; mutually incompatible line/scatter maxima may be summed. Feature and jackpot exposure is separate.',
  });
}

function simulateHoldSpin(model,reels,rows,stake,randomInt){
  const coinSymbols=(model.coinSymbols||[]).map(Number),coinSet=new Set(coinSymbols),values=model.coinValueBySymbol||{};
  const valueFor=symbol=>Number(values[symbol]??values[String(symbol)]??model.meanCoinValue??0);
  const visible=reels.flatMap(reel=>reel.slice(1,rows+1).map(Number)),trigger=visible.filter(symbol=>coinSet.has(symbol));
  if(trigger.length<Number(model.triggerCount||5))return {triggered:false,win:0,respins:0,full:false};
  let occupied=trigger.length,lives=Number(model.lives||3),win=trigger.reduce((sum,symbol)=>sum+Math.round(stake*valueFor(symbol)),0),respins=0;
  const cells=Number(model.cells||visible.length),resetLives=Number(model.resetLives||model.lives||3),threshold=Math.floor(Number(model.landingProbability||0)*0x100000000);
  while(occupied<cells&&lives>0){
    respins+=1;let landed=0;
    for(let empty=0;empty<cells-occupied;empty+=1){if(randomInt(0x100000000)>=threshold)continue;const symbol=coinSymbols[randomInt(coinSymbols.length)];win+=Math.round(stake*valueFor(symbol));landed+=1;}
    occupied+=landed;if(landed)lives=resetLives;else lives-=1;
    if(respins>10000)throw new Error('hold-spin simulation did not terminate');
  }
  const full=occupied>=cells;if(full)win+=Math.round(stake*Number(model.fullGridAward||0));
  return {triggered:true,win,respins,full};
}

function simulateHoldFeatureConditional(model,trials,stake,randomInt){
  const distribution=Object.entries(model.triggerDistribution||{}).map(([count,probability])=>[Number(count),Number(probability)]).filter(([,probability])=>probability>0);
  const triggerProbability=distribution.reduce((sum,[,probability])=>sum+probability,0);
  if(!distribution.length||!triggerProbability)return null;
  const coinSymbols=(model.coinSymbols||[]).map(Number),values=model.coinValueBySymbol||{},valueFor=symbol=>Number(values[symbol]??values[String(symbol)]??model.meanCoinValue??0);
  const threshold=Math.floor(Number(model.landingProbability||0)*0x100000000),payouts=[];let respins=0,fullGrids=0;
  for(let trial=0;trial<trials;trial+=1){
    let cursor=randomInt(0x100000000)/0x100000000*triggerProbability,count=distribution.at(-1)[0];
    for(const [candidate,probability] of distribution){cursor-=probability;if(cursor<0){count=candidate;break;}}
    let occupied=count,lives=Number(model.lives||3),win=Number(model.initialCoinValue?.[count]??count*Number(model.meanCoinValue||0));
    const cells=Number(model.cells),resetLives=Number(model.resetLives||model.lives||3);let rounds=0;
    while(occupied<cells&&lives>0){
      rounds+=1;let landed=0;
      for(let empty=0;empty<cells-occupied;empty+=1){if(randomInt(0x100000000)>=threshold)continue;const symbol=coinSymbols[randomInt(coinSymbols.length)];win+=valueFor(symbol);landed+=1;}
      occupied+=landed;if(landed)lives=resetLives;else lives-=1;
      if(rounds>10000)throw new Error('conditional hold-spin simulation did not terminate');
    }
    if(occupied>=cells){win+=Number(model.fullGridAward||0);fullGrids+=1;}
    payouts.push(win);respins+=rounds;
  }
  const conditionalMean=mean(payouts),conditionalVariance=sampleVariance(payouts,conditionalMean),paidSpinRtp=triggerProbability*conditionalMean;
  const standardError=triggerProbability*Math.sqrt(conditionalVariance/trials);
  return Object.freeze({trials,triggerProbability,conditionalMeanWinMultiple:conditionalMean,conditionalStandardDeviation:Math.sqrt(conditionalVariance),estimatedPaidSpinRtp:paidSpinRtp,standardError,meanRespins:respins/trials,fullGridFrequency:fullGrids/trials,fullGrids});
}

function simulateMathConfiguration({ config, profile, factor, spins = 100000, stake = 100, randomInt = secureRandomInt }) {
  if (!Number.isInteger(spins) || spins < 1) throw new RangeError('spins must be a positive integer');
  const stopCounts = config.strips.map(strip => Array(strip.length).fill(0)), stopSeries = config.strips.map(()=>[]), symbolCounts = config.strips.map(()=>new Map());
  const holdModel=config.featureModels?.find(feature=>feature.type==='hold-and-spin');
  const payouts = [], seen = new Set(); let hits=0, consecutiveDuplicates=0, previousGrid=null, maxWin=0,featureTriggers=0,featureRespins=0,fullGrids=0;
  for (let spinIndex=0; spinIndex<spins; spinIndex+=1) {
    const outcome=fixedReelOutcome({profile,strips:config.strips,paylines:config.paylines,roles:config.roles,scatters:config.scatters,eligibleReels:symbol=>config.scatterEligibleReels[symbol]||[],stake,factor,randomInt,evaluation:config.evaluation});
    const feature=holdModel?simulateHoldSpin(holdModel,outcome.spin.reels,config.rows,stake,randomInt):{triggered:false,win:0,respins:0,full:false};
    const totalWin=outcome.totalWin+feature.win;featureTriggers+=Number(feature.triggered);featureRespins+=feature.respins;fullGrids+=Number(feature.full);
    payouts.push(totalWin/stake); hits += Number(totalWin>0); maxWin=Math.max(maxWin,totalWin/stake);
    const grid=JSON.stringify(outcome.spin.reels.map(reel=>reel.slice(1,-1))); if(grid===previousGrid)consecutiveDuplicates+=1;previousGrid=grid;seen.add(grid);
    outcome.stops.forEach((stop,reel)=>{stopCounts[reel][stop]+=1;stopSeries[reel].push(stop);});
    outcome.spin.reels.forEach((reel,reelIndex)=>reel.slice(1,-1).forEach(symbol=>symbolCounts[reelIndex].set(symbol,(symbolCounts[reelIndex].get(symbol)||0)+1)));
  }
  const simulatedRtp=mean(payouts),variance=sampleVariance(payouts,simulatedRtp),standardError=Math.sqrt(variance/spins),baseMath=exactBaseGameMath(config,factor);
  const holdMath=holdModel?exactHoldSpinMath({triggerDistribution:holdModel.triggerDistribution,cells:holdModel.cells,initialOccupied:Object.fromEntries(Object.keys(holdModel.triggerDistribution||{}).map(count=>[count,Number(count)])),initialCoinValue:holdModel.initialCoinValue,lives:holdModel.lives,resetLives:holdModel.resetLives,landingProbability:holdModel.landingProbability,meanCoinValue:holdModel.meanCoinValue,fullGridAward:holdModel.fullGridAward}):null;
  const conditionalFeature=holdModel?simulateHoldFeatureConditional(holdModel,Math.max(10000,Math.min(spins,250000)),1,randomInt):null;
  const theoreticalRtp=baseMath.rtp+Number(holdMath?.rtp||0);
  const reels=stopCounts.map((counts,index)=>({reel:index,stops:counts.length,chiSquare:chiSquareUniform(counts),serialCorrelation:serialCorrelation(stopSeries[index]),runs:runsAboveMedian(stopSeries[index]),symbolFrequencies:Object.fromEntries([...symbolCounts[index]].sort((a,b)=>Number(a[0])-Number(b[0])).map(([symbol,count])=>[symbol,count/(spins*config.rows)]))}));
  return Object.freeze({spins,stake,factor,theoreticalRtp,theoreticalBaseRtp:baseMath.rtp,theoreticalFeatureRtp:Number(holdMath?.rtp||0),simulatedRtp,rtpDifference:simulatedRtp-theoreticalRtp,standardError,rtpZ:standardError?(simulatedRtp-theoreticalRtp)/standardError:0,hitFrequency:hits/spins,featureSimulation:{triggers:featureTriggers,triggerFrequency:featureTriggers/spins,respins:featureRespins,fullGrids,conditional:conditionalFeature,conditionalRtpZ:conditionalFeature?.standardError?(conditionalFeature.estimatedPaidSpinRtp-Number(holdMath?.rtp||0))/conditionalFeature.standardError:0},volatility:{variance,standardDeviation:Math.sqrt(variance)},maximumObservedWinMultiple:maxWin,theoreticalBaseMaximumWinMultiple:theoreticalBaseMaximumWinMultiple(config,factor),uniqueGrids:seen.size,consecutiveDuplicates,reels});
}

function highConfidenceChecks(report, sigma = 5) {
  const failures=[];
  if(Math.abs(report.rtpZ)>sigma)failures.push(`RTP differs by ${report.rtpZ.toFixed(3)} standard errors`);
  if(report.featureSimulation?.conditional&&Math.abs(report.featureSimulation.conditionalRtpZ)>sigma)failures.push(`conditional feature RTP differs by ${report.featureSimulation.conditionalRtpZ.toFixed(3)} standard errors`);
  for(const reel of report.reels){
    const approximateLimit=reel.chiSquare.degreesOfFreedom+sigma*Math.sqrt(2*Math.max(1,reel.chiSquare.degreesOfFreedom));
    if(reel.chiSquare.statistic>approximateLimit)failures.push(`reel ${reel.reel+1} stop chi-square ${reel.chiSquare.statistic.toFixed(3)} exceeds ${approximateLimit.toFixed(3)}`);
    if(Math.abs(reel.serialCorrelation)>sigma/Math.sqrt(report.spins))failures.push(`reel ${reel.reel+1} serial correlation ${reel.serialCorrelation.toFixed(6)}`);
    if(Math.abs(reel.runs.z)>sigma)failures.push(`reel ${reel.reel+1} runs z ${reel.runs.z.toFixed(3)}`);
  }
  return Object.freeze({confidenceSigma:sigma,passed:failures.length===0,failures:Object.freeze(failures)});
}

module.exports={chiSquareUniform,highConfidenceChecks,runsAboveMedian,serialCorrelation,simulateHoldFeatureConditional,simulateHoldSpin,simulateMathConfiguration,theoreticalBaseMaximumWinMultiple};
