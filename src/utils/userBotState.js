const db = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_bot_state (
    chat_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (chat_id, key)
  );
`);

const CIRCUIT_BREAKER_THRESHOLD = 5;

const getStmt = db.prepare('SELECT value FROM user_bot_state WHERE chat_id = ? AND key = ?');
const setStmt = db.prepare(
  `INSERT INTO user_bot_state (chat_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value`
);

function getRaw(chatId, key, fallback) {
  const row = getStmt.get(String(chatId), key);
  return row ? row.value : fallback;
}

function setRaw(chatId, key, value) {
  setStmt.run(String(chatId), key, String(value));
}

function isPaused(chatId) {
  return getRaw(chatId, 'paused', '0') === '1';
}

function pause(chatId) {
  setRaw(chatId, 'paused', '1');
  logger.warn('User paused — no new positions for this user', { chatId: String(chatId) });
}

function resume(chatId) {
  setRaw(chatId, 'paused', '0');
  setRaw(chatId, 'consecutiveFailures', '0');
  logger.info('User resumed, circuit breaker reset', { chatId: String(chatId) });
}

function getMode(chatId) {
  return getRaw(chatId, 'mode', 'paper');
}

function setMode(chatId, mode, hasWallet) {
  if (!['paper', 'live'].includes(mode)) {
    throw new Error(`Invalid mode "${mode}" — must be "paper" or "live"`);
  }
  if (mode === 'live' && !hasWallet) {
    throw new Error('Cannot switch to live mode: no wallet registered. Use /generatewallet or /importwallet first.');
  }
  setRaw(chatId, 'mode', mode);
  logger.warn('User trading mode switched', { chatId: String(chatId), mode });
  return mode;
}

function recordFailure(chatId) {
  const current = parseInt(getRaw(chatId, 'consecutiveFailures', '0'), 10) || 0;
  const next = current + 1;
  setRaw(chatId, 'consecutiveFailures', String(next));
  if (next >= CIRCUIT_BREAKER_THRESHOLD && !isPaused(chatId)) {
    pause(chatId);
    logger.error('Circuit breaker tripped — user auto-paused after repeated failures', {
      chatId: String(chatId),
      consecutiveFailures: next,
    });
  }
  return next;
}

function recordSuccess(chatId) {
  setRaw(chatId, 'consecutiveFailures', '0');
}

function getConsecutiveFailures(chatId) {
  return parseInt(getRaw(chatId, 'consecutiveFailures', '0'), 10) || 0;
}

module.exports = {
  isPaused,
  pause,
  resume,
  getMode,
  setMode,
  recordFailure,
  recordSuccess,
  getConsecutiveFailures,
  CIRCUIT_BREAKER_THRESHOLD,
};
