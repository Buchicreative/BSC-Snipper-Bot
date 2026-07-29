const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Listens for new token creation events on four.meme's factory contract.
 *
 * NOTE: four.meme's factory ABI/address must be filled in once confirmed —
 * they don't publish a stable official ABI, so this should be reverse-engineered
 * from a known creation tx on BscScan before going live. Placeholder event
 * signature below is a common pattern for bonding-curve launch factories;
 * verify against an actual four.meme creation transaction.
 */

const FOUR_MEME_FACTORY_ABI = [
  // Placeholder — replace with the verified four.meme factory ABI fragment.
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 timestamp)',
];

function startFourMemeListener({ onTokenCreated }) {
  if (!config.contracts.fourMemeFactory) {
    logger.warn('FOUR_MEME_FACTORY_ADDRESS not set — four.meme listener disabled until configured');
    return { stop: () => {} };
  }

  const provider = new ethers.WebSocketProvider(config.rpc.wss);
  const factory = new ethers.Contract(
    config.contracts.fourMemeFactory,
    FOUR_MEME_FACTORY_ABI,
    provider
  );

  logger.info('four.meme listener starting', { factory: config.contracts.fourMemeFactory });

  const handler = (token, creator, name, symbol, timestamp, event) => {
    logger.info('four.meme: new token detected', { token, name, symbol });
    onTokenCreated({
      source: 'four_meme',
      address: token,
      creator,
      name,
      symbol,
      discoveredAt: Date.now(),
      txHash: event?.log?.transactionHash,
    });
  };

  factory.on('TokenCreated', handler);

  return {
    stop: () => {
      factory.off('TokenCreated', handler);
      provider.destroy();
    },
  };
}

module.exports = { startFourMemeListener };
