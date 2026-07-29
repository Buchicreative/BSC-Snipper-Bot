const db = require('./db');
const priceFeed = require('./priceFeed');

/**
 * Aggregates trade stats from the positions table.
 * spentBnb: total BNB committed across all positions ever opened
 * madeBnb: sum of positive pnl_bnb across closed positions
 * lostBnb: sum of negative pnl_bnb (as a positive number) across closed positions
 */
function getStats() {
  const tradeCount = db.prepare(`SELECT COUNT(*) as c FROM positions`).get().c;

  const spentRow = db.prepare(`SELECT COALESCE(SUM(entry_amount_bnb), 0) as total FROM positions`).get();
  const spentBnb = spentRow.total;

  const madeRow = db
    .prepare(`SELECT COALESCE(SUM(pnl_bnb), 0) as total FROM positions WHERE status = 'closed' AND pnl_bnb > 0`)
    .get();
  const madeBnb = madeRow.total;

  const lostRow = db
    .prepare(`SELECT COALESCE(SUM(pnl_bnb), 0) as total FROM positions WHERE status = 'closed' AND pnl_bnb < 0`)
    .get();
  const lostBnb = Math.abs(lostRow.total);

  const openCount = db.prepare(`SELECT COUNT(*) as c FROM positions WHERE status = 'open'`).get().c;
  const closedCount = tradeCount - openCount;

  return { tradeCount, openCount, closedCount, spentBnb, madeBnb, lostBnb };
}

async function getStatsWithUsd() {
  const stats = getStats();
  const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
  return {
    ...stats,
    bnbUsdPrice,
    spentUsd: bnbUsdPrice ? stats.spentBnb * bnbUsdPrice : null,
    madeUsd: bnbUsdPrice ? stats.madeBnb * bnbUsdPrice : null,
    lostUsd: bnbUsdPrice ? stats.lostBnb * bnbUsdPrice : null,
  };
}

function clearHistory() {
  db.prepare(`DELETE FROM positions`).run();
  db.prepare(`DELETE FROM events`).run();
  db.prepare(`DELETE FROM tokens`).run();
}

module.exports = { getStats, getStatsWithUsd, clearHistory };
