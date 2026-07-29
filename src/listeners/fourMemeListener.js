const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');
const { createResilientWsProvider } = require('../utils/resilientWsProvider');

/**
 * Listens for new token creation events on four.meme's TokenManager2 contract.
 *
 * CONFIRMED — contract, event name, AND exact field order/types:
 *   - Contract: TokenManager2, address 0x5c952063c7fc8610FFDB798152D69F0B9550762b
 *   - Event: TokenCreate(address creator, address token, uint256 requestId,
 *            string name, string symbol, uint256 totalSupply,
 *            uint256 launchTime, uint256 launchFee)
 *   - NONE of the fields are indexed.
 *
 * Source: four-meme-community/four-meme-ai (open-source CLI + agent skill
 * actively used against this exact contract), references/event-listening.md,
 * which gives this exact signature via a working viem example:
 * https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/event-listening.md
 * Cross-checked against Bitquery's indexer docs, which independently list
 * the same field names for their TokenCreate decoding.
 *
 * The same contract also emits TokenPurchase, TokenSale, and LiquidityAdded
 * — not wired up here, but documented in the same reference above if useful
 * later (e.g. LiquidityAdded as an alternative graduation signal alongside
 * the PancakeSwap PairCreated listener this project already uses).
 */

const FOUR_MEME_TOKEN_MANAGER_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const FOUR_MEME_FACTORY_ABI = [
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
];

function startFourMemeListener({ onTokenCreated }) {
  const factoryAddress = config.contracts.fourMemeFactory || FOUR_MEME_TOKEN_MANAGER_ADDRESS;

  const handler = (creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee, event) => {
    logger.info('four.meme: new token detected', { token, name, symbol });
    onTokenCreated({
      source: 'four_meme',
      address: token,
      creator,
      requestId: requestId?.toString(),
      name,
      symbol,
      discoveredAt: Date.now(),
      txHash: event?.log?.transactionHash,
    });
  };

  const resilientProvider = createResilientWsProvider(config.rpc.wss, (provider) => {
    const factory = new ethers.Contract(factoryAddress, FOUR_MEME_FACTORY_ABI, provider);
    factory.on('TokenCreate', handler);
    logger.info('four.meme listener (re)attached', { factory: factoryAddress });
    return () => factory.off('TokenCreate', handler);
  });

  return {
    stop: () => resilientProvider.stop(),
  };
}

module.exports = { startFourMemeListener, FOUR_MEME_TOKEN_MANAGER_ADDRESS };
