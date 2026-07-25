#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RULES_FILE = path.join(ROOT, 'data', 'egt-family-rules.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'egt-client-math-metadata.json');

function balanced(text, marker) {
  const markerAt = text.indexOf(marker);
  if (markerAt < 0) return null;
  const start = text.indexOf('[', markerAt + marker.length);
  if (start < 0) return null;
  let depth = 0, quote = null, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '[') depth += 1;
    else if (character === ']' && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function sourceFolder(title) {
  const source = String(title.source || '').replaceAll('\\', '/');
  const extractedAt = source.indexOf('/extracted/');
  return extractedAt < 0 ? null : source.slice(0, extractedAt + '/extracted'.length);
}

function jsFiles(folder) {
  const absolute = path.join(ROOT, folder);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute).filter(name => name.endsWith('.js')).map(name => path.join(absolute, name));
}

function parseCandidate(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const linesBlock = balanced(text, 'this._lines=');
  const symbolsBlock = balanced(text, 'this._symbolsConfig=');
  if (!symbolsBlock) return null;
  const paylines = [...(linesBlock || '').matchAll(/cells:\[([^\]]+)\]/g)].map(match =>
    match[1].split(',').map(value => Number(value.trim())).filter(Number.isFinite));
  const symbols = [...symbolsBlock.matchAll(/\{index:(\d+),([\s\S]*?)(?=\},\{index:|\}\]$)/g)].map(match => ({
    index: Number(match[1]),
    name: match[2].match(/(?:^|,)name:"([^"]+)"/)?.[1] || null,
    wild: /(?:^|,)isWild:!0(?:,|$)/.test(match[2]),
    scatter: /(?:^|,)isScatter:!0(?:,|$)/.test(match[2]),
  }));
  if (!symbols.length) return null;
  const numberOfLines = Number(text.match(/this\._numberOfLines=(\d+)/)?.[1] || paylines.length);
  const title = text.match(/this\._gameTitle="([^"]+)"/)?.[1] || null;
  const wildIndex = Number(text.match(/this\._wildIndex=(\d+)/)?.[1]);
  if (Number.isFinite(wildIndex) && !symbols.some(symbol => symbol.index === wildIndex && symbol.wild)) {
    const symbol = symbols.find(item => item.index === wildIndex);
    if (symbol) symbol.wild = true;
  }
  return {
    title,
    numberOfLines,
    paylines,
    symbols,
    source: path.relative(ROOT, filename),
    sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    score: (path.basename(filename).startsWith('index.') ? 0 : 1000) + symbols.length * 10 + paylines.length,
  };
}

function extractTitle(title) {
  const folder = sourceFolder(title);
  if (!folder) return null;
  const candidates = jsFiles(folder).map(parseCandidate).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!candidates.length) return null;
  const selected = candidates[0];
  const wilds = selected.symbols.filter(symbol => symbol.wild).map(symbol => symbol.index);
  const scatters = selected.symbols.filter(symbol => symbol.scatter).map(symbol => symbol.index);
  return {
    gameKey: title.gameKey,
    clientTitle: selected.title,
    numberOfLines: selected.numberOfLines,
    paylines: selected.paylines,
    symbols: selected.symbols,
    symbolsAuthoritative: true,
    wilds,
    scatters,
    source: selected.source,
    sourceSha256: selected.sourceSha256,
    paylinesSource: selected.paylines.length ? selected.source : null,
    paylinesSourceSha256: selected.paylines.length ? selected.sourceSha256 : null,
  };
}

function lineOnlyMetadata(gameKey) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'egt-profiles', `${gameKey}.json`), 'utf8'));
    return {
      gameKey, clientTitle: null,
      numberOfLines: Number(profile.settings?.lines || profile.settings?.linesOptions?.[0] || 0),
      paylines: [], symbols: [], symbolsAuthoritative: false, wilds: [], scatters: [],
      source: null, sourceSha256: null, paylinesSource: null, paylinesSourceSha256: null,
    };
  } catch { return null; }
}

function visibleRows(gameKey) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'egt-profiles', `${gameKey}.json`), 'utf8'));
    const reels = profile.eventFamilies?.bet?.find(item => item.game?.result?.spins?.[0]?.reels)?.game.result.spins[0].reels || profile.settings?.reels || [];
    const lengths = reels.map(reel => Array.isArray(reel) ? reel.length : 0).filter(Boolean);
    return lengths.length ? Math.max(1, Math.min(...lengths) - 2) : 0;
  } catch { return 0; }
}

function applySharedPaylineCatalog(titles) {
  const candidates = new Map();
  for (const metadata of Object.values(titles)) {
    if (!metadata.paylines.length) continue;
    const rows = Math.max(...metadata.paylines.flat()) + 1, key = `${metadata.numberOfLines}:${rows}`;
    const signature = crypto.createHash('sha256').update(JSON.stringify(metadata.paylines)).digest('hex');
    if (!candidates.has(key)) candidates.set(key, new Map());
    const variants = candidates.get(key);
    if (!variants.has(signature)) variants.set(signature, []);
    variants.get(signature).push(metadata);
  }
  for (const metadata of Object.values(titles)) {
    if (metadata.paylines.length || !metadata.numberOfLines) continue;
    const variants = candidates.get(`${metadata.numberOfLines}:${visibleRows(metadata.gameKey)}`);
    if (!variants || variants.size !== 1) continue;
    const [signature, examples] = [...variants.entries()][0];
    metadata.paylines = structuredClone(examples[0].paylines);
    metadata.paylinesSource = `shared-client-catalog:${examples.map(example => example.gameKey).sort().join(',')}`;
    metadata.paylinesSourceSha256 = signature;
  }
}

function main() {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const titles = {}, missing = [];
  for (const title of rules.titles || []) {
    const metadata = extractTitle(title);
    if (metadata) titles[title.gameKey] = metadata;
    else {
      missing.push(title.gameKey);
      const lineOnly = lineOnlyMetadata(title.gameKey);
      if (lineOnly) titles[title.gameKey] = lineOnly;
    }
  }
  applySharedPaylineCatalog(titles);
  const body = { schemaVersion: 1, generatedAt: new Date().toISOString(), titles, missing };
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(body, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT_FILE), titles: Object.keys(titles).length, explicitSymbolConfigs: Object.values(titles).filter(title => title.symbolsAuthoritative).length, missingSymbolConfigs: missing.length }, null, 2));
}

if (require.main === module) main();
module.exports = { applySharedPaylineCatalog, balanced, extractTitle, lineOnlyMetadata, parseCandidate, sourceFolder, visibleRows };
