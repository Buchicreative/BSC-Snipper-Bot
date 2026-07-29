const { Telegraf } = require('telegraf');
const config = require('../config');
const db = require('../utils/db');
const settings = require('../utils/settings');
const botState = require('../utils/botState');
const stats = require('../utils/stats');
const priceFeed = require('../utils/priceFeed');
const logger = require('../utils/logger');

// key -> { settingKey, parse, label }
const SET_COMMANDS = {
  setsize: { key: 'tradeSizeUsd', label: '$ per trade' },
  setgasreserve: { key: 'gasReserveUsd', label: '$ always kept as gas buffer' },
  setmaxpositions: { key: 'maxPositions', label: 'max simultaneous open positions' },
  setminliquidity: { key: 'minLiquidityUsd', label: 'minimum pool liquidity (USD) to buy' },
  setmaxmarketcap: { key: 'maxMarketCapUsd', label: 'skip tokens valued above this (USD)' },
  setminmarketcap: { key: 'minMarketCapUsd', label: 'skip tokens valued below this (USD)' },
  setmaxholderpercent: { key: 'maxHolderPercent', label: 'max % one wallet can hold' },
  settakeprofit: { key: 'takeProfitPct', label: 'gain % to auto-sell at' },
  setstoploss: { key: 'stopLossPct', label: 'loss % to auto-sell at' },
};

function formatSettings(s) {
  return (
    `Trade size: $${s.tradeSizeUsd}\n` +
    `Gas reserve: $${s.gasReserveUsd}\n` +
    `Max positions: ${s.maxPositions}\n` +
    `Min liquidity: $${s.minLiquidityUsd}\n` +
    `Max market cap: ${s.maxMarketCapUsd > 0 ? '$' + s.maxMarketCapUsd : 'no cap'}\n` +
    `Min market cap: ${s.minMarketCapUsd > 0 ? '$' + s.minMarketCapUsd : 'no floor'}\n` +
    `Max holder %: ${s.maxHolderPercent}%\n` +
    `Take profit: +${s.takeProfitPct}%\n` +
    `Stop loss: -${s.stopLossPct}%`
  );
}

