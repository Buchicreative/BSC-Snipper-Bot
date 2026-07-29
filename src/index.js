const { ethers } = require('ethers');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./utils/db');
const settings = require('./utils/settings');
const botState = require('./utils/botState');
const priceFeed = require('./utils/priceFeed');

const { startFourMemeListener } = require('./listeners/fourMemeListener');
const { startPancakeGraduationListener } = require('./listeners/pancakeGraduationListener');
const { runSafetyChecks } = require('./filters/safetyChecks');
const { Trader } = require('./execution/trader');
const { PositionManager } = require('./risk/positionManager');
const { createBot, notifyAdmin } = require('./telegram/bot');

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

async function main() {
  // Kill switch persists across restarts on purpose — if it was tripped
  // before a crash/redeploy, stay dead until someone clears it manually
  // (see README: clearing the kill switch requires a DB reset).
  if (botState.isKilled()) {
    logger.error('Bot is in KILLED state from a previous /killswitch — exiting without starting.');
    process.exit(0);
  }

  logger.info('Starting BSC pumpfun-style sniper bot', { mode: botState.getMode() });

  const httpProvider = new ethers.JsonRpcProvider(config.rpc.http);
  const trader = new Trader(httpProvider);
  const positionManager = new PositionManager(trader);
  const bot = createBot({ positionManager });

  async function attemptAutoBuy(candidate) {
    if (botState.isPaused()) {
      logger.info('Skipping candidate — bot is paused', { address: candidate.address });
      return;
    }

    if (positionManager.isAtMaxPositions()) {
      const msg = `Did not open position on ${candidate.address} — at max positions (${settings.get('maxPositions')}). Raise the limit with /setmaxpositions.`;
      logger.warn(msg);
      notifyAdmin(bot, `⚠️ ${msg}`);
      return;
    }

    const tradeSizeUsd = settings.get('tradeSizeUsd');
    let tradeSizeBnb;
    try {
      tradeSizeBnb = await priceFeed.usdToBnb(tradeSizeUsd);
    } catch (err) {
      logger.error('Could not fetch BNB/USD price, skipping buy', { error: err.message });
      return;
    }

    // Gas reserve check only applies meaningfully in live mode against the
    // real wallet balance — paper mode has nothing to protect.
    if (trader.mode === 'live') {
      const balanceBnb = await trader.getWalletBalanceBnb();
      const gasReserveBnb = await priceFeed.usdToBnb(settings.get('gasReserveUsd'));
      if (balanceBnb - tradeSizeBnb < gasReserveBnb) {
        const msg = `Did not open position on ${candidate.address} — buying would dip below the $${settings.get('gasReserveUsd')} gas reserve.`;
        logger.warn(msg);
        notifyAdmin(bot, `⚠️ ${msg}`);
        return;
      }
    }

    try {
      await positionManager.openPosition(candidate.address, tradeSizeBnb);
      botState.recordSuccess();
      notifyAdmin(
        bot,
        `✅ Opened position on ${candidate.address} (${candidate.source}) — $${tradeSizeUsd} / ${tradeSizeBnb.toFixed(5)} BNB [${trader.mode.toUpperCase()}]`
      );
    } catch (err) {
      logger.error('Auto-buy failed', { address: candidate.address, error: err.message });
      const failures = botState.recordFailure();
      notifyAdmin(
        bot,
        `❌ Buy failed on ${candidate.address}: ${err.message}\nConsecutive failures: ${failures}/${botState.CIRCUIT_BREAKER_THRESHOLD}`
      );
    }
  }

  async function handleCandidateToken(candidate) {
    db.prepare(
      `INSERT OR IGNORE INTO events (type, payload, created_at) VALUES (?, ?, ?)`
    ).run('token_discovered', JSON.stringify(candidate), Date.now());

    const { passed, report, reasons } = await runSafetyChecks(candidate.address, httpProvider);

    db.prepare(
      `INSERT OR REPLACE INTO tokens (address, source, name, symbol, discovered_at, safety_passed, safety_report)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidate.address,
      candidate.source,
      candidate.name || null,
      candidate.symbol || null,
      candidate.discoveredAt,
      passed ? 1 : 0,
      JSON.stringify({ report, reasons })
    );

    if (!passed) {
      logger.info('Token failed safety checks, skipping', { address: candidate.address, reasons });
      return;
    }

    await attemptAutoBuy(candidate);
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
    // Clears any stale webhook/session state before polling starts —
    // harmless no-op for a bot that's never used a webhook, but cheap
    // insurance against leftover state from a previous run.
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
