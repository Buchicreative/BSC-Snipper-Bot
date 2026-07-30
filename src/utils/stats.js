const db = require('./db');

function getStats(chatId) {
  const cid = String(chatId);

  const closedCount = db
    .prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ? AND status = 'closed'`)
    .get(cid).c;
  const openCount = db
    .prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ? AND status = 'open'`)
    .get(cid).c;

  const winLoss = db
    .prepare(
      `SELECT
         SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses
       FROM positions WHERE chat_id = ? AND status = 'closed'`
    )
    .get(cid);

  const spentUsd = db
    .prepare(`SELECT COALESCE(SUM(entry_amount_usd), 0) as total FROM positions WHERE chat_id = ?`)
    .get(cid).total;

  const madeUsd = db
    .prepare(
      `SELECT COALESCE(SUM(pnl_usd), 0) as total FROM positions
       WHERE chat_id = ? AND status = 'closed' AND pnl_usd > 0`
    )
    .get(cid).total;

  const lostUsd = Math.abs(
    db
      .prepare(
        `SELECT COALESCE(SUM(pnl_usd), 0) as total FROM positions
         WHERE chat_id = ? AND status = 'closed' AND pnl_usd < 0`
      )
      .get(cid).total
  );

  return {
    closedCount,
    openCount,
    wins: winLoss.wins || 0,
    losses: winLoss.losses || 0,
    spentUsd,
    madeUsd,
    lostUsd,
    netUsd: madeUsd - lostUsd,
  };
}

function clearHistory(chatId) {
  const cid = String(chatId);
  db.prepare(`DELETE FROM positions WHERE chat_id = ?`).run(cid);
  // tokens/events are shared candidate-discovery data, not per-user — left alone.
}

module.exports = { getStats, clearHistory };
