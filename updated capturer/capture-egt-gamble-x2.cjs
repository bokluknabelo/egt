const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const gameKey = process.argv[2] || 'FBHBLSlot';
const attemptsTarget = Math.max(1, Number(process.argv[3] || 25));
const output = process.argv[4] || path.join(__dirname, 'output', `${gameKey}-gamble-x2.json`);
const targetUrl = process.argv[5] || 'https://egt-digital.com/game/40-burning-hot-bell-link-2/';
const delayMs = Math.max(0, Number(process.env.EGT_CAPTURE_DELAY_MS || 150));

const CLIENT_VERSION = '1.61.5';
const BROWSER_NAME = 'Chrome 149 Ubuntu';
const SESSION_TOKEN = process.env.EGT_DEMO_SESSION_TOKEN || '12f33168-5ead-419a-aa72-b552dfdaf841';
const CHOICES = Object.freeze(['red', 'black']);

if (!/^[A-Za-z0-9_-]+$/.test(gameKey)) throw new Error('Usage: capture-egt-gamble-x2.cjs GAME_KEY [ATTEMPTS] [OUTPUT] [TARGET_URL]');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function encodeClient(value) { return JSON.stringify([JSON.stringify(value)]); }
function decodeServer(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  if (text === 'o' || text === 'h' || text.startsWith('c')) return [];
  const envelope = JSON.parse(text[0] === 'a' ? text.slice(1) : text);
  return (Array.isArray(envelope) ? envelope : [envelope]).map(value => typeof value === 'string' ? JSON.parse(value) : value);
}
function socketUrl() {
  const server = String(Math.floor(Math.random() * 900)).padStart(3, '0');
  const session = Math.random().toString(36).slice(2, 18);
  const params = new URLSearchParams({
    sessionToken: SESSION_TOKEN,
    casinoId: 'EGTBG',
    playerId: '1101',
    tempToken: '',
    gameKey,
    currencyCode: 'EGT',
    demo: 'true',
    channel: 'desktop',
    version: CLIENT_VERSION,
    browser: BROWSER_NAME,
  });
  return `wss://game-server-demo.egt-ong.com/game-websocket/${server}/${session}/websocket?${params}`;
}
function firstNumber(...values) {
  for (const value of values.flat()) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 1;
}
function firstNonNegativeNumber(...values) {
  for (const value of values.flat()) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}
