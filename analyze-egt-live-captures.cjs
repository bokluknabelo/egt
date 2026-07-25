const fs = require('fs');
const path = require('path');

function filesFromArgs(args) {
  const files = [];
  for (const arg of args) {
    if (!fs.existsSync(arg)) continue;
    const stat = fs.statSync(arg);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(arg).sort()) {
        if (name.endsWith('.json')) files.push(path.join(arg, name));
      }
    } else if (arg.endsWith('.json')) files.push(arg);
  }
  return files;
}

function firstServerMessage(capture, event) {
  return (capture.messages || []).find(item => item.direction === 'server' && item.event === event)?.message || null;
}

function inferFamily(capture, loadGame) {
  const settings = loadGame?.settings || {};
  const gameKey = capture.gameKey || loadGame?.gameKey || '';
  const features = new Set(settings.feature || []);
  const lines = Number(settings.lines || settings.linesOptions?.[0] || 0);
  const reels = Array.isArray(settings.reels) ? settings.reels.length : 0;
  if (features.has('SG_JACKPOT') && /BLSlot$/i.test(gameKey)) return 'bell-link';
  if (features.has('BUY_BONUS') || features.has('SUPER_BUY_BONUS')) return lines === 0 ? 'buy-bonus-ways' : 'buy-bonus-lines';
  if (lines === 0 || lines === 3 ** reels) return 'ways';
  return 'classic-lines';
}

function compactRound(round) {
  return {
    type: round?.type || null,
    remain: round?.remain ?? null,
    count: round?.count ?? null,
    totalWin: round?.totalWin ?? null,
  };
}

function summarize(file) {
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const loadGame = firstServerMessage(capture, 'loadGame');
  const betShape = capture.bet || loadGame?.game?.state?.bet || null;
  const featureSamples = [];
  for (const item of capture.messages || []) {
    const message = item.message || {};
    if (item.direction !== 'server') continue;
    if (!message.state || message.state === 'idle') continue;
    if (featureSamples.length >= 25) break;
    featureSamples.push({
      sequence: item.sequence,
      event: message.event || null,
      state: message.state || null,
      totalWin: message.game?.result?.totalWin ?? null,
      spinTypes: (message.game?.result?.spins || []).map(spin => spin.type || null),
      bonuses: (message.game?.result?.spins || []).flatMap(spin => spin.bonuses || []),
      rounds: (message.game?.state?.rounds || []).map(compactRound),
      resultKeys: Object.keys(message.game?.result || {}).sort(),
      stateKeys: Object.keys(message.game?.state || {}).sort(),
    });
  }
  return {
    file,
    gameKey: capture.gameKey,
    targetUrl: capture.targetUrl || null,
    family: inferFamily(capture, loadGame),
    spins: capture.spins,
    bet: betShape,
    settings: loadGame?.settings ? {
      lines: loadGame.settings.lines,
      linesOptions: loadGame.settings.linesOptions,
      reels: Array.isArray(loadGame.settings.reels) ? loadGame.settings.reels.length : null,
      feature: loadGame.settings.feature || [],
    } : null,
    states: capture.states || {},
    serverEvents: capture.serverEvents || {},
    eventStates: capture.eventStates || {},
    rewardEvents: capture.rewardEvents || [],
    featureSamples,
    errors: capture.errors || [],
  };
}

const files = filesFromArgs(process.argv.slice(2));
if (!files.length) throw new Error('usage: node analyze-egt-live-captures.cjs <capture.json|directory> [...]');
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), count: files.length, captures: files.map(summarize) }, null, 2)}\n`);
