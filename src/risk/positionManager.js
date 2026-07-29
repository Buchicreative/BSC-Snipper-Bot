const db = require('../utils/db');
const userSettings = require('../utils/userSettings');
const logger = require('../utils/logger');
const { getLiquidityAndMarketCapUsd } = require('../filters/safetyChecks');

/**
 * Per-user position tracking, backed directly by the DB (no in-memory
 * cache) — every function takes chatId as the first argument to scope
 * queries to that user.
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

/**
 * opts.tokenSymbol, opts.entryAmountUsd, opts.entryPriceUsd,
 * opts.openedMarketCapUsd — all optional display data, typically passed
 * straight through from the safety-check data already gathered for this
 * candidate (no extra RPC calls needed at open time).
 */
async function openPosition(chatId, trader, tokenAddress, amountBnb, opts = {}) {
  const result = await trader.buy(tokenAddress, amountBnb, {
    slippageBps: userSettings.get(chatId, 'slippageBps'),
  });

  const info = db
    .prepare(
      `INSERT INTO positions
        (chat_id, token_address, mode, status, entry_amount_bnb, entry_amount_usd,
         entry_price_usd, opened_market_cap_usd, token_symbol, entry_tx_hash,
         take_profit_pct, stop_loss_pct, opened_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(chatId),
      tokenAddress,
      trader.mode,
      amountBnb,
      opts.entryAmountUsd ?? null,
      opts.entryPriceUsd ?? null,
      opts.openedMarketCapUsd ?? null,
      opts.tokenSymbol ?? null,
      result.txHash,
      opts.takeProfitPct ?? userSettings.get(chatId, 'takeProfitPct'),
      opts.stopLossPct ?? userSettings.get(chatId, 'stopLossPct'),
      Date.now()
    );

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid);
  logger.info('Position opened', { chatId: String(chatId), tokenAddress, amountBnb, mode: trader.mode });
  return position;
}

/**
 * Closes a position, fetching a fresh market cap reading at close time to
 * compute PnL as a market-cap-ratio estimate — i.e. "if the token's market
 * cap moved X% since I bought, my position is worth roughly X% more/less."
 * This is an approximation (doesn't account for slippage or the exact
 * swap-out amount), same approach used by comparable bots for a quick PnL
 * display rather than exact settlement accounting.
 */
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

  let closedMarketCapUsd = null;
  let pnlPct = null;
  let pnlUsd = null;
  let pnlBnb = null;
  try {
    const { marketCapUsd } = await getLiquidityAndMarketCapUsd(tokenAddress, trader.provider);
    closedMarketCapUsd = marketCapUsd;
    if (position.opened_market_cap_usd && position.opened_market_cap_usd > 0) {
      pnlPct = ((closedMarketCapUsd - position.opened_market_cap_usd) / position.opened_market_cap_usd) * 100;
      if (position.entry_amount_usd) {
        pnlUsd = position.entry_amount_usd * (pnlPct / 100);
      }
      pnlBnb = position.entry_amount_bnb * (pnlPct / 100);
    }
  } catch (err) {
    logger.warn('Could not fetch closing market cap for PnL estimate', { tokenAddress, error: err.message });
  }

  db.prepare(
    `UPDATE positions
     SET status = 'closed', exit_tx_hash = ?, closed_at = ?, closed_market_cap_usd = ?,
         pnl_pct = ?, pnl_usd = ?, pnl_bnb = ?, close_reason = ?
     WHERE id = ?`
  ).run(result.txHash, Date.now(), closedMarketCapUsd, pnlPct, pnlUsd, pnlBnb, reason, position.id);

  logger.info('Position closed', { chatId: String(chatId), tokenAddress, reason, pnlPct });
  return { ...result, pnlPct, pnlUsd, pnlBnb, closedMarketCapUsd };
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