function betFromLoadGame(message) {
  const settings = message.settings || {};
  const stateBet = message.game?.state?.bet || {};
  const level = firstNumber(stateBet.level, settings.bet, settings.bets);
  const denomination = firstNumber(stateBet.denomination, settings.denomination, settings.denominations);
  const lines = firstNonNegativeNumber(stateBet.lines, settings.lines, settings.linesOptions);
  const factor = firstNumber(stateBet.factor, settings.factor, settings.factors, lines);
  return { level, denomination, lines, factor, gameMode: stateBet.gameMode || 'NORMAL_MODE' };
}
function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function summarizeGamble(message, sourceWin) {
  const result = message.game?.result || {};
  const state = message.game?.state || {};
  const totalWin = money(result.totalWin ?? result.totalWinAmount ?? state.totalWinAmount ?? state.totalWin);
  const outcome = result.outcome ?? null;
  const history = Array.isArray(state.gambleHistory) ? state.gambleHistory : [];
  return {
    event: message.event || null,
    state: message.state || null,
    referenceId: message.referenceId ?? null,
    choice: result.choice ?? message.context?.gambleChoice ?? null,
    outcome,
    totalWin,
    sourceWin,
    winMultiplier: sourceWin > 0 ? totalWin / sourceWin : null,
    gamblesLeft: state.gambles ?? null,
    gambleHistory: history,
    resultKeys: Object.keys(result),
    stateKeys: Object.keys(state),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const messages = [], rawFrames = [], attempts = [];
  const summary = {
    schemaVersion: 1,
    gameKey,
    targetUrl,
    demoUrl: `https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`,
    attemptsTarget,
    delayMs,
    startedAt,
    completedAt: null,
    websocketUrl: null,
    bet: null,
    spins: 0,
    gambleAttempts: 0,
    x2Captured: false,
    states: {},
    serverEvents: {},
    clientEvents: {},
    errors: [],
  };

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(), {
      perMessageDeflate: false,
      headers: {
        Origin: 'https://games.egt-ong.com',
        'User-Agent': `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${BROWSER_NAME.replace(' ', '/')} Safari/537.36`,
      },
    });
    summary.websocketUrl = ws.url;
    let nextId = 1, loaded = false, pendingWin = 0, choiceIndex = 0;
    let sendQueue = Promise.resolve();
    const send = value => {
      const payload = encodeClient(value);
      rawFrames.push({ direction: 'client', at: new Date().toISOString(), payload });
      messages.push({ sequence: messages.length + 1, direction: 'client', at: new Date().toISOString(), event: value.event, message: value });
      summary.clientEvents[value.event] = (summary.clientEvents[value.event] || 0) + 1;
      ws.send(payload);
    };
    const sendAfterDelay = value => {
      sendQueue = sendQueue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        await sleep(delayMs);
        if (ws.readyState === WebSocket.OPEN) send(value);
      });
      return sendQueue;
    };
    const sendBet = () => sendAfterDelay({ event: 'bet', bet: summary.bet, context: {}, id: nextId++ });
    const sendGamble = () => {
      const gambleChoice = CHOICES[choiceIndex++ % CHOICES.length];
      summary.gambleAttempts += 1;
      return sendAfterDelay({ event: 'gamble', context: { gambleChoice }, id: nextId++ });
    };
    ws.on('message', async frame => {
      const payload = frame.toString();
      rawFrames.push({ direction: 'server', at: new Date().toISOString(), payload });
      if (payload === 'o') {
        send({ gameKey, event: 'loadGame', context: { clientVersion: CLIENT_VERSION, browser: BROWSER_NAME }, id: nextId++ });
        return;
      }
      if (payload.startsWith('c')) return;
      let decoded;
      try { decoded = decodeServer(payload); }
      catch (error) { summary.errors.push({ type: 'decode', message: error.message, payload }); return; }
      for (const message of decoded) {
        messages.push({ sequence: messages.length + 1, direction: 'server', at: new Date().toISOString(), event: message.event || null, state: message.state || null, message });
        if (message.event) summary.serverEvents[message.event] = (summary.serverEvents[message.event] || 0) + 1;
        if (message.state) summary.states[message.state] = (summary.states[message.state] || 0) + 1;
        if (message.error) summary.errors.push({ type: 'server', event: message.event, state: message.state, error: message.error, referenceId: message.referenceId });
        if (message.event === 'loadGame' && !loaded) {
          loaded = true;
          summary.bet = betFromLoadGame(message);
          await sendBet();
        } else if (message.event === 'bet') {
          if (message.error) { ws.close(1000); continue; }
          summary.spins += 1;
          const state = message.game?.state || {};
          const result = message.game?.result || {};
          pendingWin = money(state.totalWinAmount ?? state.totalWin ?? result.totalWinAmount ?? result.totalWin);
          if (message.state === 'win' && pendingWin > 0 && Number(state.gambles || 0) > 0) await sendGamble();
          else await sendBet();
        } else if (message.event === 'gamble') {
          const captured = summarizeGamble(message, pendingWin);
          attempts.push(captured);
          if (Math.abs(Number(captured.winMultiplier) - 2) < 0.000001 && message.state !== 'idle') {
            summary.x2Captured = true;
            ws.close(1000);
            continue;
          }
          if (attempts.length >= attemptsTarget) {
            ws.close(1000);
            continue;
          }
          if (message.state !== 'idle' && Number(message.game?.state?.gambles || 0) > 0 && money(message.game?.result?.totalWin ?? message.game?.result?.totalWinAmount) > 0) {
            pendingWin = money(message.game.result.totalWin ?? message.game.result.totalWinAmount);
            await sendGamble();
          } else await sendBet();
        }
      }
    });
    ws.on('close', (code, reason) => { summary.close = { code, reason: reason.toString() }; resolve(); });
    ws.on('error', error => { summary.errors.push({ type: 'websocket', message: error.message }); reject(error); });
  });

  summary.completedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify({ ...summary, attempts, rawFrames, messages }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, gameKey, spins: summary.spins, gambleAttempts: summary.gambleAttempts, x2Captured: summary.x2Captured, attempts: attempts.map(({ state, choice, outcome, totalWin, sourceWin, winMultiplier, gamblesLeft }) => ({ state, choice, outcome, totalWin, sourceWin, winMultiplier, gamblesLeft })), close: summary.close, errorCount: summary.errors.length, errors: summary.errors.slice(0, 5) }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
