// Deployment-level state only — killswitch. Per-user mode/pause/circuit
// breaker moved to userBotState.js since every user trades independently
// with their own wallet and settings now.
const db = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const insertIfMissing = db.prepare(`INSERT OR IGNORE INTO bot_state (key, value) VALUES (?, ?)`);
insertIfMissing.run('killed', '0');

const getStmt = db.prepare(`SELECT value FROM bot_state WHERE key = ?`);
const setStmt = db.prepare(
  `INSERT INTO bot_state (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

function isKilled() {
  const row = getStmt.get('killed');
  return (row ? row.value : '0') === '1';
}

function kill() {
  setStmt.run('killed', '1');
  logger.warn('KILL SWITCH activated — deployment-wide, affects all users');
}

module.exports = { isKilled, kill };
