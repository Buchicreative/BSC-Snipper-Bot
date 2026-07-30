const { Telegraf } = require('telegraf');
const config = require('../config');
const db = require('../utils/db');
const userSettings = require('../utils/userSettings');
const userBotState = require('../utils/userBotState');
const userWallets = require('../utils/userWallets');
const botState = require('../utils/botState');
const stats = require('../utils/stats');
const priceFeed = require('../utils/priceFeed');
const logger = require('../utils/logger');
const { getTraderForUser } = require('../execution/traderFactory');
const positionManager = require('../risk/positionManager');
const { shortAddr, pnlEmoji, closeReasonLabel, formatUsd, formatMc } = require('../utils/formatting');
const { getLiquidityAndMarketCapUsd } = require('../filters/safetyChecks');
const fourMemeTrader = require('../utils/fourMemeTrader');

const SET_COMMANDS = {
  setsize: { key: 'tradeSizeUsd', label: '$ per trade' },
  setgasreserve: { key: 'gasReserveUsd', label: '$ always kept as gas buffer' },
  setmaxpositions: { key: 'maxPositions', label: 'max simultaneous open positions' },
  setminliquidity: { key: 'minLiquidityUsd', label: 'minimum pool liquidity (USD) to buy' },
  setmaxmarketcap: { key: 'maxMarketCapUsd', label: 'skip tokens valued above this (USD)' },
  setminmarketcap: { key: 'minMarketCapUsd', label: 'skip tokens valued below this (USD)' },
  setmaxholderpercent: { key: 'maxHolderPercent', label: 'max % one wallet can hold' },
  setmaxbuytax: { key: 'maxBuyTaxPct', label: 'reject tokens with buy tax above this %' },
  setmaxselltax: { key: 'maxSellTaxPct', label: 'reject tokens with sell tax above this %' },
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
    `Max buy tax: ${s.maxBuyTaxPct}%\n` +
    `Max sell tax: ${s.maxSellTaxPct}%\n` +
    `Take profit: +${s.takeProfitPct}%\n` +
    `Stop loss: -${s.stopLossPct}%`
  );
}

const SECURITY_NOTICE =
  '📌 A quick note on how this works: to trade automatically for you, this bot stores your wallet\'s ' +
  'private key encrypted in its database — similar to how any exchange or auto-trading bot holds funds ' +
  'on your behalf. Nobody is watching or using your key; it just sits there encrypted so the bot can sign ' +
  'trades for you. As with any bot like this, it\'s good practice to keep only what you\'re actively trading ' +
  'with here, and move profits out whenever you like — /exportkey gets your key back out anytime, no questions asked.';

