const fs = require('fs');
const path = require('path');

const root = __dirname;
const dataPath = process.env.LAUNCHER_DATA_PATH || path.join(root, 'data', 'launcher-auth.json');
const runtimePath = process.env.LAUNCHER_FILE_RUNTIME_PATH || path.join(path.dirname(dataPath), 'launcher-file-runtime.json');

let state = null;
let runtime = { ledger: [], errors: [], updateChecks: [], importerJobs: [], sessions: [], gameBridges: [] };

function now() { return new Date().toISOString(); }
function readJson(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function loadRuntime() { runtime = { ...runtime, ...readJson(runtimePath, {}) }; return runtime; }
function saveRuntime() { writeJson(runtimePath, runtime); }
function saveMain() { if (state) writeJson(dataPath, state); }

async function initStorage(fallbackState) {
  state = readJson(dataPath, fallbackState);
  loadRuntime();
  return state;
}

async function saveState(nextState) {
  state = nextState;
  saveMain();
}

async function saveStateWithLedger(nextState, entries) {
  state = nextState;
  runtime.ledger.push(...entries.map(entry => ({ ...entry, createdAt: entry.createdAt || now() })));
  saveMain(); saveRuntime();
}

async function saveGameSettlements(nextState, entries) {
  state = nextState;
  runtime.ledger.push(...entries.map(entry => ({ ...entry, createdAt: entry.createdAt || now() })));
  saveMain(); saveRuntime();
}

async function listLedger(instanceId, options = {}) {
  return runtime.ledger
    .filter(entry => entry.instanceId === instanceId)
    .filter(entry => !options.userId || entry.userId === options.userId)
    .filter(entry => !options.reason || entry.reason === options.reason)
    .filter(entry => !options.since || new Date(entry.createdAt || 0) > new Date(options.since))
    .slice(-Math.min(50000, Math.max(1, Number(options.limit) || 200)))
    .reverse();
}

async function recordError(level, source, message, details = {}) {
  runtime.errors.push({ id: runtime.errors.length + 1, level, source, message: String(message).slice(0, 2000), details, createdAt: now() });
  saveRuntime();
}

async function monitoringSnapshot() {
  return { database: { stateUpdatedAt: now(), bytes: fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0 }, errors: runtime.errors.slice(-100).reverse(), ledgerEntries: runtime.ledger.length };
}

async function recordUpdateCheck(status, previousHash, currentHash, details = {}) {
  runtime.updateChecks.push({ id: runtime.updateChecks.length + 1, status, previousHash, currentHash, details, createdAt: now() });
  saveRuntime();
}

async function recentUpdateChecks(limit = 30) { return runtime.updateChecks.slice(-limit).reverse(); }
async function saveImporterJob(job) { runtime.importerJobs = runtime.importerJobs.filter(item => item.id !== job.id); runtime.importerJobs.push(job); saveRuntime(); }
async function loadImporterJobs() { return runtime.importerJobs; }
async function pruneOperationalData() {}

async function saveSession(tokenHash, session) {
  runtime.sessions = runtime.sessions.filter(item => item.tokenHash !== tokenHash);
  runtime.sessions.push({ tokenHash, ...session });
  saveRuntime();
}
async function loadSessions() {
  const time = Date.now();
  return runtime.sessions.filter(item => item.expiresAt == null || Number(item.expiresAt) > time);
}
async function deleteSession(tokenHash) { runtime.sessions = runtime.sessions.filter(item => item.tokenHash !== tokenHash); saveRuntime(); }
async function pruneSessions() {
  const time = Date.now();
  runtime.sessions = runtime.sessions.filter(item => item.expiresAt == null || Number(item.expiresAt) > time);
  saveRuntime();
}

async function saveGameBridge(tokenHash, bridge) {
  runtime.gameBridges = runtime.gameBridges.filter(item => item.tokenHash !== tokenHash);
  runtime.gameBridges.push({ tokenHash, ...bridge });
  saveRuntime();
}
async function loadGameBridges() { return runtime.gameBridges.map(item => ({ ...item, queue: Promise.resolve() })); }
async function pruneGameBridges() {}

const pool = {
  async query() { return { rows: [{ ok: 1, count: runtime.ledger.length, bytes: fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0, stateUpdatedAt: now() }], rowCount: 1 }; },
  async connect() { return { query: pool.query, release() {} }; },
  async end() {},
};

module.exports = { initStorage, saveState, saveStateWithLedger, saveGameSettlements, listLedger, recordError, monitoringSnapshot, recordUpdateCheck, recentUpdateChecks, saveSession, loadSessions, deleteSession, pruneSessions, saveGameBridge, loadGameBridges, pruneGameBridges, saveImporterJob, loadImporterJobs, pruneOperationalData, pool };
