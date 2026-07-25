const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const concurrency = Math.max(1, Number(process.env.EGT_BATCH_CONCURRENCY || 3));
const spins = Math.max(1, Number(process.env.EGT_BATCH_SPINS || 5000));
const outputDir = process.env.EGT_BATCH_OUTPUT || path.join(__dirname, 'output', `live-goal-${spins}`);
const nodeBin = process.execPath;
const maxAttempts = Math.max(1, Number(process.env.EGT_BATCH_ATTEMPTS || 2));
const timeoutMs = Math.max(60_000, Number(process.env.EGT_BATCH_TIMEOUT_MS || Math.max(1_800_000, spins * Number(process.env.EGT_CAPTURE_DELAY_MS || 100) * 4)));

const jobs = [
  ['VNBLSlot', 'https://egt-digital.com/game/vampire-night-bell-link/'],
  ['FHBLSlot', 'https://egt-digital.com/game/flaming-hot-bell-link/'],
  ['SBBLSlot', 'https://egt-digital.com/game/seker-bey-bell-link/'],
  ['BDBLSlot', 'https://egt-digital.com/game/black-diamond-bell-link/'],
  ['SACBLSlot', 'https://egt-digital.com/game/sword-and-crown-bell-link/'],
  ['MDBLSlot', 'https://egt-digital.com/game/mystic-desert-bell-link/'],
  ['ZWBLSlot', 'https://egt-digital.com/game/zodiac-wheel-bell-link/'],
  ['FZWBLSlot', 'https://egt-digital.com/game/40-zodiac-wheel-bell-link/'],
  ['PRCJWSlot', 'https://egt-digital.com/game/pyramid-riddles-cleopatra-jumboways/'],
  ['TWBHCHSlot', 'https://egt-digital.com/game/20-burning-hot-cash-heat/'],
  ['SCBLSlot', 'https://egt-digital.com/game/shining-crown-bell-link/'],
  ['FSCBLSlot', 'https://egt-digital.com/game/40-shining-crown-bell-link/'],
  ['TSFBLSlot', 'https://egt-digital.com/game/20-super-fruits-bell-link/'],
  ['FSFBLSlot', 'https://egt-digital.com/game/40-super-fruits-bell-link/'],
  ['OBCSlot', 'https://egt-digital.com/game/100-burning-clover/'],
  ['TBCSlot', 'https://egt-digital.com/game/20-burning-clover/'],
  ['FBCSlot', 'https://egt-digital.com/game/40-burning-clover/'],
  ['FBHSSlot', 'https://egt-digital.com/game/40-burning-hot-6-reels/'],
  ['BCSlot', 'https://egt-digital.com/game/5-burning-clover/'],
  ['EDSlot', 'https://egt-digital.com/game/emperors-dream/'],
  ['TSDSlot', 'https://egt-digital.com/game/10-shining-diamond/'],
  ['PCHCSlot', 'https://egt-digital.com/game/princess-cash/'],
  ['FMCSlot', 'https://egt-digital.com/game/40-mega-clover/'],
  ['TBHSlot', 'https://egt-digital.com/game/20-burning-hot/'],
  ['OSHSlot', 'https://egt-digital.com/game/100-super-hot/'],
  ['TDHSlot', 'https://egt-digital.com/game/20-dazzling-hot/'],
  ['TCWSlot', 'https://egt-digital.com/game/10-crystal-wish/'],
];

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
let cursor = 0, active = 0, failed = false;
const results = [];

function startJob(gameKey, url, output, attempt) {
  active += 1;
  process.stdout.write(JSON.stringify({ event: 'start', gameKey, output, attempt, active, remaining: jobs.length - cursor, timeoutMs }) + '\n');
  const child = spawn(nodeBin, ['capture-egt-live-direct.cjs', gameKey, String(spins), output, url], {
    cwd: __dirname,
    env: { ...process.env, EGT_CAPTURE_DELAY_MS: process.env.EGT_CAPTURE_DELAY_MS || '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => {
    clearTimeout(timer);
    active -= 1;
    let summary = null;
    try { summary = JSON.parse(stdout.trim().split(/\n/).filter(Boolean).at(-1)); } catch {}
    const result = { gameKey, output, attempt, code, timedOut, summary, stderr: stderr.trim().slice(-1000) };
    if ((timedOut || code !== 0 || summary?.errorCount) && attempt < maxAttempts) {
      process.stdout.write(JSON.stringify({ event: 'retry', ...result }) + '\n');
      startJob(gameKey, url, output, attempt + 1);
      runNext();
      return;
    }
    results.push(result);
    if (code !== 0 || timedOut || summary?.errorCount) failed = true;
    process.stdout.write(JSON.stringify({ event: 'done', ...result }) + '\n');
    runNext();
    if (!active && cursor >= jobs.length) {
      const manifest = { generatedAt: new Date().toISOString(), spins, outputDir, timeoutMs, maxAttempts, results };
      fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(JSON.stringify({ event: 'complete', failed, count: results.length, outputDir }) + '\n');
      process.exitCode = failed ? 1 : 0;
    }
  });
}

function runNext() {
  while (active < concurrency && cursor < jobs.length) {
    const [gameKey, url] = jobs[cursor++];
    const output = path.join(outputDir, `${gameKey}-${spins}.json`);
    if (fs.existsSync(output) && !process.env.EGT_BATCH_OVERWRITE) {
      results.push({ gameKey, output, skipped: true });
      continue;
    }
    startJob(gameKey, url, output, 1);
  }
}

runNext();
