const { ethers } = require('ethers');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./utils/db');
const userSettings = require('./utils/userSettings');
const userBotState = require('./utils/userBotState');
const userWallets = require('./utils/userWallets');
const botState = require('./utils/botState');
const priceFeed = require('./utils/priceFeed');

const { startFourMemeListener } = require('./listeners/fourMemeListener');
const { startPancakeGraduationListener } = require('./listeners/pancakeGraduationListener');
const { gatherTokenData, evaluateForUser } = require('./filters/safetyChecks');
const { getTraderForUser } = require('./execution/traderFactory');
const positionManager = require('./risk/positionManager');
const { createBot, notifyUser } = require('./telegram/bot');

// Defense in depth: log and keep running rather than crash on something
// unexpected slipping past a try/catch somewhere. The WSS reconnect fix
// (resilientWsProvider.js) addresses the specific bug that caused an actual
// crash before this was added, but this net stays regardless — a single
// unexpected error anywhere shouldn't take down open positions' tracking.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — bot continues running', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection — bot continues running', {
    reason: reason instanceof Error ? reason.message : reason,
  });
});

function getAllRegisteredUsers() {
  return db.prepare('SELECT chat_id FROM users').all().map((row) => row.chat_id);
}

async function main() {
  // Kill switch persists across restarts on purpose, and is deployment-wide
  // (affects every user) — if it was tripped before a crash/redeploy, stay
  // dead until someone clears it manually (see README).
  if (botState.isKilled()) {
    logger.error('Bot is in KILLED state from a previous /killswitch — exiting without starting.');
    process.exit(0);
  }

  logger.info('Starting BSC pumpfun-style sniper bot (multi-user)');

  const httpProvider = new ethers.JsonRpcProvider(config.rpc.http);
  const bot = createBot({ provider: httpProvider });

  /**
   * Attempts an auto-buy for ONE registered user against one candidate
   * token, using that user's own thresholds, wallet, and mode. Called once
   * per registered user per candidate — see handleCandidateToken below.
   */
  async function attemptAutoBuyForUser(chatId, candidate, tokenData) {
    if (userBotState.isPaused(chatId)) {
      return;
    }

    const evaluation = evaluateForUser(tokenData, userSettings.getAll(chatId));
    if (!evaluation.passed) {
      return;
    }

    if (positionManager.isAtMaxPositions(chatId)) {
      const maxPositions = userSettings.get(chatId, 'maxPositions');
      notifyUser(
        bot,
        chatId,
        `⚠️ Did not open position on ${candidate.address} — at max positions (${maxPositions}). Raise the limit with /setmaxpositions.`
      );
      return;
    }

    const tradeSizeUsd = userSettings.get(chatId, 'tradeSizeUsd');
    let tradeSizeBnb;
    try {
      tradeSizeBnb = await priceFeed.usdToBnb(tradeSizeUsd);
    } catch (err) {
      logger.error('Could not fetch BNB/USD price, skipping buy', { chatId, error: err.message });
      return;
    }

    const trader = getTraderForUser(chatId, httpProvider);

    // Gas reserve check only applies meaningfully in live mode against the
    // real wallet balance — paper mode has nothing to protect.
    if (trader.mode === 'live') {
      if (!trader.wallet) {
        notifyUser(bot, chatId, `⚠️ Mode is set to live but no wallet is registered. Use /generatewallet or /importwallet.`);
        return;
      }
      const balanceBnb = await trader.getWalletBalanceBnb();
      const gasReserveUsd = userSettings.get(chatId, 'gasReserveUsd');
      const gasReserveBnb = await priceFeed.usdToBnb(gasReserveUsd);
      if (balanceBnb - tradeSizeBnb < gasReserveBnb) {
        notifyUser(
          bot,
          chatId,
          `⚠️ Did not open position on ${candidate.address} — buying would dip below your $${gasReserveUsd} gas reserve.`
        );
        return;
      }
    }

    try {
      await positionManager.openPosition(chatId, trader, candidate.address, tradeSizeBnb);
      userBotState.recordSuccess(chatId);
      notifyUser(
        bot,
        chatId,
        `✅ Opened position on ${candidate.address} (${candidate.source}) — $${tradeSizeUsd} / ${tradeSizeBnb.toFixed(5)} BNB [${trader.mode.toUpperCase()}]`
      );
    } catch (err) {
      logger.error('Auto-buy failed', { chatId, address: candidate.address, error: err.message });
      const failures = userBotState.recordFailure(chatId);
      notifyUser(
        bot,
        chatId,
        `❌ Buy failed on ${candidate.address}: ${err.message}\nConsecutive failures: ${failures}/${userBotState.CIRCUIT_BREAKER_THRESHOLD}`
      );
    }
  }

  /**
   * Called once per discovered candidate token. Safety data is gathered
   * ONCE here (expensive: RPC + external API calls), then evaluated
   * independently against every registered user's own thresholds — so
   * adding more users doesn't multiply the expensive part of this work.
   */
  async function handleCandidateToken(candidate) {
    db.prepare(
      `INSERT OR IGNORE INTO events (type, payload, created_at) VALUES (?, ?, ?)`
    ).run('token_discovered', JSON.stringify(candidate), Date.now());

    const tokenData = await gatherTokenData(candidate.address, httpProvider);

    db.prepare(
      `INSERT OR REPLACE INTO tokens (address, source, name, symbol, discovered_at, safety_report)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.address,
      candidate.source,
      candidate.name || null,
      candidate.symbol || null,
      candidate.discoveredAt,
      JSON.stringify(tokenData)
    );

    const chatIds = getAllRegisteredUsers();
    for (const chatId of chatIds) {
      await attemptAutoBuyForUser(chatId, candidate, tokenData);
    }
  }

  const fourMeme = startFourMemeListener({ onTokenCreated: handleCandidateToken });
  const graduation = startPancakeGraduationListener({ onPairCreated: handleCandidateToken });

  await launchBotWithRetry(bot);

  process.once('SIGINT', () => shutdown({ bot, fourMeme, graduation }));
  process.once('SIGTERM', () => shutdown({ bot, fourMeme, graduation }));
}

/**
 * Launches the Telegram bot's long-polling loop, retrying with backoff on
 * failure. This specifically covers the 409 Conflict Telegram returns when
 * another poller for the same bot token is still active — which reliably
 * happens for a few seconds during a Railway redeploy, when the old
 * container hasn't fully exited before the new one starts polling. Without
 * a retry here, that single transient 409 kills the polling loop
 * permanently: the bot process keeps running (looks "Active" in Railway),
 * but silently stops responding to any Telegram messages from then on.
 */
async function launchBotWithRetry(bot, attempt = 1) {
  const maxDelayMs = 30000;
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    logger.info('Telegram bot launched');
  } catch (err) {
    const delayMs = Math.min(2000 * attempt, maxDelayMs);
    logger.error('Telegram bot launch failed, retrying', {
      attempt,
      delayMs,
      error: err.message,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return launchBotWithRetry(bot, attempt + 1);
  }
}

function shutdown({ bot, fourMeme, graduation }) {
  logger.info('Shutting down...');
  bot.stop('SIGTERM');
  fourMeme.stop();
  graduation.stop();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal error on startup', { error: err.message, stack: err.stack });
  process.exit(1);
});
