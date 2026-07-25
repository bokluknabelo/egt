const fs=require('fs');
const path=require('path');
const {bellTriggerStatistics,buildBellFeatureMath,coinValueSchedule}=require('./egt-bell-link-math.cjs');
const {symbolRoles}=require('./egt-family-engines.cjs');
const {deriveFamilyMathSpec}=require('./egt-family-math-specs.cjs');
const {paylinesFor}=require('./egt-local-engine.cjs');
const {buildMathConfiguration}=require('./egt-math-configs.cjs');
const {optimizeReelConfiguration}=require('./egt-reel-optimizer.cjs');
const {visibleRowCount}=require('./egt-fixed-reel-engine.cjs');

const gameKey=process.argv[2],targets=String(process.argv[3]||'48,80,90,96').split(',').map(Number),maxIterations=Number(process.argv[4]||10000),protocolReady=process.argv.includes('--protocol-ready');
const templateKey=process.argv.find(argument=>argument.startsWith('--template='))?.split('=')[1]||'';
if(!gameKey)throw new Error('usage: node build-original-bell-link-config.cjs <gameKey> [targets] [iterations] [--template=gameKey] [--protocol-ready]');
const profile=JSON.parse(fs.readFileSync(path.join(__dirname,'data','egt-profiles',`${gameKey}.json`),'utf8'));
let source='original-bell-link-mathematics-v1';
if(!Array.isArray(profile.settings.fakeReels)&&templateKey){
  const template=JSON.parse(fs.readFileSync(path.join(__dirname,'data','egt-profiles',`${templateKey}.json`),'utf8'));
  if(!Array.isArray(template.settings.fakeReels))throw new Error(`${templateKey} has no fixed strips`);
  const paytable=new Set(Object.keys(profile.settings.paytable||{}).map(Number));
  const observedCoins=[...new Set(Object.values(profile.eventFamilies||{}).flatMap(samples=>samples).flatMap(sample=>sample.game?.result?.spins||[]).flatMap(spin=>spin.reels||[]).flat().map(Number).filter(symbol=>Number.isFinite(symbol)&&symbol>=100&&!paytable.has(symbol)))].sort((a,b)=>a-b);
  if(!observedCoins.length)throw new Error(`${gameKey} has no observed coin codes for template mapping`);
  const templateCoins=symbolRoles(template).coins;if(!templateCoins.length)throw new Error(`${templateKey} has no Bell coin codes`);
  const mapping=new Map(templateCoins.map((symbol,index)=>[symbol,observedCoins[index%observedCoins.length]]));
  profile.settings.fakeReels=template.settings.fakeReels.map(strip=>strip.map(symbol=>mapping.get(Number(symbol))??Number(symbol)));
  source=`original-bell-link-template:${templateKey}`;
}
const spec=deriveFamilyMathSpec(profile);
if(spec.family!=='bell-link')throw new Error(`${gameKey} is ${spec.family}, not bell-link`);
if(!spec.baseStripsReady||!spec.paylinesReady)throw new Error(`${gameKey} lacks fixed strips or authoritative paylines`);
const sample=profile.eventFamilies?.bet?.find(item=>item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels||profile.settings.reels,paylines=paylinesFor(profile,sample);
const coinMean=10,landingProbability=.10,jackpotRtp=.01;
const roles=symbolRoles(profile),coinValueBySymbol=coinValueSchedule(roles.coins,coinMean),rows=visibleRowCount(profile),cells=profile.settings.fakeReels.length*rows;
const statistics=bellTriggerStatistics({strips:profile.settings.fakeReels,coinValueBySymbol,rows,triggerCount:5});
const feature=buildBellFeatureMath({statistics,cells,coinValueBySymbol,landingProbability,jackpotRtp});
const factor=Number(profile.settings.factor||profile.settings.factors?.[0]||profile.settings.lines||1),configurations={};
for(const target of targets){
  const baseTarget=target/100-feature.combined.rtp;
  if(!(baseTarget>0))throw new Error(`${target}% is below fixed Bell feature RTP ${(feature.combined.rtp*100).toFixed(6)}%`);
  const optimized=optimizeReelConfiguration({profile,paylines,targetRtp:baseTarget*100,factor,maxIterations,tolerance:.0002});
  if(!optimized.converged)throw new Error(`${gameKey}-${target} base did not converge: ${(optimized.math.rtp*100).toFixed(6)}% vs ${(baseTarget*100).toFixed(6)}%; no artifact written`);
  const configuredProfile=structuredClone(profile);configuredProfile.settings.fakeReels=optimized.config.strips;
  const model={type:'hold-and-spin',source,cells,triggerCount:5,triggerDistribution:statistics.triggerDistribution,initialCoinValue:statistics.initialCoinValue,coinSymbols:roles.coins,coinValueBySymbol,lives:3,resetLives:3,landingProbability,meanCoinValue:feature.meanCoinValue,fullGridAward:feature.fullGridAward,blankSymbol:0};
  const config=buildMathConfiguration(configuredProfile,paylines,target,{source,featureMathComplete:true,runtimeProtocolReady:protocolReady,featureModels:[model],jackpotModel:{type:'full-grid-award',contributionRtp:feature.jackpotRtp,awardMultiple:feature.fullGridAward}});
  const totalRtp=optimized.math.rtp+feature.combined.rtp;
  configurations[target]={config,math:{baseRtp:optimized.math.rtp,featureRtp:feature.coinMath.rtp,jackpotRtp:feature.jackpotRtp,totalRtp,holdSpin:feature.combined},iterations:optimized.iterations,changes:optimized.changes,converged:Math.abs(totalRtp-target/100)<=.00021};
  process.stderr.write(`${gameKey}-${target}: base ${(optimized.math.rtp*100).toFixed(6)}% + hold coins ${(feature.coinMath.rtp*100).toFixed(6)}% + full-grid ${(feature.jackpotRtp*100).toFixed(6)}% = ${(totalRtp*100).toFixed(6)}%\n`);
}
const output={schemaVersion:3,generatedAt:new Date().toISOString(),gameKey,factor,artifactType:protocolReady?'complete-game':'complete-math-candidate',originalMathematics:true,source,designParameters:{coinMean,landingProbability,jackpotRtp},familySpec:spec,configurations};
const directory=path.join(__dirname,'data','egt-math-configs');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${gameKey}.json`),`${JSON.stringify(output,null,2)}\n`);
