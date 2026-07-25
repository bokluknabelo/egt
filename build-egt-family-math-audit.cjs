#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { deriveFamilyMathSpec } = require('./egt-family-math-specs.cjs');

const directory = path.join(__dirname, 'data', 'egt-profiles');
const configDirectory=path.join(__dirname,'data','egt-math-configs'),reportDirectory=path.join(__dirname,'data','egt-math-reports'),requiredTargets=[48,80,90,96];
const titles = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
  const profile = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const spec=deriveFamilyMathSpec(profile),artifactPath=path.join(configDirectory,`${spec.gameKey}.json`);let artifact=null;
  try{artifact=JSON.parse(fs.readFileSync(artifactPath,'utf8'));}catch{}
  const targetStatus=Object.fromEntries(requiredTargets.map(target=>{
    const record=artifact?.configurations?.[target],reportPath=path.join(reportDirectory,`${spec.gameKey}-${target}.json`);let validation=null;
    try{validation=JSON.parse(fs.readFileSync(reportPath,'utf8'));}catch{}
    const totalRtp=Number(record?.math?.totalRtp),mathComplete=record?.config?.featureMathComplete===true&&Number.isFinite(totalRtp)&&Math.abs(totalRtp-target/100)<=.00021;
    const validated=mathComplete&&validation?.configurationVersionHash===record.config.versionHash&&validation?.checks?.passed===true&&Math.abs(Number(validation?.simulation?.theoreticalRtp)-totalRtp)<=1e-10;
    return [target,{mathComplete,validated,protocolReady:validated&&record?.config?.runtimeProtocolReady===true}];
  }));
  return {...spec,artifact:{type:artifact?.artifactType||null,originalMathematics:artifact?.originalMathematics===true,targets:targetStatus,allTargetsMathComplete:requiredTargets.every(target=>targetStatus[target].mathComplete),allTargetsValidated:requiredTargets.every(target=>targetStatus[target].validated),allTargetsProtocolReady:requiredTargets.every(target=>targetStatus[target].protocolReady)}};
});
const families = {};
for (const title of titles) {
  const family = families[title.family] ||= { titles: 0, baseStripsReady: 0, paylinesReady: 0, profileFeatureMathComplete: 0, completeMathCandidateTitles:0,validatedConfigurations:0,protocolReadyConfigurations:0 };
  family.titles += 1; family.baseStripsReady += Number(title.baseStripsReady); family.paylinesReady += Number(title.paylinesReady);
  family.profileFeatureMathComplete += Number(title.featureMathComplete);family.completeMathCandidateTitles+=Number(title.artifact.allTargetsValidated);
  family.validatedConfigurations+=Object.values(title.artifact.targets).filter(target=>target.validated).length;family.protocolReadyConfigurations+=Object.values(title.artifact.targets).filter(target=>target.protocolReady).length;
}
const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), requiredTargets, families, titles };
const output = path.join(__dirname, 'data', 'egt-family-math-audit.json');
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(__dirname, output), families, complete: titles.filter(title => title.featureMathComplete).length }, null, 2));
