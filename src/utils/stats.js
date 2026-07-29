const db = require('./db');
const priceFeed = require('./priceFeed');

function getStats(chatId) {
  const cid = String(chatId);
  const tradeCount = db.prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ?`).get(cid).c;

  const spentBnb = db
    .prepare(`SELECT COALESCE(SUM(entry_amount_bnb), 0) as total FROM positions WHERE chat_id = ?`)
    .get(cid).total;

  const madeBnb = db
    .prepare(
      `SELECT COALESCE(SUM(pnl_bnb), 0) as total FROM positions
       WHERE chat_id = ? AND status = 'closed' AND pnl_bnb > 0`
    )
    .get(cid).total;

  const lostBnb = Math.abs(
    db
      .prepare(
        `SELECT COALESCE(SUM(pnl_bnb), 0) as total FROM positions
         WHERE chat_id = ? AND status = 'closed' AND pnl_bnb < 0`
      )
      .get(cid).total
  );

  const openCount = db
    .prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ? AND status = 'open'`)
    .get(cid).c;
  const closedCount = tradeCount - openCount;

  return { tradeCount, openCount, closedCount, spentBnb, madeBnb, lostBnb };
}

async function getStatsWithUsd(chatId) {
  const stats = getStats(chatId);
  const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
  return {
    ...stats,
    bnbUsdPrice,
    spentUsd: bnbUsdPrice ? stats.spentBnb * bnbUsdPrice : null,
    madeUsd: bnbUsdPrice ? stats.madeBnb * bnbUsdPrice : null,
    lostUsd: bnbUsdPrice ? stats.lostBnb * bnbUsdPrice : null,
  };
}

function clearHistory(chatId) {
  const cid = String(chatId);
  db.prepare(`DELETE FROM positions WHERE chat_id = ?`).run(cid);
  // tokens/events are shared candidate-discovery data, not per-user — left alone.
}

module.exports = { getStats, getStatsWithUsd, clearHistory };
