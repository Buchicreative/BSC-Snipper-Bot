const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Listens for new pair creation on PancakeSwap V2 factory. This catches
 * tokens "graduating" from four.meme's bonding curve into real PancakeSwap
 * liquidity — a second, later entry point than the four.meme launch itself.
 */

const PANCAKE_FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];

function startPancakeGraduationListener({ onPairCreated }) {
  const provider = new ethers.WebSocketProvider(config.rpc.wss);
  const factory = new ethers.Contract(
    config.contracts.pancakeFactory,
    PANCAKE_FACTORY_ABI,
    provider
  );

  logger.info('PancakeSwap graduation listener starting', {
    factory: config.contracts.pancakeFactory,
  });

  const handler = (token0, token1, pair, _, event) => {
    // One side of the pair is usually WBNB — the other is the actual token.
    const wbnb = config.contracts.wbnb.toLowerCase();
    const tokenAddress =
      token0.toLowerCase() === wbnb ? token1 : token1.toLowerCase() === wbnb ? token0 : null;

    if (!tokenAddress) {
      // Neither side is WBNB — not a pair we care about for BNB-denominated sniping.
      return;
    }

    logger.info('PancakeSwap: new pair detected', { tokenAddress, pair });
    onPairCreated({
      source: 'pancake_graduation',
      address: tokenAddress,
      pairAddress: pair,
      discoveredAt: Date.now(),
      txHash: event?.log?.transactionHash,
    });
  };

  factory.on('PairCreated', handler);

  return {
    stop: () => {
      factory.off('PairCreated', handler);
      provider.destroy();
    },
  };
}

module.exports = { startPancakeGraduationListener };