function createBot({ positionManager }) {
  const bot = new Telegraf(config.telegram.botToken);

  bot.start((ctx) => {
    ctx.reply(
      `BSC Sniper Bot online — four.meme + PancakeSwap graduation\n` +
        `Mode: ${botState.getMode().toUpperCase()}\n\n` +
        `Commands:\n` +
        `/setsize <usd> - $ per trade\n` +
        `/setgasreserve <usd> - $ always kept untouched as gas buffer\n` +
        `/setmaxpositions <n> - max simultaneous open positions\n` +
        `/setminliquidity <usd> - minimum pool liquidity to buy\n` +
        `/setmaxmarketcap <usd> - skip tokens valued above this\n` +
        `/setminmarketcap <usd> - skip tokens valued below this\n` +
        `/setmaxholderpercent <percent> - max % one wallet can hold\n` +
        `/settakeprofit <percent> - gain % to auto-sell at\n` +
        `/setstoploss <percent> - loss % to auto-sell at\n` +
        `/stats - balance, trade count, spent/made/lost\n` +
        `/balance - show wallet BNB balance\n` +
        `/positions - show open positions\n` +
        `/history - show recent closed trades\n` +
        `/clearhistory confirm - permanently wipe trade history + stats\n` +
        `/pause - stop opening new positions\n` +
        `/resume - resume trading + reset circuit breaker\n` +
        `/mode <paper|live> - switch trading mode\n` +
        `/stop - close all positions and pause\n` +
        `/closeall - close all positions but keep trading (no pause)\n` +
        `/killswitch confirm - actually stop the deployment (not just pause)\n` +
        `/buy <token> <amountBnb> - manual buy\n` +
        `/sell <token> <amount> - manual sell`
    );
  });

  // --- Generic handler for all /set___ <value> commands ---
  for (const [command, { key, label }] of Object.entries(SET_COMMANDS)) {
    bot.command(command, (ctx) => {
      const parts = ctx.message.text.split(' ').filter(Boolean);
      const valueStr = parts[1];
      if (valueStr === undefined) {
        ctx.reply(`Usage: /${command} <value>\n(${label})`);
        return;
      }
      const value = parseFloat(valueStr);
      if (Number.isNaN(value)) {
        ctx.reply(`"${valueStr}" isn't a valid number.`);
        return;
      }
      try {
        const updated = settings.set(key, value);
        ctx.reply(`${label} set to ${updated}`);
      } catch (err) {
        ctx.reply(`Failed to update: ${err.message}`);
      }
    });
  }

  bot.command('settings', (ctx) => {
    ctx.reply(`Current settings:\n${formatSettings(settings.getAll())}`);
  });

  bot.command('status', (ctx) => {
    const s = settings.getAll();
    ctx.reply(
      `Mode: ${botState.getMode().toUpperCase()}${botState.isPaused() ? ' (PAUSED)' : ''}\n` +
        `Open positions: ${positionManager.count()} / ${s.maxPositions}\n\n` +
        `${formatSettings(s)}`
    );
  });

  bot.command('stats', async (ctx) => {
    try {
      const s = await stats.getStatsWithUsd();
      ctx.reply(
        `Trades: ${s.tradeCount} (${s.openCount} open, ${s.closedCount} closed)\n` +
          `Spent: ${s.spentBnb.toFixed(4)} BNB${s.spentUsd !== null ? ` (~$${s.spentUsd.toFixed(2)})` : ''}\n` +
          `Made: ${s.madeBnb.toFixed(4)} BNB${s.madeUsd !== null ? ` (~$${s.madeUsd.toFixed(2)})` : ''}\n` +
          `Lost: ${s.lostBnb.toFixed(4)} BNB${s.lostUsd !== null ? ` (~$${s.lostUsd.toFixed(2)})` : ''}`
      );
    } catch (err) {
      ctx.reply(`Failed to load stats: ${err.message}`);
    }
  });

  bot.command('balance', async (ctx) => {
    try {
      const balanceBnb = await positionManager.trader.getWalletBalanceBnb();
      const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
      const usdStr = bnbUsdPrice ? ` (~$${(balanceBnb * bnbUsdPrice).toFixed(2)})` : '';
      ctx.reply(`Wallet balance: ${balanceBnb.toFixed(4)} BNB${usdStr}`);
    } catch (err) {
      ctx.reply(`Failed to fetch balance: ${err.message}`);
    }
  });

  bot.command('positions', (ctx) => {
    const rows = db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
    if (rows.length === 0) {
      ctx.reply('No open positions.');
      return;
    }
    const lines = rows.map(
      (p) => `${p.token_address}\n  entry: ${p.entry_amount_bnb} BNB | tx: ${p.entry_tx_hash}`
    );
    ctx.reply(lines.join('\n\n'));
  });

  bot.command('history', (ctx) => {
    const rows = db
      .prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 10`)
      .all();
    if (rows.length === 0) {
      ctx.reply('No closed trades yet.');
      return;
    }
    const lines = rows.map((p) => `${p.token_address} | pnl: ${p.pnl_pct ?? 'n/a'}%`);
    ctx.reply(lines.join('\n'));
  });

  bot.command('clearhistory', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      ctx.reply('This permanently wipes trade history and stats.\nRun /clearhistory confirm to proceed.');
      return;
    }
    stats.clearHistory();
    positionManager.openPositions.clear();
    ctx.reply('Trade history and stats wiped.');
  });

  bot.command('pause', (ctx) => {
    botState.pause();
    ctx.reply('Paused — no new positions will be opened. Existing positions are untouched.');
  });

  bot.command('resume', (ctx) => {
    botState.resume();
    ctx.reply('Resumed — trading active again, circuit breaker reset.');
  });

  bot.command('mode', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newMode = parts[1]?.toLowerCase();
    if (!newMode) {
      ctx.reply(`Current mode: ${botState.getMode().toUpperCase()}\nUsage: /mode <paper|live>`);
      return;
    }
    try {
      const mode = botState.setMode(newMode);
      ctx.reply(`Mode switched to ${mode.toUpperCase()}.`);
    } catch (err) {
      ctx.reply(`Failed to switch mode: ${err.message}`);
    }
  });

  bot.command('stop', async (ctx) => {
    ctx.reply('Closing all open positions and pausing...');
    const { closed, failed } = await positionManager.closeAllPositions('stop_command');
    botState.pause();
    ctx.reply(
      `Closed ${closed.length} position(s).${failed.length ? ` Failed: ${failed.length}.` : ''}\nBot paused.`
    );
  });

  bot.command('closeall', async (ctx) => {
    ctx.reply('Closing all open positions (trading stays active)...');
    const { closed, failed } = await positionManager.closeAllPositions('closeall_command');
    ctx.reply(
      `Closed ${closed.length} position(s).${failed.length ? ` Failed: ${failed.length}.` : ''}\nStill trading.`
    );
  });

  bot.command('killswitch', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      ctx.reply(
        'This stops the bot process entirely (not just a pause) — open positions are left as-is.\n' +
          'Run /killswitch confirm to proceed.'
      );
      return;
    }
    botState.kill();
    ctx.reply('Kill switch activated. Shutting down now.').finally(() => {
      logger.warn('Process exiting due to /killswitch');
      // NOTE: if Railway's restart policy is set to ON_FAILURE with retries
      // remaining, it may restart the container — the persisted "killed"
      // flag in bot_state makes the bot exit again immediately on boot
      // rather than resume trading. To fully stop the deployment, also
      // stop/remove the service in the Railway dashboard.
      process.exit(0);
    });
  });

  bot.command('buy', async (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const [, tokenAddress, amountStr] = parts;
    if (!tokenAddress || !amountStr) {
      ctx.reply('Usage: /buy <tokenAddress> <amountBnb>');
      return;
    }
    try {
      const position = await positionManager.openPosition(tokenAddress, parseFloat(amountStr));
      ctx.reply(`Buy submitted for ${tokenAddress}. Position id: ${position.id}`);
    } catch (err) {
      logger.error('Manual buy failed', { error: err.message });
      ctx.reply(`Buy failed: ${err.message}`);
    }
  });

  bot.command('sell', async (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const [, tokenAddress, amountStr] = parts;
    if (!tokenAddress || !amountStr) {
      ctx.reply('Usage: /sell <tokenAddress> <tokenAmount>');
      return;
    }
    try {
      await positionManager.closePosition(tokenAddress, BigInt(amountStr));
      ctx.reply(`Sell submitted for ${tokenAddress}.`);
    } catch (err) {
      logger.error('Manual sell failed', { error: err.message });
      ctx.reply(`Sell failed: ${err.message}`);
    }
  });

  bot.catch((err, ctx) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

function notifyAdmin(bot, message) {
  if (config.telegram.adminChatId) {
    bot.telegram.sendMessage(config.telegram.adminChatId, message).catch((err) => {
      logger.error('Failed to notify admin', { error: err.message });
    });
  }
}

module.exports = { createBot, notifyAdmin };
