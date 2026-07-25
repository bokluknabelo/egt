function shouldIgnoreUpstreamReset({ upstreamBase, rawCredits, projected, localBalance, hidden, idleFor }) {
  return upstreamBase !== null
    && rawCredits === upstreamBase
    && projected !== localBalance
    && (hidden || idleFor > 60000);
}

module.exports = { shouldIgnoreUpstreamReset };
