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
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || null,
  },

  rpc: {
    http: process.env.BSC_RPC_HTTP || 'https://bsc-dataseed.binance.org',
    wss: process.env.BSC_RPC_WSS || 'wss://bsc-ws-node.nariox.org:443',
  },

  wallet: {
    privateKey: process.env.WALLET_PRIVATE_KEY || null, // required only for live mode
  },

  contracts: {
    fourMemeFactory: process.env.FOUR_MEME_FACTORY_ADDRESS || null,
    pancakeFactory: process.env.PANCAKESWAP_V2_FACTORY || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    pancakeRouter: process.env.PANCAKESWAP_V2_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    wbnb: process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },

  trading: {
    // Initial mode on first-ever boot only — after that, botState.js persists
    // the live value in the DB so /mode can switch it without a restart.
    mode: (process.env.TRADING_MODE || 'paper').toLowerCase(), // 'paper' | 'live'
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '5'),
    // Everything else (trade size, gas reserve, max positions, liquidity/market
    // cap bounds, holder %, TP/SL, slippage) is runtime-adjustable via Telegram
    // and lives in src/utils/settings.js, seeded with its own defaults there.
  },

  db: {
    path: process.env.DB_PATH || './data/bot.db',
  },
};
