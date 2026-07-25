function compressionCacheVariant({ contentType = '', pathname = '', hidePlayLabels = true, currency = 'RON' } = {}) {
  // HTML contains a per-launch wallet token and must never share a compressed body.
  if (/text\/html/i.test(contentType)) return null;
  if (/index\.bundle\.min\.js$/.test(pathname)) return `index-${Boolean(hidePlayLabels)}-${currency}`;
  return 'default';
}

module.exports = { compressionCacheVariant };
