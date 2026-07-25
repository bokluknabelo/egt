const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'data', 'egt-migration-queue.json');
const concurrency = Math.max(1, Math.min(4, Number(process.env.MIGRATION_CONCURRENCY) || 2));
const captureMs = Math.max(15000, Math.min(300000, Number(process.env.MIGRATION_CAPTURE_MS) || 45000));
const validateOnly = process.env.MIGRATION_VALIDATE_ONLY === '1';

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file);
}
function catalogue() {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const readme = path.join(ROOT, entry.name, 'README.md'); if (!fs.existsSync(readme)) return [];
    const text = fs.readFileSync(readme, 'utf8'), key = text.match(/gameKey=([A-Za-z0-9_-]+)/)?.[1];
    const url = text.match(/(?:Product page|Source product page):\s*(?:\n\s*)?`(https:\/\/egt-digital\.com\/game\/[^`]+)`/i)?.[1] || (key ? `https://egt-digital.com/game/${entry.name}/` : '');
    return key && url ? [{ slug: entry.name, gameKey: key, url }] : [];
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}
function loadState() {
  let old = {}; try { old = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  const byKey = new Map((old.titles || []).map(item => [item.gameKey, item]));
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), concurrency, captureMs, titles: catalogue().map(item => ({ ...item, status: 'queued', attempts: 0, ...byKey.get(item.gameKey), ...(byKey.get(item.gameKey)?.status === 'running' ? { status: 'queued' } : {}) })) };
}
function command(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }, timeoutMs); timer.unref();
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout || `timed out or exited ${code}`).trim().slice(-4000))); });
  });
}

const state = loadState(); atomicJson(STATE_FILE, state);
async function migrate(title) {
  title.status = 'running'; title.attempts += 1; title.startedAt = new Date().toISOString(); title.error = ''; atomicJson(STATE_FILE, state);
  try {
    const captureDir = path.join(ROOT, 'data', 'egt-captures', title.gameKey); fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
    if (!validateOnly || !fs.existsSync(path.join(ROOT, 'data', 'egt-profiles', `${title.gameKey}.json`))) {
      const capture = path.join(captureDir, `${Date.now()}-bulk.json`);
      title.captureResult = JSON.parse(await command(['capture-egt-protocol.cjs', title.gameKey, capture, String(captureMs)], captureMs + 120000));
      const corpus = fs.readdirSync(captureDir).filter(name => name.endsWith('.json')).sort().map(name => path.join(captureDir, name));
      title.profileResult = JSON.parse(await command(['merge-egt-profile.cjs', title.gameKey, ...corpus]));
    } else title.profileResult = { output: path.join(ROOT, 'data', 'egt-profiles', `${title.gameKey}.json`), coverage: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'egt-profiles', `${title.gameKey}.json`), 'utf8')).coverage };
    const validationText = await command(['validate-egt-local-client.cjs', title.gameKey]);
    title.validation = JSON.parse(validationText);
    if (title.validation.loadRequests !== 1 || title.validation.betRequests < 1 || title.validation.errors?.length) throw new Error(`Browser validation failed: ${JSON.stringify(title.validation.errors || [])}`);
    if (!title.profileResult.coverage?.events?.bet && title.profileResult.coverage?.outcomeSource !== 'synthesized-paytable') throw new Error('Profile has neither captured nor synthesized outcome support');
    title.status = 'operational'; title.completedAt = new Date().toISOString();
  } catch (error) { title.status = 'failed'; title.error = error.message; title.completedAt = new Date().toISOString(); }
  state.updatedAt = new Date().toISOString(); atomicJson(STATE_FILE, state);
  const totals = Object.fromEntries(['queued','running','operational','failed'].map(status => [status, state.titles.filter(item => item.status === status).length]));
  console.log(JSON.stringify({ gameKey: title.gameKey, status: title.status, error: title.error || undefined, totals }));
}
(async () => {
  const pending = state.titles.filter(item => !['operational'].includes(item.status)); let cursor = 0;
  async function worker() { while (cursor < pending.length) await migrate(pending[cursor++]); }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  const failed = state.titles.filter(item => item.status !== 'operational');
  console.log(JSON.stringify({ complete: !failed.length, total: state.titles.length, operational: state.titles.length - failed.length, failed: failed.map(item => ({ gameKey: item.gameKey, error: item.error })) }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
