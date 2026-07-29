require('dotenv').config();

function required(name, fallback = undefined) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

module.exports = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
  },

  rpc: {
    http: process.env.BSC_RPC_HTTP || 'https://bsc-dataseed.binance.org',
    wss: process.env.BSC_RPC_WSS || 'wss://bsc-rpc.publicnode.com',
  },

  contracts: {
    fourMemeFactory: process.env.FOUR_MEME_FACTORY_ADDRESS || '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
    pancakeFactory: process.env.PANCAKESWAP_V2_FACTORY || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    pancakeRouter: process.env.PANCAKESWAP_V2_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    wbnb: process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },

  trading: {
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '5'),
    // Trading mode, trade size, gas reserve, max positions, liquidity/market
    // cap bounds, holder %, TP/SL, and slippage are ALL per-user now — see
    // src/utils/userSettings.js and src/utils/userBotState.js. Each Telegram
    // user who imports/generates a wallet gets their own independent copy
    // of every one of these, defaulting to paper mode.
  },

  db: {
    path: process.env.DB_PATH || './data/bot.db',
  },

  // Multi-user wallet support — required for /generatewallet, /importwallet,
  // and anything that touches a stored private key. A 64-char hex string
  // (32 bytes). Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Losing this key means every stored wallet becomes unrecoverable — back
  // it up somewhere other than just Railway's env vars.
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || null,

  // Comma-separated Telegram numeric user IDs allowed to import/generate a
  // wallet and trade. Get your own ID from @userinfobot on Telegram. Anyone
  // not on this list can still message the bot, but every command is
  // refused with a polite "not authorized" reply.
  allowedTelegramUserIds: (process.env.ALLOWED_TELEGRAM_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // Optional — powers the holder concentration check (top-holder %) via
  // Etherscan's unified V2 API (one key works across all EVM chains,
  // including BSC via chainid=56). Without this set, that one check is
  // skipped (soft failure) rather than blocking all trading.
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,
};
