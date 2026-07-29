const db = require('../utils/db');
const settings = require('../utils/settings');
const logger = require('../utils/logger');

class PositionManager {
  constructor(trader) {
    this.trader = trader;
    this.openPositions = new Map(); // tokenAddress -> position row
    this._loadOpenPositions();
  }

  _loadOpenPositions() {
    const rows = db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
    for (const row of rows) {
      this.openPositions.set(row.token_address, row);
    }
    logger.info(`Loaded ${rows.length} open position(s) from DB`);
  }

  count() {
    return this.openPositions.size;
  }

  isAtMaxPositions() {
    return this.count() >= settings.get('maxPositions');
  }

  async openPosition(tokenAddress, amountBnb, opts = {}) {
    const result = await this.trader.buy(tokenAddress, amountBnb);

    const stmt = db.prepare(`
      INSERT INTO positions
        (token_address, mode, status, entry_amount_bnb, entry_tx_hash,
         take_profit_pct, stop_loss_pct, opened_at)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      tokenAddress,
      this.trader.mode,
      amountBnb,
      result.txHash,
      opts.takeProfitPct ?? settings.get('takeProfitPct'),
      opts.stopLossPct ?? settings.get('stopLossPct'),
      Date.now()
    );

    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid);
    this.openPositions.set(tokenAddress, position);
    logger.info('Position opened', { tokenAddress, amountBnb, mode: this.trader.mode });
    return position;
  }

  async closePosition(tokenAddress, tokenAmount, reason = 'manual') {
    const position = this.openPositions.get(tokenAddress);
    if (!position) {
      logger.warn('No open position found to close', { tokenAddress });
      return null;
    }

    // If no explicit amount given, sell the full on-chain balance (paper mode
    // has no real balance, so fall back to a placeholder amount there).
    let amountToSell = tokenAmount;
    if (amountToSell === undefined || amountToSell === null) {
      amountToSell = this.trader.mode === 'live'
        ? await this.trader.getTokenBalance(tokenAddress)
        : 1n;
    }

    const result = await this.trader.sell(tokenAddress, amountToSell);

    db.prepare(`
      UPDATE positions
      SET status = 'closed', exit_tx_hash = ?, closed_at = ?
      WHERE id = ?
    `).run(result.txHash, Date.now(), position.id);

    this.openPositions.delete(tokenAddress);
    logger.info('Position closed', { tokenAddress, reason });
    return result;
  }

  /**
   * Closes every currently open position. Used by /stop and /closeall.
   * Returns { closed: [...], failed: [...] }
   */
  async closeAllPositions(reason = 'manual') {
    const tokens = [...this.openPositions.keys()];
    const closed = [];
    const failed = [];

    for (const tokenAddress of tokens) {
      try {
        await this.closePosition(tokenAddress, undefined, reason);
        closed.push(tokenAddress);
      } catch (err) {
        logger.error('Failed to close position during closeAll', {
          tokenAddress,
          error: err.message,
        });
        failed.push(tokenAddress);
      }
    }

    return { closed, failed };
  }

  /**
   * Called on a price-check interval (e.g. via node-cron) to evaluate
   * TP/SL against each open position's current price.
   * priceFetcher: async (tokenAddress) => currentPriceInBnb
   */
  async evaluatePositions(priceFetcher) {
    for (const [tokenAddress, position] of this.openPositions) {
      try {
        const currentPrice = await priceFetcher(tokenAddress);
        if (!position.entry_price_bnb || !currentPrice) continue;

        const pnlPct =
          ((currentPrice - position.entry_price_bnb) / position.entry_price_bnb) * 100;

        if (pnlPct >= position.take_profit_pct) {
          logger.info('Take-profit hit', { tokenAddress, pnlPct });
          // Caller should trigger closePosition with the actual token balance.
        } else if (pnlPct <= -position.stop_loss_pct) {
          logger.info('Stop-loss hit', { tokenAddress, pnlPct });
          // Caller should trigger closePosition with the actual token balance.
        }
      } catch (err) {
        logger.error('Error evaluating position', { tokenAddress, error: err.message });
      }
    }
  }
}

module.exports = { PositionManager };
