const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const gameKey = process.argv[2] || 'FDHBLSlot';
const spinsTarget = Math.max(1, Number(process.argv[3] || 1000));
const output = process.argv[4] || path.join(__dirname, 'output', `${gameKey}-live-${spinsTarget}-spins.json`);
const delayMs = Math.max(100, Number(process.env.EGT_CAPTURE_DELAY_MS || 250));

const CLIENT_VERSION = '1.61.5';
const BROWSER_NAME = 'Chrome 149 Ubuntu';
const SESSION_TOKEN = process.env.EGT_DEMO_SESSION_TOKEN || '12f33168-5ead-419a-aa72-b552dfdaf841';
const BET = Object.freeze({ level: 10, denomination: 10, lines: 5, factor: 50, gameMode: 'NORMAL_MODE' });

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

async function main() {
  const startedAt = new Date().toISOString();
  const messages = [];
  const rawFrames = [];
  const summary = {
    schemaVersion: 1,
    gameKey,
    targetUrl: 'https://egt-digital.com/game/5-dazzling-hot-bell-link/',
    demoUrl: `https://games.egt-ong.com/?gameKey=${encodeURIComponent(gameKey)}`,
    spinsTarget,
    delayMs,
    startedAt,
    completedAt: null,
    websocketUrl: null,
    spins: 0,
    pickRequests: 0,
    featureResponses: 0,
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
        'User-Agent': `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${BROWSER_NAME.replace(' ', '/') } Safari/537.36`,
      },
    });
    summary.websocketUrl = ws.url;
    let nextId = 1;
    let loaded = false;
    let sending = false;
    const send = value => {
      const payload = encodeClient(value);
      rawFrames.push({ direction: 'client', at: new Date().toISOString(), payload });
      messages.push({ sequence: messages.length + 1, direction: 'client', at: new Date().toISOString(), event: value.event, message: value });
      summary.clientEvents[value.event] = (summary.clientEvents[value.event] || 0) + 1;
      ws.send(payload);
    };
    const sendAfterDelay = async value => {
      if (sending || ws.readyState !== WebSocket.OPEN) return;
      sending = true;
      await sleep(delayMs);
      if (ws.readyState === WebSocket.OPEN) send(value);
      sending = false;
    };
    const sendBet = () => sendAfterDelay({ event: 'bet', bet: BET, context: {}, id: nextId++ });
    const sendPick = choice => {
      summary.pickRequests += 1;
      return sendAfterDelay({ event: 'pick', context: { choice }, id: nextId++ });
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
        if (message.event === 'loadGame' && !loaded) {
          loaded = true;
          await sendBet();
        } else if (message.event === 'bet') {
          summary.spins += 1;
          if (message.state && message.state !== 'idle') summary.featureResponses += 1;
          if (message.state === 'pick' && message.game?.result?.scatters?.length) await sendPick(0);
          else if (summary.spins >= spinsTarget) ws.close(1000);
          else await sendBet();
        } else if (message.event === 'pick') {
          if (summary.spins >= spinsTarget) ws.close(1000);
          else await sendBet();
        }
      }
    });
    ws.on('close', (code, reason) => {
      summary.close = { code, reason: reason.toString() };
      resolve();
    });
    ws.on('error', error => {
      summary.errors.push({ type: 'websocket', message: error.message });
      reject(error);
    });
  });

  summary.completedAt = new Date().toISOString();
  const document = { ...summary, rawFrames, messages };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, spins: summary.spins, featureResponses: summary.featureResponses, states: summary.states, serverEvents: summary.serverEvents, close: summary.close, errors: summary.errors }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
