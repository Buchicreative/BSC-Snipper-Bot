const { ethers } = require('ethers');
const db = require('./db');
const cryptoUtil = require('./crypto');
const config = require('../config');
const logger = require('./logger');

function isAllowlisted(chatId) {
  return config.allowedTelegramUserIds.includes(String(chatId));
}

function hasWallet(chatId) {
  const row = db.prepare('SELECT chat_id FROM users WHERE chat_id = ?').get(String(chatId));
  return Boolean(row);
}

function getWalletAddress(chatId) {
  const row = db.prepare('SELECT wallet_address FROM users WHERE chat_id = ?').get(String(chatId));
  return row ? row.wallet_address : null;
}

function _store(chatId, telegramUsername, wallet) {
  const encryptedKey = cryptoUtil.encrypt(wallet.privateKey);
  db.prepare(
    `INSERT INTO users (chat_id, telegram_username, wallet_address, encrypted_private_key, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       wallet_address = excluded.wallet_address,
       encrypted_private_key = excluded.encrypted_private_key`
  ).run(String(chatId), telegramUsername || null, wallet.address, encryptedKey, Date.now());
  logger.info('Wallet stored for user', { chatId: String(chatId), address: wallet.address });
}

/**
 * Generates a brand new random wallet for a user. Returns the full wallet
 * details (address, private key, mnemonic) ONCE — callers must show this to
 * the user immediately and never log or persist the plaintext key anywhere
 * beyond the encrypted DB column written here.
 */
function generateWallet(chatId, telegramUsername) {
  const wallet = ethers.Wallet.createRandom();
  _store(chatId, telegramUsername, wallet);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase || null,
  };
}

/**
 * Imports a wallet from either a raw private key (0x-prefixed 64 hex chars)
 * or a BIP-39 mnemonic seed phrase (space-separated words). Detects which
 * based on the input shape. Throws on invalid input.
 */
function importWallet(chatId, telegramUsername, secret) {
  const trimmed = secret.trim();
  let wallet;

  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    wallet = new ethers.Wallet(normalized);
  } else if (trimmed.split(/\s+/).length >= 12) {
    wallet = ethers.Wallet.fromPhrase(trimmed);
  } else {
    throw new Error('Not a recognizable private key (64 hex chars) or seed phrase (12+ words)');
  }

  _store(chatId, telegramUsername, wallet);
  return { address: wallet.address };
}

/**
 * Returns an ethers.Wallet connected to the given provider, ready to sign
 * transactions — or null if the user has no wallet registered. Decrypts
 * just-in-time on every call rather than caching the decrypted key in
 * memory long-term.
 */
function getWallet(chatId, provider) {
  const row = db
    .prepare('SELECT encrypted_private_key FROM users WHERE chat_id = ?')
    .get(String(chatId));
  if (!row) return null;
  const privateKey = cryptoUtil.decrypt(row.encrypted_private_key);
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Decrypts and returns the raw private key for /exportkey. Use sparingly —
 * only in response to an explicit, confirmed user request.
 */
function exportPrivateKey(chatId) {
  const row = db
    .prepare('SELECT encrypted_private_key FROM users WHERE chat_id = ?')
    .get(String(chatId));
  if (!row) return null;
  return cryptoUtil.decrypt(row.encrypted_private_key);
}

function deleteWallet(chatId) {
  db.prepare('DELETE FROM users WHERE chat_id = ?').run(String(chatId));
  logger.info('Wallet deleted for user', { chatId: String(chatId) });
}

module.exports = {
  isAllowlisted,
  hasWallet,
  getWalletAddress,
  generateWallet,
  importWallet,
  getWallet,
  exportPrivateKey,
  deleteWallet,
};
