const db = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Mirrors the command set from the Solana pumpfun sniper for parity.
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

const insertIfMissing = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(DEFAULTS)) {
  insertIfMissing.run(key, String(value));
}

const getStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

function get(key) {
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key];
  const raw = row.value;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

function set(key, value) {
  if (!(key in DEFAULTS)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  setStmt.run(key, String(value));
  logger.info('Setting updated', { key, value });
  return get(key);
}

function getAll() {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, get(k)]));
}

module.exports = { get, set, getAll, DEFAULTS };
