const fs = require('fs');
const path = require('path');

const root = __dirname, resultDirs = ['/tmp/sg-results','/tmp/sg-five','/tmp/sg-last','/tmp/buy-results','/tmp/dual-free'];
const results = [];
for (const directory of resultDirs) {
  if (!fs.existsSync(directory)) continue;
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    try { const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); if (value.gameKey) results.push(value); } catch {}
  }
}
for (const file of ['/tmp/fhe-final.json']) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.gameKey) results.push(value); } catch {} }
const featureResults = [...new Map(results.filter(value => value.events?.some(event => ['holdspin','freespin'].includes(event.state))).map(value => { const state = value.events.find(event => ['holdspin','freespin'].includes(event.state)).state; return [`${value.gameKey}:${state}`, { gameKey: value.gameKey, state, bets: value.betRequests, errors: value.errors || [] }]; })).values()].sort((a,b) => a.gameKey.localeCompare(b.gameKey) || a.state.localeCompare(b.state));
const reconnectResults = ['/tmp/reconnect-base.json','/tmp/reconnect-feature.json'].flatMap(file => { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return [{ gameKey: value.gameKey, connections: value.connections, restored: value.reconnectRestored, state: value.events?.filter(event => event.event === 'loadGame' && event.direction === 'local').at(-1)?.state, errors: value.errors || [] }]; } catch { return []; } });
const queue = JSON.parse(fs.readFileSync(path.join(root, 'data', 'egt-migration-queue.json'), 'utf8'));
const report = { generatedAt: new Date().toISOString(), baseTitles: queue.titles.length, baseOperational: queue.titles.filter(title => title.status === 'operational').length, featureResults, reconnectResults };
const output = path.join(root, 'data', 'egt-validation-report.json'), temporary = `${output}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, output); console.log(output);