function createBot({ provider }) {
  const bot = new Telegraf(config.telegram.botToken);

  // --- Access control: only allowlisted Telegram user IDs get past here ---
  bot.use((ctx, next) => {
    if (!ctx.from) return next();
    if (!userWallets.isAllowlisted(ctx.from.id)) {
      ctx.reply('This bot is restricted to approved users. Ask the operator to add your Telegram ID to the allowlist.');
      return;
    }
    return next();
  });

  bot.start((ctx) => {
    const hasWallet = userWallets.hasWallet(ctx.from.id);
    ctx.reply(
      `BSC Sniper Bot — four.meme + PancakeSwap graduation\n` +
        `Wallet: ${hasWallet ? userWallets.getWalletAddress(ctx.from.id) : 'none — use /generatewallet or /importwallet'}\n` +
        `Mode: ${userBotState.getMode(ctx.from.id).toUpperCase()}\n\n` +
        `Wallet commands:\n` +
        `/generatewallet - create a new wallet for you\n` +
        `/importwallet <privateKey or seed phrase> - use your own wallet\n` +
        `/wallet - show your address and BNB balance\n` +
        `/exportkey confirm - reveal your private key (auto-deletes after 60s)\n` +
        `/deletewallet confirm - remove your stored wallet\n\n` +
        `Trading commands:\n` +
        `/setsize <usd> - $ per trade\n` +
        `/setgasreserve <usd> - $ always kept untouched as gas buffer\n` +
        `/setmaxpositions <n> - max simultaneous open positions\n` +
        `/setminliquidity <usd> - minimum pool liquidity to buy\n` +
        `/setmaxmarketcap <usd> - skip tokens valued above this\n` +
        `/setminmarketcap <usd> - skip tokens valued below this\n` +
        `/setmaxholderpercent <percent> - max % one wallet can hold\n` +
        `/setmaxbuytax <percent> - reject tokens with buy tax above this\n` +
        `/setmaxselltax <percent> - reject tokens with sell tax above this\n` +
        `/settakeprofit <percent> - gain % to auto-sell at\n` +
        `/setstoploss <percent> - loss % to auto-sell at\n` +
        `/stats - balance, trade count, spent/made/lost\n` +
        `/balance - show wallet BNB balance\n` +
        `/positions - show open positions\n` +
        `/history - show recent closed trades\n` +
        `/clearhistory confirm - permanently wipe your trade history + stats\n` +
        `/pause - stop opening new positions for you\n` +
        `/resume - resume trading + reset your circuit breaker\n` +
        `/mode <paper|live> - switch your trading mode\n` +
        `/stop - close all your positions and pause\n` +
        `/closeall - close all your positions but keep trading (no pause)\n` +
        `/killswitch confirm - stop the ENTIRE deployment for all users\n` +
        `/buy <token> <amountBnb> - manual buy\n` +
        `/sell <token> <amount> - manual sell (needs exact token amount)\n` +
        `/close <token address or short address> - close one position, amount handled automatically\n` +
        `/settings - view all your current thresholds\n` +
        `/status - your mode, pause state, position count, all thresholds`
    );
  });

  // --- Wallet management ---

  bot.command('generatewallet', (ctx) => {
    const already = userWallets.hasWallet(ctx.from.id);
    const args = ctx.message.text.split(' ').filter(Boolean);
    if (already && args[1] !== 'confirm') {
      ctx.reply(
        `You already have a wallet (${userWallets.getWalletAddress(ctx.from.id)}).\n` +
          `Generating a new one replaces it — you'll lose access to the old wallet's funds unless you've already moved them out.\n` +
          `Run /generatewallet confirm to proceed anyway.`
      );
      return;
    }

    try {
      const wallet = userWallets.generateWallet(ctx.from.id, ctx.from.username);
      ctx.reply(SECURITY_NOTICE).then(() => {
        ctx
          .reply(
            `New wallet generated:\n\n` +
              `Address: ${wallet.address}\n\n` +
              `Private key: ${wallet.privateKey}\n\n` +
              `Seed phrase: ${wallet.mnemonic}\n\n` +
              `⚠️ Save these somewhere safe RIGHT NOW — this message will self-delete in 60 seconds and this is the only time you'll see the private key/seed phrase here. Fund this address with a small amount of BNB to start.`
          )
          .then((sentMsg) => {
            setTimeout(() => {
              ctx.deleteMessage(sentMsg.message_id).catch(() => {});
            }, 60000);
          });
      });
    } catch (err) {
      ctx.reply(`Failed to generate wallet: ${err.message}`);
    }
  });

  bot.command('importwallet', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    const secret = parts.slice(1).join(' ').trim();

    // Delete the incoming message immediately — it contains the secret.
    // Best-effort: works in private chats, may fail elsewhere, either way
    // we don't want to block on it.
    ctx.deleteMessage().catch(() => {});

    if (!secret) {
      ctx.reply('Usage: /importwallet <privateKey or seed phrase>\n(send this as a private DM to the bot)');
      return;
    }

    if (userWallets.hasWallet(ctx.from.id)) {
      ctx.reply(
        `You already have a wallet registered. Run /deletewallet confirm first if you want to replace it with a different one.`
      );
      return;
    }

    try {
      const wallet = userWallets.importWallet(ctx.from.id, ctx.from.username, secret);
      await ctx.reply(SECURITY_NOTICE);
      ctx.reply(`Wallet imported: ${wallet.address}`);
    } catch (err) {
      ctx.reply(`Failed to import wallet: ${err.message}`);
    }
  });

  bot.command('wallet', async (ctx) => {
    if (!userWallets.hasWallet(ctx.from.id)) {
      ctx.reply('No wallet registered yet. Use /generatewallet or /importwallet.');
      return;
    }
    try {
      const trader = getTraderForUser(ctx.from.id, provider);
      const balanceBnb = await trader.getWalletBalanceBnb();
      const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
      const usdStr = bnbUsdPrice ? ` (~$${(balanceBnb * bnbUsdPrice).toFixed(2)})` : '';
      ctx.reply(
        `Address: ${userWallets.getWalletAddress(ctx.from.id)}\nBalance: ${balanceBnb.toFixed(4)} BNB${usdStr}`
      );
    } catch (err) {
      ctx.reply(`Failed to fetch wallet info: ${err.message}`);
    }
  });

  bot.command('exportkey', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      ctx.reply(
        'This reveals your raw private key in this chat.\nRun /exportkey confirm to proceed — the reply will auto-delete after 60 seconds.'
      );
      return;
    }
    const privateKey = userWallets.exportPrivateKey(ctx.from.id);
    if (!privateKey) {
      ctx.reply('No wallet registered.');
      return;
    }
    ctx.reply(`Private key: ${privateKey}\n\n⚠️ This message self-deletes in 60 seconds.`).then((sentMsg) => {
      setTimeout(() => {
        ctx.deleteMessage(sentMsg.message_id).catch(() => {});
      }, 60000);
    });
  });

  bot.command('deletewallet', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      ctx.reply(
        'This permanently removes your stored wallet from this bot. Make sure you\'ve moved out any funds first — this does NOT sweep them for you.\nRun /deletewallet confirm to proceed.'
      );
      return;
    }
    userWallets.deleteWallet(ctx.from.id);
    ctx.reply('Wallet removed.');
  });

  // --- Settings ---

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
        const updated = userSettings.set(ctx.from.id, key, value);
        ctx.reply(`${label} set to ${updated}`);
      } catch (err) {
        ctx.reply(`Failed to update: ${err.message}`);
      }
    });
  }

  bot.command('settings', (ctx) => {
    ctx.reply(`Your settings:\n${formatSettings(userSettings.getAll(ctx.from.id))}`);
  });

  bot.command('status', (ctx) => {
    const s = userSettings.getAll(ctx.from.id);
    const hasWallet = userWallets.hasWallet(ctx.from.id);
    ctx.reply(
      `Wallet: ${hasWallet ? userWallets.getWalletAddress(ctx.from.id) : 'none registered'}\n` +
        `Mode: ${userBotState.getMode(ctx.from.id).toUpperCase()}${userBotState.isPaused(ctx.from.id) ? ' (PAUSED)' : ''}\n` +
        `Open positions: ${positionManager.countOpenPositions(ctx.from.id)} / ${s.maxPositions}\n\n` +
        `${formatSettings(s)}`
    );
  });

  // --- Stats / positions / history ---

  bot.command('stats', async (ctx) => {
    try {
      const s = stats.getStats(ctx.from.id);

      let balanceLine = 'Balance: no wallet registered';
      if (userWallets.hasWallet(ctx.from.id)) {
        const trader = getTraderForUser(ctx.from.id, provider);
        const balanceBnb = await trader.getWalletBalanceBnb();
        const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
        const usdStr = bnbUsdPrice ? ` (~$${(balanceBnb * bnbUsdPrice).toFixed(2)})` : '';
        balanceLine = `Balance: ${balanceBnb.toFixed(5)} BNB${usdStr}`;
      }

      const netAbs = Math.abs(s.netUsd);
      const netLine = s.netUsd >= 0 ? `+$${netAbs.toFixed(2)}` : `-$${netAbs.toFixed(2)}`;
      ctx.reply(
        `${balanceLine}\n\n` +
          `Trades closed: ${s.closedCount} (${s.wins}W / ${s.losses}L)\n` +
          `Open positions: ${s.openCount}\n\n` +
          `Total spent: ${formatUsd(s.spentUsd)}\n` +
          `Total made (winning trades): ${formatUsd(s.madeUsd)}\n` +
          `Total lost (losing trades): ${formatUsd(s.lostUsd)}\n` +
          `Net P&L: ${netLine}`
      );
    } catch (err) {
      ctx.reply(`Failed to load stats: ${err.message}`);
    }
  });

  bot.command('balance', async (ctx) => {
    if (!userWallets.hasWallet(ctx.from.id)) {
      ctx.reply('No wallet registered yet. Use /generatewallet or /importwallet.');
      return;
    }
    try {
      const trader = getTraderForUser(ctx.from.id, provider);
      const balanceBnb = await trader.getWalletBalanceBnb();
      const bnbUsdPrice = await priceFeed.getBnbUsdPrice().catch(() => null);
      const usdStr = bnbUsdPrice ? ` (~$${(balanceBnb * bnbUsdPrice).toFixed(2)})` : '';
      ctx.reply(`Wallet balance: ${balanceBnb.toFixed(4)} BNB${usdStr}`);
    } catch (err) {
      ctx.reply(`Failed to fetch balance: ${err.message}`);
    }
  });

  bot.command('positions', async (ctx) => {
    const rows = positionManager.getOpenPositions(ctx.from.id);
    if (rows.length === 0) {
      ctx.reply('No open positions.');
      return;
    }

    // Fetched one at a time on purpose — firing all of these in parallel
    // (Promise.all) sends a burst of dozens of RPC calls at once against a
    // free public endpoint, which gets rate-limited and makes every result
    // come back as a failure. Sequential is slower but actually works.
    const lines = [];
    for (const p of rows) {
      let currentMc = null;
      try {
        if (p.source === 'fourmeme') {
          const info = await fourMemeTrader.getFourMemeTokenInfo(p.token_address, provider);
          if (!info.liquidityAdded) {
            // Still bonding-curve — market cap isn't reliably computable
            // this way (see safetyChecks.js), so leave it as n/a rather
            // than showing a misleading $0.
            currentMc = null;
          }
          // If it graduated since we bought, fall through to n/a too —
          // the PancakeSwap graduation listener would pick it up as its
          // own separate position rather than updating this one.
        } else {
          const data = await getLiquidityAndMarketCapUsd(p.token_address, provider);
          currentMc = data.marketCapUsd;
        }
      } catch {
        // Leave as null — shown as n/a below.
      }

      let pnlPct = null;
      let pnlUsd = null;
      if (p.opened_market_cap_usd && currentMc) {
        pnlPct = ((currentMc - p.opened_market_cap_usd) / p.opened_market_cap_usd) * 100;
        if (p.entry_amount_usd) pnlUsd = p.entry_amount_usd * (pnlPct / 100);
      }

      const emoji = pnlPct !== null ? pnlEmoji(pnlPct) : '⚪';
      const label = `${shortAddr(p.token_address)} (${p.source || 'token'})`;
      const pnlLine = pnlPct !== null ? `PnL: ${formatUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)` : 'PnL: n/a';
      const mcLine = `Opened MC: ${formatMc(p.opened_market_cap_usd)} | Current MC: ${currentMc !== null ? formatMc(currentMc) : 'n/a'}`;

      lines.push(`${emoji} ${label} - ${p.mode} - size ${formatUsd(p.entry_amount_usd)}\n${pnlLine} | ${mcLine}`);
    }

    const maxPositions = userSettings.get(ctx.from.id, 'maxPositions');
    ctx.reply(`${lines.join('\n\n')}\n\n${rows.length}/${maxPositions} positions open`);
  });

  bot.command('history', (ctx) => {
    const rows = db
      .prepare(
        `SELECT * FROM positions WHERE chat_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 10`
      )
      .all(String(ctx.from.id));
    if (rows.length === 0) {
      ctx.reply('No closed trades yet.');
      return;
    }
    const lines = rows.map((p) => {
      const emoji = p.pnl_pct !== null && p.pnl_pct !== undefined ? pnlEmoji(p.pnl_pct) : '⚪';
      const label = `${shortAddr(p.token_address)} (${p.source || 'token'})`;
      const pnlLine =
        p.pnl_pct !== null && p.pnl_pct !== undefined
          ? `PnL ${formatUsd(p.pnl_usd)} (${p.pnl_pct.toFixed(1)}%)`
          : 'PnL n/a';
      return (
        `${emoji} ${closeReasonLabel(p.close_reason || 'manual')}\n` +
        `${label}\n` +
        `${pnlLine}\n` +
        `Opened Market Cap: ${formatMc(p.opened_market_cap_usd)}\n` +
        `Closed Market Cap: ${formatMc(p.closed_market_cap_usd)}`
      );
    });

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN pnl_usd >= 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses
         FROM positions WHERE chat_id = ? AND status = 'closed'`
      )
      .get(String(ctx.from.id));

    ctx.reply(`${lines.join('\n\n')}\n\nOverall: ${totals.wins || 0}W / ${totals.losses || 0}L of ${totals.total} trades`);
  });

  bot.command('clearhistory', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      const closedCount = db
        .prepare(`SELECT COUNT(*) as c FROM positions WHERE chat_id = ? AND status = 'closed'`)
        .get(String(ctx.from.id)).c;
      ctx.reply(
        `⚠️ This permanently deletes all ${closedCount} closed trade record(s) and resets your win/loss stats ` +
          `to zero. Open positions are not affected. This cannot be undone. Reply "/clearhistory confirm" to proceed.`
      );
      return;
    }
    stats.clearHistory(ctx.from.id);
    ctx.reply('Trade history and stats wiped.');
  });

  // --- Pause / resume / mode ---

  bot.command('pause', (ctx) => {
    userBotState.pause(ctx.from.id);
    ctx.reply('Paused — no new positions will be opened for you. Existing positions are untouched.');
  });

  bot.command('resume', (ctx) => {
    userBotState.resume(ctx.from.id);
    ctx.reply('Resumed — trading active again, circuit breaker reset.');
  });

  bot.command('mode', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newMode = parts[1]?.toLowerCase();
    if (!newMode) {
      ctx.reply(`Current mode: ${userBotState.getMode(ctx.from.id).toUpperCase()}\nUsage: /mode <paper|live>`);
      return;
    }
    try {
      const mode = userBotState.setMode(ctx.from.id, newMode, userWallets.hasWallet(ctx.from.id));
      ctx.reply(`Mode switched to ${mode.toUpperCase()}.`);
    } catch (err) {
      ctx.reply(`Failed to switch mode: ${err.message}`);
    }
  });

  // --- Stop / closeall ---

  bot.command('stop', async (ctx) => {
    ctx.reply('Closing all your open positions and pausing...');
    const trader = getTraderForUser(ctx.from.id, provider);
    const { closed, failed } = await positionManager.closeAllPositions(ctx.from.id, trader, 'stop_command');
    userBotState.pause(ctx.from.id);
    ctx.reply(
      `Closed ${closed.length} position(s).${failed.length ? ` Failed: ${failed.length}.` : ''}\nPaused.`
    );
  });

  bot.command('closeall', async (ctx) => {
    ctx.reply('Closing all your open positions (trading stays active)...');
    const trader = getTraderForUser(ctx.from.id, provider);
    const { closed, failed } = await positionManager.closeAllPositions(ctx.from.id, trader, 'closeall_command');
    ctx.reply(
      `Closed ${closed.length} position(s).${failed.length ? ` Failed: ${failed.length}.` : ''}\nStill trading.`
    );
  });

  // --- Manual buy/sell ---

  bot.command('buy', async (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const [, tokenAddress, amountStr] = parts;
    if (!tokenAddress || !amountStr) {
      ctx.reply('Usage: /buy <tokenAddress> <amountBnb>');
      return;
    }
    try {
      const trader = getTraderForUser(ctx.from.id, provider);
      const position = await positionManager.openPosition(ctx.from.id, trader, tokenAddress, parseFloat(amountStr));
      ctx.reply(`Buy submitted for ${tokenAddress}. Position id: ${position.id}`);
    } catch (err) {
      logger.error('Manual buy failed', { chatId: String(ctx.from.id), error: err.message });
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
      const trader = getTraderForUser(ctx.from.id, provider);
      await positionManager.closePosition(ctx.from.id, trader, tokenAddress, BigInt(amountStr));
      ctx.reply(`Sell submitted for ${tokenAddress}.`);
    } catch (err) {
      logger.error('Manual sell failed', { chatId: String(ctx.from.id), error: err.message });
      ctx.reply(`Sell failed: ${err.message}`);
    }
  });

  bot.command('close', async (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const identifier = parts[1];
    if (!identifier) {
      ctx.reply('Usage: /close <token address or short address like 0x12345678>\nSee /positions for the address to use.');
      return;
    }

    const open = positionManager.getOpenPositions(ctx.from.id);
    const needle = identifier.toLowerCase();
    const matches = open.filter(
      (p) => p.token_address.toLowerCase() === needle || p.token_address.toLowerCase().startsWith(needle)
    );

    if (matches.length === 0) {
      ctx.reply(`No open position matching "${identifier}". Check /positions for the correct address.`);
      return;
    }
    if (matches.length > 1) {
      ctx.reply(
        `"${identifier}" matches more than one open position — be more specific:\n` +
          matches.map((p) => shortAddr(p.token_address)).join('\n')
      );
      return;
    }

    const position = matches[0];
    const label = `${shortAddr(position.token_address)} (${position.source || 'token'})`;

    try {
      const trader = getTraderForUser(ctx.from.id, provider);
      const result = await positionManager.closePosition(ctx.from.id, trader, position.token_address, undefined, 'manual');
      const pnlLine =
        result && result.pnlPct !== null && result.pnlPct !== undefined
          ? `\n${pnlEmoji(result.pnlPct)} PnL ${formatUsd(result.pnlUsd)} (${result.pnlPct.toFixed(1)}%)`
          : '';
      ctx.reply(`Closed ${label}.${pnlLine}`);
    } catch (err) {
      logger.error('Manual close failed', { chatId: String(ctx.from.id), error: err.message });
      ctx.reply(`Close failed: ${err.message}`);
    }
  });

  bot.command('killswitch', (ctx) => {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts[1] !== 'confirm') {
      ctx.reply(
        'This stops the ENTIRE deployment for ALL users, not just you — open positions for everyone are left as-is.\n' +
          'Run /killswitch confirm to proceed.'
      );
      return;
    }
    botState.kill();
    ctx.reply('Kill switch activated. Shutting down the whole deployment now.').finally(() => {
      logger.warn('Process exiting due to /killswitch', { triggeredBy: String(ctx.from.id) });
      // NOTE: if Railway's restart policy is set to ON_FAILURE with retries
      // remaining, it may restart the container — the persisted "killed"
      // flag in bot_state makes the bot exit again immediately on boot
      // rather than resume trading. To fully stop the deployment, also
      // stop/remove the service in the Railway dashboard.
      process.exit(0);
    });
  });

  bot.catch((err) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

function notifyUser(bot, chatId, message) {
  bot.telegram.sendMessage(chatId, message).catch((err) => {
    logger.error('Failed to notify user', { chatId: String(chatId), error: err.message });
  });
}

module.exports = { createBot, notifyUser };
