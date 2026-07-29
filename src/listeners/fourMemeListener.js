const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Listens for new token creation events on four.meme's TokenManager2 contract.
 *
 * CONFIRMED via multiple independent sources (Bitquery's BSC indexer docs,
 * the official four.meme GitBook protocol integration page, and community
 * tooling like bsc-mcp / four-meme-community's four-meme-ai):
 *   - Contract: TokenManager2, address 0x5c952063c7fc8610FFDB798152D69F0B9550762b
 *   - Event name: "TokenCreate"
 *   - TokenManager2 is the correct contract for tokens created after
 *     Sept 5 2024 — the older "TokenManager" (V1) can't create new tokens.
 *
 * NOT CONFIRMED: the exact parameter order/types/indexed-ness of TokenCreate.
 * The contract is UNVERIFIED on BscScan, so there's no public ABI to read
 * directly. The event signature below is a best-effort reconstruction from
 * indexer documentation (Bitquery lists creator, token, name, symbol,
 * totalSupply, requestId, launchTime, launchFee as the fields it decodes).
 *
 * BEFORE RELYING ON THIS: grab the authoritative ABI from four.meme's own
 * downloads at https://four-meme.gitbook.io/four.meme/brand/protocol-integration
 * (TokenManager2.lite.abi) and diff it against the event below — or decode
 * one real TokenCreate transaction on BscScan and confirm field order there.
 */

const FOUR_MEME_TOKEN_MANAGER_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const FOUR_MEME_FACTORY_ABI = [
  // Best-effort reconstruction — see disclaimer above. Verify before live use.
  'event TokenCreate(address indexed creator, address indexed token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
];

function startFourMemeListener({ onTokenCreated }) {
  const factoryAddress = config.contracts.fourMemeFactory || FOUR_MEME_TOKEN_MANAGER_ADDRESS;

  const provider = new ethers.WebSocketProvider(config.rpc.wss);
  const factory = new ethers.Contract(factoryAddress, FOUR_MEME_FACTORY_ABI, provider);

  logger.info('four.meme listener starting', { factory: factoryAddress });

  const handler = (creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee, event) => {
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

  factory.on('TokenCreate', handler);

  // If the ABI's field order/types are wrong, ethers will simply never match
  // the event (wrong topic0 hash) rather than throwing — so also log raw,
  // undecoded logs from this contract as a diagnostic breadcrumb. If you see
  // activity here but never see "four.meme: new token detected" above, that's
  // the signature mismatch making itself known.
  provider.on({ address: factoryAddress }, (log) => {
    logger.debug('Raw log from four.meme contract (undecoded)', {
      topics: log.topics,
      txHash: log.transactionHash,
    });
  });

  return {
    stop: () => {
      factory.off('TokenCreate', handler);
      provider.removeAllListeners();
      provider.destroy();
    },
  };
}

module.exports = { startFourMemeListener, FOUR_MEME_TOKEN_MANAGER_ADDRESS };
