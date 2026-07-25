const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonical, deepFreeze } = require('./egt-math-configs.cjs');

const cache = new Map();

function verifyConfiguration(config) {
  const body = structuredClone(config), expected = body.versionHash; delete body.versionHash;
  const actual = crypto.createHash('sha256').update(canonical(body)).digest('hex');
  if (actual !== expected) throw new Error(`math configuration hash mismatch for ${config.gameKey}-${config.targetRtp}`);
  return deepFreeze(structuredClone(config));
}

function loadTitleConfigurations(gameKey) {
  if (cache.has(gameKey)) return cache.get(gameKey);
  const filename = path.join(__dirname, 'data', 'egt-math-configs', `${gameKey}.json`);
  if (!fs.existsSync(filename)) { cache.set(gameKey, null); return null; }
  const artifact = JSON.parse(fs.readFileSync(filename, 'utf8')), configurations = new Map();
  for (const [target, record] of Object.entries(artifact.configurations || {})) {
    // A base-game target is not a selectable title RTP. Free spins, hold-and-spin,
    // jackpots and other features must be included in the immutable model first.
    if (record.config?.featureMathComplete !== true) continue;
    if (record.config?.runtimeProtocolReady !== true) continue;
    if (!record.converged) continue;
    const totalRtp = Number(record.math?.totalRtp);
    if (!Number.isFinite(totalRtp) || Math.abs(totalRtp - Number(target) / 100) > 0.00021) continue;
    configurations.set(Number(target), verifyConfiguration(record.config));
  }
  const loaded = deepFreeze({ gameKey, factor: Number(artifact.factor), configurations });
  cache.set(gameKey, loaded); return loaded;
}

function selectMathConfiguration(gameKey, targetRtp) {
  const title = loadTitleConfigurations(gameKey);
  if (!title) return null;
  return title.configurations.get(Number(targetRtp)) || null;
}

module.exports = { loadTitleConfigurations, selectMathConfiguration, verifyConfiguration };
