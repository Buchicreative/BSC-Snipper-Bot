const db = require('../utils/db');
const userSettings = require('../utils/userSettings');
const logger = require('../utils/logger');

/**
 * Per-user position tracking, backed directly by the DB (no in-memory
 * cache) — every function takes chatId as the first argument to scope
 * queries to that user. Simpler and safer for multi-user than maintaining
 * a Map per user in memory, and position-count queries are cheap enough
 * that there's no real performance cost.
 */

function getOpenPositions(chatId) {
  return db.prepare(`SELECT * FROM positions WHERE chat_id = ? AND status = 'open'`).all(String(chatId));
}

function countOpenPositions(chatId) {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ? AND status = 'open'`)
    .get(String(chatId));
  return row.c;
}

function isAtMaxPositions(chatId) {
  return countOpenPositions(chatId) >= userSettings.get(chatId, 'maxPositions');
}

async function openPosition(chatId, trader, tokenAddress, amountBnb, opts = {}) {
  const result = await trader.buy(tokenAddress, amountBnb, {
    slippageBps: userSettings.get(chatId, 'slippageBps'),
  });

  const info = db
    .prepare(
      `INSERT INTO positions
        (chat_id, token_address, mode, status, entry_amount_bnb, entry_tx_hash,
         take_profit_pct, stop_loss_pct, opened_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`
    )
    .run(
      String(chatId),
      tokenAddress,
      trader.mode,
      amountBnb,
      result.txHash,
      opts.takeProfitPct ?? userSettings.get(chatId, 'takeProfitPct'),
      opts.stopLossPct ?? userSettings.get(chatId, 'stopLossPct'),
      Date.now()
    );

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid);
  logger.info('Position opened', { chatId: String(chatId), tokenAddress, amountBnb, mode: trader.mode });
  return position;
}

async function closePosition(chatId, trader, tokenAddress, tokenAmount, reason = 'manual') {
  const position = db
    .prepare(`SELECT * FROM positions WHERE chat_id = ? AND token_address = ? AND status = 'open'`)
    .get(String(chatId), tokenAddress);

  if (!position) {
    logger.warn('No open position found to close', { chatId: String(chatId), tokenAddress });
    return null;
  }

  let amountToSell = tokenAmount;
  if (amountToSell === undefined || amountToSell === null) {
    amountToSell = trader.mode === 'live' ? await trader.getTokenBalance(tokenAddress) : 1n;
  }

  const result = await trader.sell(tokenAddress, amountToSell, {
    slippageBps: userSettings.get(chatId, 'slippageBps'),
  });

  db.prepare(`UPDATE positions SET status = 'closed', exit_tx_hash = ?, closed_at = ? WHERE id = ?`).run(
    result.txHash,
    Date.now(),
    position.id
  );

  logger.info('Position closed', { chatId: String(chatId), tokenAddress, reason });
  return result;
}

async function closeAllPositions(chatId, trader, reason = 'manual') {
  const open = getOpenPositions(chatId);
  const closed = [];
  const failed = [];

  for (const position of open) {
    try {
      await closePosition(chatId, trader, position.token_address, undefined, reason);
      closed.push(position.token_address);
    } catch (err) {
      logger.error('Failed to close position during closeAll', {
        chatId: String(chatId),
        tokenAddress: position.token_address,
        error: err.message,
      });
      failed.push(position.token_address);
    }
  }

  return { closed, failed };
}

module.exports = {
  getOpenPositions,
  countOpenPositions,
  isAtMaxPositions,
  openPosition,
  closePosition,
  closeAllPositions,
};
