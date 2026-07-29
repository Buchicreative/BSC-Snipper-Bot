const db = require('./db');
const config = require('../config');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const DEFAULTS = {
  paused: '0',
  killed: '0',
  mode: config.trading.mode, // 'paper' | 'live'
  consecutiveFailures: '0',
};

const CIRCUIT_BREAKER_THRESHOLD = 5;

const insertIfMissing = db.prepare(`INSERT OR IGNORE INTO bot_state (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(DEFAULTS)) {
  insertIfMissing.run(key, value);
}

const getStmt = db.prepare(`SELECT value FROM bot_state WHERE key = ?`);
const setStmt = db.prepare(
  `INSERT INTO bot_state (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

function getRaw(key) {
  const row = getStmt.get(key);
  return row ? row.value : DEFAULTS[key];
}

function setRaw(key, value) {
  setStmt.run(key, String(value));
}

function isPaused() {
  return getRaw('paused') === '1';
}

function pause() {
  setRaw('paused', '1');
  logger.warn('Bot paused — no new positions will be opened');
}

function resume() {
  setRaw('paused', '0');
  setRaw('consecutiveFailures', '0');
  logger.info('Bot resumed, circuit breaker reset');
}

function isKilled() {
  return getRaw('killed') === '1';
}

function kill() {
  setRaw('killed', '1');
  setRaw('paused', '1');
  logger.warn('KILL SWITCH activated');
}

function getMode() {
  return getRaw('mode');
}

function setMode(mode) {
  if (!['paper', 'live'].includes(mode)) {
    throw new Error(`Invalid mode "${mode}" — must be "paper" or "live"`);
  }
  if (mode === 'live' && !config.wallet.privateKey) {
    throw new Error('Cannot switch to live mode: WALLET_PRIVATE_KEY is not set');
  }
  setRaw('mode', mode);
  logger.warn(`Trading mode switched to ${mode.toUpperCase()}`);
  return mode;
}

function recordFailure() {
  const current = parseInt(getRaw('consecutiveFailures'), 10) || 0;
  const next = current + 1;
  setRaw('consecutiveFailures', String(next));
  if (next >= CIRCUIT_BREAKER_THRESHOLD && !isPaused()) {
    pause();
    logger.error('Circuit breaker tripped — bot auto-paused after repeated failures', {
      consecutiveFailures: next,
    });
  }
  return next;
}

function recordSuccess() {
  setRaw('consecutiveFailures', '0');
}

function getConsecutiveFailures() {
  return parseInt(getRaw('consecutiveFailures'), 10) || 0;
}

module.exports = {
  isPaused,
  pause,
  resume,
  isKilled,
  kill,
  getMode,
  setMode,
  recordFailure,
  recordSuccess,
  getConsecutiveFailures,
  CIRCUIT_BREAKER_THRESHOLD,
};
