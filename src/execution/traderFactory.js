const { Trader } = require('./trader');
const userWallets = require('../utils/userWallets');
const userBotState = require('../utils/userBotState');

/**
 * Builds a Trader for a specific user: their decrypted wallet (or null if
 * they haven't registered one — fine for paper mode, will throw on any
 * live buy/sell attempt) and their current mode.
 */
function getTraderForUser(chatId, provider) {
  const wallet = userWallets.getWallet(chatId, provider);
  const mode = userBotState.getMode(chatId);
  return new Trader(provider, wallet, mode);
}

module.exports = { getTraderForUser };
