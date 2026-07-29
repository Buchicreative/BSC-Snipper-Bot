const db = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    chat_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (chat_id, key)
  );
`);

// Every user gets their own independent copy of these, seeded on first use.
const DEFAULTS = {
  tradeSizeUsd: 20,        // /setsize — $ per trade
  gasReserveUsd: 10,       // /setgasreserve — $ always kept untouched as gas buffer
  maxPositions: 3,         // /setmaxpositions — max simultaneous open positions
  minLiquidityUsd: 1000,   // /setminliquidity — minimum pool liquidity to buy
  maxMarketCapUsd: 0,      // /setmaxmarketcap — skip tokens valued above this (0 = no cap)
  minMarketCapUsd: 0,      // /setminmarketcap — skip tokens valued below this (0 = no floor)
  maxHolderPercent: 10,    // /setmaxholderpercent — max % one wallet can hold
  maxBuyTaxPct: 10,        // /setmaxbuytax — reject tokens with buy tax above this
  maxSellTaxPct: 10,       // /setmaxselltax — reject tokens with sell tax above this
  takeProfitPct: 100,      // /settakeprofit — gain % to auto-sell at
  stopLossPct: 30,         // /setstoploss — loss % to auto-sell at
  slippageBps: 300,        // execution slippage tolerance (basis points)
};

const getStmt = db.prepare('SELECT value FROM user_settings WHERE chat_id = ? AND key = ?');
const setStmt = db.prepare(
  `INSERT INTO user_settings (chat_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value`
);

function get(chatId, key) {
  const row = getStmt.get(String(chatId), key);
  if (!row) return DEFAULTS[key];
  const num = Number(row.value);
  return Number.isNaN(num) ? row.value : num;
}

function set(chatId, key, value) {
  if (!(key in DEFAULTS)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  setStmt.run(String(chatId), key, String(value));
  logger.info('User setting updated', { chatId: String(chatId), key, value });
  return get(chatId, key);
}

function getAll(chatId) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, get(chatId, k)]));
}

module.exports = { get, set, getAll, DEFAULTS };
