const MONEY_SCALE = 100;

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * MONEY_SCALE) / MONEY_SCALE;
}

function normalizeRtpPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || Math.abs(percent * 100 - Math.round(percent * 100)) > 0.000001) {
    throw new RangeError('RTP must be between 0.00% and 100.00%');
  }
  return Math.round(percent * 100) / 100;
}

function freshRtpAccounting(percent, changedAt = new Date().toISOString()) {
  return { rtpPercent: normalizeRtpPercent(percent), rtpEpoch: changedAt, rtpTotalWagered: 0, rtpTotalReturned: 0, rtpRawReturned: 0, rtpWallets: {} };
}

function snapshot(settings) {
  return { totalWagered: roundMoney(settings.rtpTotalWagered || 0), totalReturned: roundMoney(settings.rtpTotalReturned || 0), rawReturned: roundMoney(settings.rtpRawReturned || 0) };
}

function applyGlobalRtp(settings, rawDelta, walletKey) {
  const delta = roundMoney(rawDelta), percent = normalizeRtpPercent(settings.rtpPercent ?? 100);
  if (!walletKey) throw new TypeError('RTP wallet key is required');
  settings.rtpPercent = percent;
  settings.rtpTotalWagered = roundMoney(settings.rtpTotalWagered || 0);
  settings.rtpTotalReturned = roundMoney(settings.rtpTotalReturned || 0);
  settings.rtpRawReturned = roundMoney(settings.rtpRawReturned || 0);
  if (!settings.rtpWallets || typeof settings.rtpWallets !== 'object' || Array.isArray(settings.rtpWallets)) settings.rtpWallets = {};
  const wallet = settings.rtpWallets[walletKey] ||= { wagered: 0, returned: 0, rawReturned: 0 };
  wallet.wagered = roundMoney(wallet.wagered || 0); wallet.returned = roundMoney(wallet.returned || 0); wallet.rawReturned = roundMoney(wallet.rawReturned || 0);
  if (delta < 0) {
    settings.rtpTotalWagered = roundMoney(settings.rtpTotalWagered - delta);
    wallet.wagered = roundMoney(wallet.wagered - delta);
    return { appliedDelta: delta, rawDelta: delta, rtpPercent: percent, walletWagered: wallet.wagered, walletReturned: wallet.returned, ...snapshot(settings) };
  }
  if (delta === 0) return { appliedDelta: 0, rawDelta: 0, rtpPercent: percent, ...snapshot(settings) };
  settings.rtpRawReturned = roundMoney(settings.rtpRawReturned + delta);
  wallet.rawReturned = roundMoney(wallet.rawReturned + delta);
  // A positive upstream delta is an outcome already committed by EGT.
  // EGT has already authored and committed this complete outcome. Scaling it
  // here corrupts the paytable without controlling outcome probability.
  // Until outcomes can be selected before EGT commits a round, settlements
  // must remain exact provider pass-throughs.
  const credited = delta;
  wallet.returned = roundMoney(wallet.returned + credited);
  settings.rtpTotalReturned = roundMoney(settings.rtpTotalReturned + credited);
  return { appliedDelta: credited, rawDelta: delta, rtpPercent: percent, walletWagered: wallet.wagered, walletReturned: wallet.returned, ...snapshot(settings) };
}

module.exports = { applyGlobalRtp, freshRtpAccounting, normalizeRtpPercent, roundMoney };
