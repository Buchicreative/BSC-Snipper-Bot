const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    source TEXT NOT NULL,           -- 'four_meme' | 'pancake_graduation'
    name TEXT,
    symbol TEXT,
    discovered_at INTEGER NOT NULL,
    safety_passed INTEGER DEFAULT 0,
    safety_report TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    mode TEXT NOT NULL,             -- 'paper' | 'live'
    status TEXT NOT NULL,           -- 'open' | 'closed'
    entry_price_bnb REAL,
    entry_amount_bnb REAL,
    entry_tx_hash TEXT,
    exit_price_bnb REAL,
    exit_tx_hash TEXT,
    take_profit_pct REAL,
    stop_loss_pct REAL,
    opened_at INTEGER,
    closed_at INTEGER,
    pnl_bnb REAL,
    pnl_pct REAL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
  );
`);

logger.info('Database ready', { path: config.db.path });

module.exports = db;
