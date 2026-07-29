const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  if (!config.walletEncryptionKey) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add it to your env vars.'
    );
  }
  const key = Buffer.from(config.walletEncryptionKey, 'hex');
  if (key.length !== 32) {
    throw new Error('WALLET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

/**
 * Encrypts a string (a private key) with AES-256-GCM. Returns a single
 * string encoding iv:authTag:ciphertext (all hex), safe to store as-is in
 * a DB column.
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Reverses encrypt(). Throws if the payload is malformed or the key/authTag
 * don't match (tampering or wrong encryption key).
 */
function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted payload');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
