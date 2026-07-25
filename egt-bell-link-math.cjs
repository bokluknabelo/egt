const {exactHoldSpinMath}=require('./egt-feature-math.cjs');
const {validateReelStrips}=require('./egt-fixed-reel-engine.cjs');

function coinValueSchedule(symbols,desiredMean=50){
  if(!symbols.length)throw new Error('coin symbols are required');
  const weights=Array.from({length:symbols.length},(_,index)=>(index+1)**2);
  const targetTotal=Math.round(Number(desiredMean)*symbols.length),scale=targetTotal/weights.reduce((sum,value)=>sum+value,0);
  const values=weights.map(value=>Math.max(1,Math.round(value*scale)));
  values[values.length-1]+=targetTotal-values.reduce((sum,value)=>sum+value,0);
  return Object.fromEntries(symbols.map((symbol,index)=>[symbol,values[index]]));
}

function reelWindowCoinMoments(strip,coinValueBySymbol,rows){
  const result=new Map();
  for(let stop=0;stop<strip.length;stop+=1){
    let count=0,value=0;
    for(let row=0;row<rows;row+=1){const symbol=Number(strip[(stop+row)%strip.length]);if(Object.hasOwn(coinValueBySymbol,symbol)){count+=1;value+=Number(coinValueBySymbol[symbol]);}}
    const current=result.get(count)||{probability:0,valueMass:0};current.probability+=1/strip.length;current.valueMass+=value/strip.length;result.set(count,current);
  }
  return result;
}

function convolveCoinMoments(left,right){
  const result=new Map();
  for(const [a,x] of left)for(const [b,y] of right){
    const count=a+b,current=result.get(count)||{probability:0,valueMass:0};
    current.probability+=x.probability*y.probability;
    current.valueMass+=x.valueMass*y.probability+x.probability*y.valueMass;
    result.set(count,current);
  }
  return result;
}

function bellTriggerStatistics({strips,coinValueBySymbol,rows,triggerCount=5}){
  let moments=new Map([[0,{probability:1,valueMass:0}]]);
  for(const strip of validateReelStrips(strips))moments=convolveCoinMoments(moments,reelWindowCoinMoments(strip,coinValueBySymbol,rows));
  const triggerDistribution={},initialCoinValue={};
  for(const [count,item] of moments){if(count<triggerCount||!item.probability)continue;triggerDistribution[count]=item.probability;initialCoinValue[count]=item.valueMass/item.probability;}
  return Object.freeze({triggerDistribution:Object.freeze(triggerDistribution),initialCoinValue:Object.freeze(initialCoinValue),allCountDistribution:Object.freeze(Object.fromEntries([...moments].map(([count,item])=>[count,item.probability])))});
}

function buildBellFeatureMath({statistics,cells,coinValueBySymbol,lives=3,resetLives=3,landingProbability=.04,jackpotRtp=.03}){
  const values=Object.values(coinValueBySymbol).map(Number),meanCoinValue=values.reduce((sum,value)=>sum+value,0)/values.length;
  const common={triggerDistribution:statistics.triggerDistribution,cells,initialOccupied:Object.fromEntries(Object.keys(statistics.triggerDistribution).map(count=>[count,Number(count)])),lives,resetLives,landingProbability};
  const coinMath=exactHoldSpinMath({...common,initialCoinValue:statistics.initialCoinValue,meanCoinValue,fullGridAward:0});
  const unitJackpot=exactHoldSpinMath({...common,initialCoinValue:0,meanCoinValue:0,fullGridAward:1}).rtp;
  if(!(unitJackpot>0))throw new Error('full-grid jackpot is unreachable with this Bell Link model');
  const fullGridAward=Number(jackpotRtp)/unitJackpot;
  const combined=exactHoldSpinMath({...common,initialCoinValue:statistics.initialCoinValue,meanCoinValue,fullGridAward});
  return Object.freeze({coinMath,combined,jackpotRtp:Number(jackpotRtp),fullGridAward,meanCoinValue});
}

module.exports={bellTriggerStatistics,buildBellFeatureMath,coinValueSchedule,convolveCoinMoments,reelWindowCoinMoments};
