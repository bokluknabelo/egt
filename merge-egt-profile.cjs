const fs = require('fs');
const path = require('path');

const gameKey = process.argv[2];
const inputs = process.argv.slice(3);
if (!gameKey || !inputs.length) throw new Error('Usage: merge-egt-profile.cjs GAME_KEY CAPTURE...');
const documents = inputs.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
const messages = documents.flatMap(document => document.messages || []);
const requests = new Map(messages.filter(item => item.direction === 'client' && item.message?.id != null).map(item => [`${item.connectionId}:${item.message.id}`, item.message]));
const server = messages.filter(item => item.direction === 'server' && item.message).map(item => item.message);
const load = server.find(message => message.event === 'loadGame');
if (!load) throw new Error(`No loadGame response captured for ${gameKey}`);

function withoutRuntime(value) {
  const copy = structuredClone(value);
  for (const key of ['referenceId', 'sessionKey', 'balance']) delete copy[key];
  return copy;
}
function fingerprint(value) {
  const copy = structuredClone(value); const walk = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['referenceId','sessionKey','matchId','balance','currentValue','lastWinDate','completedAt','startedAt'].includes(key)) item[key] = `<${key}>`;
      else walk(child);
    }
  }; walk(copy); return JSON.stringify(copy);
}
const MAX_EVENT_SAMPLES = Number(process.env.EGT_PROFILE_MAX_EVENT_SAMPLES || 120);
const MAX_OUTCOME_SAMPLES_PER_GROUP = Number(process.env.EGT_PROFILE_MAX_OUTCOME_SAMPLES_PER_GROUP || 40);
const schemaHints = {};
for (const message of server) {
  const eventState = `${message.event || ''}:${message.state || ''}`;
  const hint = schemaHints[eventState] ||= { resultKeys: [], gameKeys: [], stateKeys: [] };
  for (const key of Object.keys(message.game?.result || {})) if (!hint.resultKeys.includes(key)) hint.resultKeys.push(key);
  for (const key of Object.keys(message.game || {})) if (!hint.gameKeys.includes(key)) hint.gameKeys.push(key);
  for (const key of Object.keys(message.game?.state || {})) if (!hint.stateKeys.includes(key)) hint.stateKeys.push(key);
}
const families = {}, familyFingerprints = {};
for (const message of server) {
  if (!message.event || message.event === 'loadGame') continue;
  const family = families[message.event] ||= [];
  const seen = familyFingerprints[message.event] ||= new Set();
  if (family.length >= MAX_EVENT_SAMPLES) continue;
  const clean = withoutRuntime(message), key = fingerprint(clean);
  if (!seen.has(key)) { seen.add(key); family.push(clean); }
}
const outcomeFingerprints = new Set(), outcomeGroups = new Map(), outcomes = [];
for (const item of messages.filter(item => item.direction === 'server' && item.message?.event === 'bet' && item.message.game?.result?.spins)) {
  const sample = withoutRuntime(item.message), sourceBet = requests.get(`${item.connectionId}:${item.message.referenceId}`)?.bet || sample.game?.state?.bet || null;
  const sourceStake = sourceBet ? Math.max(1, Math.round(Number(sourceBet.level) * Number(sourceBet.factor || 1) * Number(sourceBet.denomination || 1))) : null;
  const outcome = { state: sample.state, totalWin: Number(sample.game?.state?.totalWinAmount || sample.game?.state?.totalWin || 0), sourceBet, sourceStake, game: sample.game, context: sample.context || {}, tags: [...new Set([sample.state, ...(sample.game?.result?.spins || []).flatMap(spin => [spin.type, ...(spin.bonuses || []).map(bonus => bonus.type || bonus.feature || 'bonus')])].filter(Boolean))] };
  const key = fingerprint(outcome);
  if (outcomeFingerprints.has(key)) continue;
  const group = `${outcome.state || ''}:${outcome.tags.join(',')}`;
  const count = outcomeGroups.get(group) || 0;
  if (count >= MAX_OUTCOME_SAMPLES_PER_GROUP) continue;
  outcomeFingerprints.add(key); outcomeGroups.set(group, count + 1); outcomes.push(outcome);
}
const profile = {
  schemaVersion: 2, gameKey, generatedAt: new Date().toISOString(), captureCount: documents.length,
  capturedClientVersion: load.settings?.clientSettings?.configuredRtp || null,
  settings: load.settings, loadGameShape: { game: load.game, state: load.state, context: load.context || {}, jackpotStats: load.jackpotStats || [] },
  eventFamilies: families, outcomes, schemaHints,
  coverage: { events: Object.fromEntries(Object.entries(families).map(([event, samples]) => [event, samples.length])), states: [...new Set(server.map(message => message.state).filter(Boolean))], tags: [...new Set(outcomes.flatMap(outcome => outcome.tags))], outcomeSource: outcomes.length ? 'captured' : 'synthesized-paytable', reconnectConnections: documents.reduce((sum, document) => sum + Math.max(0, (document.connections?.length || 1) - 1), 0) },
};
const outputDir = path.join(__dirname, 'data', 'egt-profiles'); fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const output = path.join(outputDir, `${gameKey}.json`), temporary = `${output}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, output);
console.log(JSON.stringify({ output, coverage: profile.coverage }));
